/**
 * The Polyhedra domain: arbitrary linear inequality systems (H-representation
 * — a set of constraints `a·x ≤ c`), the most expressive and most expensive
 * domain here. Hand-rolled, scoped to small variable counts (per the phase
 * plan): every core operation is built on Fourier–Motzkin elimination, which
 * has cost exponential in the number of eliminated variables in the worst
 * case — entirely fine for this project's teaching-scope programs, not
 * intended to compete with a production LP-based library.
 *
 * Fourier–Motzkin elimination is more than a feasibility check: it is a
 * complete quantifier-elimination procedure for linear arithmetic over the
 * reals. That fact is what this whole domain is built on — three
 * operations that look like they'd each need their own algorithm (checking
 * satisfiability, checking one polyhedron implies a constraint, computing
 * the exact maximum of a linear objective) all reduce to "eliminate down to
 * the variables you still care about, then read off what's left":
 *
 *  - **`isFeasible`**: eliminate every variable; the system is feasible iff
 *    every remaining constant-only constraint `0 ≤ r` has `r ≥ 0`.
 *  - **`maxOf`**: introduce one auxiliary variable `z` pinned to the
 *    objective (`z = obj·x`, expressed as two ≤ constraints), eliminate
 *    every *original* variable, and read the tightest surviving upper
 *    bound on `z` — exactly the LP optimum, no simplex needed.
 *  - **`entails` / `leq`**: `a ⟹ (c·x ≤ r)` iff `maxOf(a, c) ≤ r`. This
 *    gives an exact (sound and complete) `leq`, unlike Zonotopes', where
 *    true containment is an open LP problem for that representation.
 *
 * Represented over the rationals via exact fractions, never floating
 * point — Fourier–Motzkin's repeated cross-multiplication would otherwise
 * accumulate rounding error into an actually-wrong feasibility verdict,
 * which is a soundness bug, not just an imprecision one.
 *
 * `join` (convex hull) uses the standard "extended formulation" for the
 * convex hull of a union of two polytopes (sometimes attributed to Balas):
 * introduce `λ ∈ [0,1]` and copies `y1 = λ·(point in a)`, `y2 =
 * (1-λ)·(point in b)`, require `x = y1 + y2`, then project `y1, y2, λ` away
 * via the same elimination. No vertex enumeration is needed.
 *
 * `widen` is "constraint-preserving": keep exactly the constraints from the
 * old state that the new state still entails, dropping the rest. Constraint
 * *count* can only shrink across repeated widen calls at the same loop
 * header (never grows — this operation only ever filters), which is what
 * guarantees termination: a monotonically non-increasing natural number
 * bottoms out in finitely many steps.
 */

import type { CmpOp, Cond, Expr } from '../ir.js';
import { negate } from '../ir.js';
import type { Domain } from '../domain.js';
import type { DisplayState, LossItem, VarValue } from '@aiviz/trace-protocol';
import { intervalLattice } from './intervals.js';
import { asAffineExpr } from '../relational/affine.js';

// --- exact rational arithmetic -----------------------------------------

interface Frac {
  readonly n: number;
  readonly d: number; // > 0, gcd(|n|, d) === 1
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a || 1;
}

function frac(n: number, d = 1): Frac {
  if (d < 0) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d) || 1;
  return { n: n / g, d: d / g };
}

const F0 = frac(0);
const F1 = frac(1);

const fadd = (a: Frac, b: Frac): Frac => frac(a.n * b.d + b.n * a.d, a.d * b.d);
const fsub = (a: Frac, b: Frac): Frac => frac(a.n * b.d - b.n * a.d, a.d * b.d);
const fmul = (a: Frac, b: Frac): Frac => frac(a.n * b.n, a.d * b.d);
const fdiv = (a: Frac, b: Frac): Frac => frac(a.n * b.d, a.d * b.n);
const fneg = (a: Frac): Frac => ({ n: -a.n, d: a.d });
const fcmp = (a: Frac, b: Frac): number => {
  const l = a.n * b.d - b.n * a.d;
  return l < 0 ? -1 : l > 0 ? 1 : 0;
};
const fisZero = (a: Frac): boolean => a.n === 0;
const fToNumber = (a: Frac): number => a.n / a.d;

// --- constraint representation ------------------------------------------

interface Constraint {
  /** `Σ coeffs[i]*x_i ≤ rhs`. Length always equals the state's variable count. */
  readonly coeffs: readonly Frac[];
  readonly rhs: Frac;
}

export type PolyEnv =
  | { readonly kind: 'bottom' }
  | { readonly kind: 'poly'; readonly names: readonly string[]; readonly constraints: readonly Constraint[] };

type PolyState = Extract<PolyEnv, { kind: 'poly' }>;

const BOTTOM: PolyEnv = { kind: 'bottom' };

// --- Fourier–Motzkin elimination: the one real algorithm here -----------

/** Eliminates variable `k` from a constraint system, returning an
 * equisatisfiable system with one fewer meaningful column. */
function eliminate(cs: readonly Constraint[], k: number): Constraint[] {
  const upper: Constraint[] = [];
  const lower: Constraint[] = [];
  const zero: Constraint[] = [];
  for (const c of cs) {
    const ck = c.coeffs[k]!;
    if (fisZero(ck)) zero.push(c);
    else if (ck.n > 0) upper.push(c);
    else lower.push(c);
  }
  const combined: Constraint[] = [];
  for (const u of upper) {
    for (const l of lower) {
      const a = u.coeffs[k]!; // > 0
      const negB = fneg(l.coeffs[k]!); // > 0, since l's coeff at k is < 0
      const coeffs = u.coeffs.map((uc, i) => fadd(fmul(negB, uc), fmul(a, l.coeffs[i]!)));
      const rhs = fadd(fmul(negB, u.rhs), fmul(a, l.rhs));
      combined.push({ coeffs, rhs });
    }
  }
  return [...zero, ...combined];
}

/**
 * Reduces a constraint's coefficient vector to lowest terms by a positive
 * scale (never flipping direction — see `normalizeConstraint`'s doc
 * comment for why that matters), applying the same scale to `rhs`. Two
 * constraints in the same *direction* (proportional coefficient vectors)
 * become directly comparable by `rhs` afterward.
 */
function directionKey(c: Constraint): { key: string; scaled: Constraint } {
  const denomLcm = c.coeffs.reduce((l, f) => Math.abs((l * f.d) / (gcd(l, f.d) || 1)), 1);
  const ints = c.coeffs.map((f) => f.n * (denomLcm / f.d));
  const g = ints.reduce((g2, x) => gcd(g2, x), 0) || 1;
  const scale = frac(denomLcm, g);
  const coeffs = ints.map((x) => frac(x / g));
  return { key: coeffs.map((f) => `${f.n}/${f.d}`).join(','), scaled: { coeffs, rhs: fmul(c.rhs, scale) } };
}

/**
 * Fourier–Motzkin's pairwise combination step is the well-known source of
 * its worst-case blowup: eliminating one variable can produce
 * `|upper|*|lower|` new rows, and left unchecked across several variables
 * this compounds combinatorially (observed directly: an unpruned 3-variable
 * elimination here ran out of memory). The standard, textbook fix is to
 * prune between every single-variable elimination, not just at the end.
 * Full entailment-based pruning (`simplify`) is itself FME-based and too
 * expensive to run at this frequency, so this does the cheap part only:
 * among constraints that point in the *same direction* (proportional
 * coefficients), keep just the tightest — no elimination needed, and this
 * alone is what actually keeps row counts bounded in practice, since a
 * large fraction of what pairwise combination produces are exactly these
 * near-duplicate parallel rows.
 */
function cheapPrune(cs: readonly Constraint[]): Constraint[] {
  const best = new Map<string, Constraint>();
  for (const c of cs) {
    const { key, scaled } = directionKey(c);
    const existing = best.get(key);
    if (!existing || fcmp(scaled.rhs, existing.rhs) < 0) best.set(key, scaled);
  }
  return [...best.values()];
}

function eliminateAll(cs: readonly Constraint[], vars: readonly number[]): Constraint[] {
  let cur = cheapPrune(cs);
  for (const k of vars) cur = cheapPrune(eliminate(cur, k));
  return cur;
}

function isFeasible(cs: readonly Constraint[], nVars: number): boolean {
  const eliminated = eliminateAll(cs, Array.from({ length: nVars }, (_, i) => i));
  return eliminated.every((c) => fcmp(c.rhs, F0) >= 0);
}

/**
 * The exact maximum of `Σ objective[i]*x_i` over the feasible region of
 * `cs`, or `undefined` if unbounded above. Works by pinning an auxiliary
 * variable `z` to the objective's value (via two ≤ constraints encoding
 * `z = objective·x`) and eliminating every original variable — the
 * tightest surviving upper bound on `z` is the LP optimum, since
 * elimination is exact quantifier elimination, not an approximation.
 */
function maxOf(cs: readonly Constraint[], nVars: number, objective: readonly Frac[]): Frac | undefined {
  const withZ: Constraint[] = cs.map((c) => ({ coeffs: [...c.coeffs, F0], rhs: c.rhs }));
  const objRow = [...objective, fneg(F1)]; // objective·x - z ≤ 0
  const negObjRow = objRow.map(fneg); // z - objective·x ≤ 0
  withZ.push({ coeffs: objRow, rhs: F0 }, { coeffs: negObjRow, rhs: F0 });
  const eliminated = eliminateAll(withZ, Array.from({ length: nVars }, (_, i) => i));
  let best: Frac | undefined;
  for (const c of eliminated) {
    const zc = c.coeffs[nVars]!;
    if (zc.n <= 0) continue; // a lower bound on z, or z already eliminated (0 coeff) — not an upper bound
    const bound = fdiv(c.rhs, zc);
    if (best === undefined || fcmp(bound, best) < 0) best = bound;
  }
  return best;
}

/** Does `cs` entail `c` (every point of `cs` satisfies `c`)? Exact, via
 * `maxOf` — see the module doc comment. */
function entails(cs: readonly Constraint[], nVars: number, c: Constraint): boolean {
  const m = maxOf(cs, nVars, c.coeffs);
  if (m === undefined) return false;
  return fcmp(m, c.rhs) <= 0;
}

/**
 * Scales a constraint to a canonical integer form for set-membership
 * comparisons (dedup, `changed`, entailment-matching in `lossReport`) —
 * clearing denominators and dividing by the gcd of the resulting integers.
 * Critically, `gcd` always returns a *positive* value, so this only ever
 * scales by a positive factor. There is deliberately no "make the leading
 * coefficient positive" step some canonicalizations use: multiplying an
 * inequality by a negative number reverses it, so doing that here would
 * silently turn `-x ≤ 0` (i.e. `x ≥ 0`) into `x ≤ 0` — a different,
 * wrong constraint, not just a differently-scaled one.
 */
function normalizeConstraint(c: Constraint): Constraint {
  const all = [...c.coeffs, c.rhs];
  const denomLcm = all.reduce((l, f) => Math.abs((l * f.d) / (gcd(l, f.d) || 1)), 1);
  const ints = all.map((f) => f.n * (denomLcm / f.d));
  const g = ints.reduce((g2, x) => gcd(g2, x), 0) || 1;
  const scaled = ints.map((x) => x / g);
  return {
    coeffs: scaled.slice(0, c.coeffs.length).map((x) => frac(x)),
    rhs: frac(scaled[scaled.length - 1]!),
  };
}

function constraintKey(c: Constraint): string {
  return `${c.coeffs.map((f) => `${f.n}/${f.d}`).join(',')}|${c.rhs.n}/${c.rhs.d}`;
}

function dedupe(cs: readonly Constraint[]): Constraint[] {
  const seen = new Map<string, Constraint>();
  for (const c of cs) {
    const norm = normalizeConstraint(c);
    seen.set(constraintKey(norm), norm);
  }
  return [...seen.values()];
}

/**
 * Drops every constraint that the *others* already entail. Without this,
 * constraint sets only ever grow (assign/assume/join/meet all add
 * constraints, and plain `dedupe` only removes literal duplicates), and
 * repeated operations across loop iterations blow this up catastrophically
 * — Fourier–Motzkin elimination's cost compounds badly on a constraint set
 * that never shrinks. This is what keeps state size actually bounded in
 * practice (in addition to `widen`'s termination guarantee, which bounds
 * the count across widen calls specifically, but not within the several
 * join/assign calls that happen *before* widening kicks in at a loop
 * header).
 */
function simplify(cs: readonly Constraint[], nVars: number): Constraint[] {
  const deduped = dedupe(cs);
  const kept: Constraint[] = [];
  for (let i = 0; i < deduped.length; i++) {
    const rest = [...kept, ...deduped.slice(i + 1)];
    if (!entails(rest, nVars, deduped[i]!)) kept.push(deduped[i]!);
  }
  return kept;
}

// --- Expr / Cond -> constraints ------------------------------------------

/** Turns an `Expr` into a `{coeffs, constant}` row over the state's own
 * variable ordering, or `undefined` if it isn't affine. */
function toRow(names: readonly string[], e: Expr): { coeffs: Frac[]; constant: Frac } | undefined {
  const t = asAffineExpr(e);
  if (!t) return undefined;
  const coeffs = names.map(() => F0);
  for (const [name, c] of t.terms) {
    const idx = names.indexOf(name);
    coeffs[idx] = frac(c);
  }
  return { coeffs, constant: frac(t.constant) };
}

class PolyhedraDomain implements Domain<PolyEnv> {
  readonly id = 'polyhedra';
  readonly name = 'Polyhedra';
  readonly finiteLattice = false;
  /** Enforced by the provider before analysis even starts (see PROTOCOL.md) —
   * Fourier–Motzkin's worst-case cost is exponential in variable count. */
  readonly maxVariables = 6;

  bottom(): PolyEnv {
    return BOTTOM;
  }

  top(vars: readonly string[]): PolyEnv {
    return { kind: 'poly', names: [...vars], constraints: [] };
  }

  isBottom(s: PolyEnv): boolean {
    return s.kind === 'bottom';
  }

  leq(a: PolyEnv, b: PolyEnv): boolean {
    if (a.kind === 'bottom') return true;
    if (b.kind === 'bottom') return false;
    const n = a.names.length;
    return b.constraints.every((c) => entails(a.constraints, n, c));
  }

  join(a: PolyEnv, b: PolyEnv): PolyEnv {
    if (a.kind === 'bottom') return b;
    if (b.kind === 'bottom') return a;
    return joinState(a, b);
  }

  meet(a: PolyEnv, b: PolyEnv): PolyEnv {
    if (a.kind === 'bottom' || b.kind === 'bottom') return BOTTOM;
    const n = a.names.length;
    const constraints = simplify([...a.constraints, ...b.constraints], n);
    return isFeasible(constraints, n) ? { kind: 'poly', names: a.names, constraints } : BOTTOM;
  }

  widen(a: PolyEnv, b: PolyEnv): PolyEnv {
    if (a.kind === 'bottom') return b;
    if (b.kind === 'bottom') return a;
    const n = a.names.length;
    const kept = a.constraints.filter((c) => entails(b.constraints, n, c));
    return { kind: 'poly', names: a.names, constraints: kept };
  }

  narrow(a: PolyEnv, b: PolyEnv): PolyEnv {
    if (a.kind === 'bottom' || b.kind === 'bottom') return BOTTOM;
    const n = a.names.length;
    const extra = b.constraints.filter((c) => !entails(a.constraints, n, c));
    const constraints = simplify([...a.constraints, ...extra], n);
    return isFeasible(constraints, n) ? { kind: 'poly', names: a.names, constraints } : BOTTOM;
  }

  /**
   * A self-referential assignment (`x := x + 1`) can't be expressed by
   * treating `target` as a single variable that appears on both sides of
   * `=` — algebraically that's not "the new value", it's a fixed-point
   * equation, and it can spuriously collapse to a contradiction (e.g.
   * `x := x + 5` would reduce to `0 = -5`). The fix, generalizing the
   * "shift" every other domain in this phase uses: work in one extra
   * dimension holding the *old* value, rename every existing constraint's
   * reference to `target` onto it, define the new `target` from `expr`
   * (which may reference that old-value column for any self-reference),
   * then eliminate the old-value column via Fourier–Motzkin.
   */
  assign(s: PolyEnv, target: string, expr: Expr): PolyEnv {
    if (s.kind === 'bottom') return s;
    const n = s.names.length;
    const targetIdx = s.names.indexOf(target);
    const row = toRow(s.names, expr);
    if (!row) {
      // nondet, or anything nonlinear: sound, honest havoc.
      const forgotten = s.constraints.filter((c) => fisZero(c.coeffs[targetIdx]!));
      return { kind: 'poly', names: s.names, constraints: forgotten };
    }
    const oldIdx = n; // fresh column for target's pre-assignment value
    const renamed: Constraint[] = s.constraints.map((c) => {
      const coeffs = [...c.coeffs, F0];
      coeffs[oldIdx] = coeffs[targetIdx]!;
      coeffs[targetIdx] = F0;
      return { coeffs, rhs: c.rhs };
    });
    // `expr`'s own reference to `target` (if any) now means the old value.
    const newRowCoeffs = row.coeffs.map((c, i) => (i === targetIdx ? F0 : c));
    newRowCoeffs.push(row.coeffs[targetIdx]!);
    // target = newRowCoeffs·x' + constant  =>  pinRow·x' = -constant, two ≤ constraints.
    const pinRow = newRowCoeffs.slice();
    pinRow[targetIdx] = fsub(pinRow[targetIdx]!, F1);
    const upper = { coeffs: pinRow, rhs: fneg(row.constant) };
    const lower = { coeffs: pinRow.map(fneg), rhs: row.constant };
    const projected = eliminate([...renamed, upper, lower], oldIdx);
    const constraints = simplify(
      projected.map((c) => ({ coeffs: c.coeffs.slice(0, n), rhs: c.rhs })),
      n
    );
    return isFeasible(constraints, n) ? { kind: 'poly', names: s.names, constraints } : BOTTOM;
  }

  assume(s: PolyEnv, cond: Cond): PolyEnv {
    if (s.kind === 'bottom') return s;
    switch (cond.kind) {
      case 'true':
        return s;
      case 'false':
        return BOTTOM;
      case 'not':
        return this.assume(s, negate(cond.inner));
      case 'and':
        return this.assume(this.assume(s, cond.left), cond.right);
      case 'or':
        return this.join(this.assume(s, cond.left), this.assume(s, cond.right));
      case 'cmp': {
        const l = toRow(s.names, cond.left);
        const r = toRow(s.names, cond.right);
        if (!l || !r) return s; // nonlinear guard: sound no-op
        const n = s.names.length;
        // left - right (op) 0
        const diffCoeffs = l.coeffs.map((c, i) => fsub(c, r.coeffs[i]!));
        const diffConstant = fsub(l.constant, r.constant);
        const rows = cmpToConstraints(cond.op, diffCoeffs, diffConstant);
        if (!rows) return s; // != is not a single convex constraint: sound no-op
        const constraints = simplify([...s.constraints, ...rows], n);
        return isFeasible(constraints, n) ? { kind: 'poly', names: s.names, constraints } : BOTTOM;
      }
    }
  }

  format(s: PolyEnv): DisplayState {
    if (s.kind === 'bottom') return { kind: 'bottom', vars: [] };
    const n = s.names.length;
    const vars: VarValue[] = s.names.map((name, i) => {
      const obj = s.names.map((_, k) => (k === i ? F1 : F0));
      const negObj = obj.map(fneg);
      const hi = maxOf(s.constraints, n, obj);
      const loNeg = maxOf(s.constraints, n, negObj);
      const lo = loNeg === undefined ? undefined : fneg(loNeg);
      const iv = {
        lo: lo === undefined ? -Infinity : fToNumber(lo),
        hi: hi === undefined ? Infinity : fToNumber(hi),
      };
      const f = intervalLattice.format(iv);
      return { name, repr: f.repr, kind: f.kind };
    });
    const constraints = s.constraints
      .filter((c) => c.coeffs.filter((f) => !fisZero(f)).length > 1) // a real relation, not just a single-variable bound already shown above
      .map((c) => formatConstraint(s.names, c));
    return constraints.length > 0 ? { kind: 'state', vars, constraints } : { kind: 'state', vars };
  }

  changed(a: PolyEnv, b: PolyEnv): string[] {
    if (a.kind === 'poly' && b.kind === 'poly') {
      const aKeys = new Set(dedupe(a.constraints).map(constraintKey));
      const bKeys = new Set(dedupe(b.constraints).map(constraintKey));
      const same = aKeys.size === bKeys.size && [...aKeys].every((k) => bKeys.has(k));
      return same ? [] : [...a.names];
    }
    if (a.kind === 'poly') return [...a.names];
    if (b.kind === 'poly') return [...b.names];
    return [];
  }

  lossReport(old: PolyEnv, joined: PolyEnv, widened: PolyEnv): LossItem[] {
    if (joined.kind === 'bottom' || widened.kind === 'bottom') return [];
    const n = joined.names.length;
    const out: LossItem[] = [];
    for (const c of joined.constraints) {
      if (widened.constraints.some((wc) => constraintKey(normalizeConstraint(wc)) === constraintKey(normalizeConstraint(c)))) {
        continue; // survived widening
      }
      const label = formatConstraint(joined.names, c);
      const oldHolds = old.kind === 'poly' && entails(old.constraints, n, c);
      out.push({
        name: label,
        before: oldHolds ? 'held' : 'unknown',
        joined: 'held',
        widened: 'discarded',
        lostBound: 'upper',
        message:
          `The constraint ${label} held after this iteration's join, but widening dropped it because it is ` +
          `not implied by the previous iteration's state — that relation is now unknown.`,
      });
    }
    return out;
  }

  valueOf(s: PolyEnv, variable: string): string | undefined {
    if (s.kind === 'bottom') return undefined;
    const idx = s.names.indexOf(variable);
    if (idx === -1) return undefined;
    const n = s.names.length;
    const obj = s.names.map((_, k) => (k === idx ? F1 : F0));
    const negObj = obj.map(fneg);
    const hi = maxOf(s.constraints, n, obj);
    const loNeg = maxOf(s.constraints, n, negObj);
    const lo = loNeg === undefined ? undefined : fneg(loNeg);
    return intervalLattice.format({
      lo: lo === undefined ? -Infinity : fToNumber(lo),
      hi: hi === undefined ? Infinity : fToNumber(hi),
    }).repr;
  }
}

function cmpToConstraints(op: CmpOp, coeffs: readonly Frac[], constant: Frac): Constraint[] | undefined {
  // diff (op) 0, where diff = coeffs·x + constant.
  switch (op) {
    case '<':
      // coeffs·x + constant < 0 => coeffs·x ≤ -constant - 1 is NOT sound over
      // the rationals (this domain has no integer tightening) — use a
      // non-strict bound with an infinitesimal margin instead: coeffs·x < -constant
      // has no exact rational ≤ form, so this domain (a real relaxation,
      // like real polyhedra libraries) rounds to the closest *representable*
      // sound constraint for our integer-only source language: coeffs·x ≤ -constant - 1.
      return [{ coeffs, rhs: fsub(fneg(constant), F1) }];
    case '<=':
      return [{ coeffs, rhs: fneg(constant) }];
    case '>':
      return [{ coeffs: coeffs.map(fneg), rhs: fsub(constant, F1) }];
    case '>=':
      return [{ coeffs: coeffs.map(fneg), rhs: constant }];
    case '==':
      return [
        { coeffs, rhs: fneg(constant) },
        { coeffs: coeffs.map(fneg), rhs: constant },
      ];
    case '!=':
      return undefined;
    default:
      return undefined;
  }
}

function formatConstraint(names: readonly string[], c: Constraint): string {
  const parts: string[] = [];
  c.coeffs.forEach((coeff, i) => {
    if (fisZero(coeff)) return;
    const sign = coeff.n > 0 ? '+' : '-';
    const mag = fToNumber({ n: Math.abs(coeff.n), d: coeff.d });
    parts.push(`${sign} ${mag === 1 ? '' : `${mag}·`}${names[i]}`);
  });
  const lhs = parts.join(' ').replace(/^\+ /, '') || '0';
  return `${lhs} ≤ ${fToNumber(c.rhs)}`;
}

function joinState(a: PolyState, b: PolyState): PolyEnv {
  const n = a.names.length;
  const totalVars = 3 * n + 1;
  const y1Idx = (i: number) => n + i;
  const y2Idx = (i: number) => 2 * n + i;
  const lamIdx = 3 * n;
  const zeroRow = (): Frac[] => new Array(totalVars).fill(F0) as Frac[];

  const cs: Constraint[] = [];
  for (let i = 0; i < n; i++) {
    const row1 = zeroRow();
    row1[i] = F1;
    row1[y1Idx(i)] = fneg(F1);
    row1[y2Idx(i)] = fneg(F1);
    cs.push({ coeffs: row1, rhs: F0 }); // x - y1 - y2 ≤ 0
    cs.push({ coeffs: row1.map(fneg), rhs: F0 }); // -x + y1 + y2 ≤ 0
  }
  for (const c of a.constraints) {
    const row = zeroRow();
    for (let i = 0; i < n; i++) row[y1Idx(i)] = c.coeffs[i]!;
    row[lamIdx] = fneg(c.rhs);
    cs.push({ coeffs: row, rhs: F0 }); // A·y1 - rhs*lambda ≤ 0
  }
  for (const c of b.constraints) {
    const row = zeroRow();
    for (let i = 0; i < n; i++) row[y2Idx(i)] = c.coeffs[i]!;
    row[lamIdx] = c.rhs;
    cs.push({ coeffs: row, rhs: c.rhs }); // B·y2 + rhs*lambda ≤ rhs
  }
  const lamUpper = zeroRow();
  lamUpper[lamIdx] = F1;
  cs.push({ coeffs: lamUpper, rhs: F1 });
  const lamLower = zeroRow();
  lamLower[lamIdx] = fneg(F1);
  cs.push({ coeffs: lamLower, rhs: F0 });

  const projected = eliminateAll(
    cs,
    Array.from({ length: totalVars - n }, (_, i) => totalVars - 1 - i)
  );
  const finalConstraints = projected.map((c) => ({ coeffs: c.coeffs.slice(0, n), rhs: c.rhs }));
  if (!isFeasible(finalConstraints, n)) return BOTTOM;
  return { kind: 'poly', names: a.names, constraints: simplify(finalConstraints, n) };
}

export const polyhedraDomain = new PolyhedraDomain();
