/**
 * The Zonotope domain: a value is an affine form `x_i = c0 + Σ ck·εk` over
 * noise symbols `εk ∈ [-1, 1]` *shared across every variable in the
 * environment* — sharing is what makes it relational (two variables built
 * from the same εk are correlated), and it is a genuinely different
 * representation from the DBM-based Zones/Octagons: not a matrix of
 * pairwise bounds, but a set of generators every variable can reference.
 *
 * A variable that has no useful affine structure yet (top, or anything that
 * fell back to a plain bound) is represented as a bare interval instead of
 * an affine form with meaningless coefficients — the same exact-vs-fallback
 * split every other domain in this codebase already uses.
 *
 * Two design choices are load-bearing enough to call out up front:
 *
 * 1. **No fresh symbol is ever minted just to read an interval-kind
 *    operand.** `assign` folds such an operand's own concrete range
 *    directly into the result's `slop` (an extra, non-symbolic ± term —
 *    see `AffineForm`), rather than promoting it to a one-off generator.
 *    The only two places that ever allocate a new symbol are `join`
 *    (capped by `MAX_SYMBOLS`, the "order reduction" the design calls for)
 *    and nonlinear multiplication's quadratic-remainder term (folded into
 *    `slop`, not a new symbol either, for the same reason). This is what
 *    keeps the analysis deterministic and terminating: symbol allocation is
 *    a pure function of the state being transformed, never a global
 *    mutable counter, so replaying the same transfer sequence against the
 *    same (eventually-stable) incoming state always reproduces the same
 *    result bit-for-bit — which is exactly what the engine's fixpoint
 *    check (`leq`, below) needs to actually detect stabilization.
 *
 * 2. **`leq` is structural equality between two 'affine' states, not true
 *    zonotope inclusion.** Exact containment between two zonotopes is a
 *    linear-programming feasibility question in general (a slanted
 *    parallelogram is a *proper* subset of its own bounding box, so
 *    box-containment is not a sound stand-in). The engine only ever uses
 *    `leq` for fixpoint-stabilization detection (see `engine.ts`), for
 *    which requiring exact equality is sound (equal implies ⊑) and,
 *    combined with (1) above, still guarantees termination.
 *
 * A consequence of (2), worth knowing up front: `widen` unconditionally
 * collapses any variable whose *concrete bound* grew to a plain interval,
 * because it has no cheap way to tell "the bound moved but the underlying
 * symbolic structure already stabilized" apart from "this is genuinely
 * still changing" — and guessing wrong in the unsafe direction would break
 * termination. In an unbounded loop a variable's bound almost always grows
 * at least once, so a correlation this domain genuinely discovers at a join
 * (e.g. two counters incrementing in lockstep, sharing a symbol with
 * matching coefficients — see the join test) is typically destroyed the
 * moment widening kicks in, unlike Zones/Octagons' matrix, which widens
 * cell-by-cell and can keep a relation that never itself changed. This is a
 * deliberate tradeoff for guaranteed termination, not a bug — see the
 * "honest limitation" test in `engine.test.ts` for a worked example.
 */

import type { CmpOp, Cond, Expr } from '../ir.js';
import { negate } from '../ir.js';
import { type Domain, flip } from '../domain.js';
import type { DisplayState, LossItem, VarValue } from '@aiviz/trace-protocol';
import { intervalLattice } from './intervals.js';
import { difference } from '../relational/linear.js';
import { asAffineExpr } from '../relational/affine.js';

/** Order-reduction cap: once a join would need to mint a fresh shared
 * symbol beyond this, the imprecision is folded into non-shared `slop`
 * instead, keeping symbol count — and hence state size — bounded. */
const MAX_SYMBOLS = 8;

interface Interval {
  readonly lo: number;
  readonly hi: number;
}

interface AffineForm {
  readonly kind: 'affine';
  readonly center: number;
  /** Coefficients on shared symbols 0..n-1. May be shorter than the state's
   * own `symbolCount` — missing trailing entries are implicitly 0. */
  readonly coeffs: readonly number[];
  /** Extra, non-shared uncertainty not tied to any symbol: `slopLo ≤ 0 ≤
   * slopHi`. Keeps interval-sourced contributions exact integers instead of
   * forcing a center/radius split that would need fractions. */
  readonly slopLo: number;
  readonly slopHi: number;
}

type VarState = { readonly kind: 'interval'; readonly lo: number; readonly hi: number } | AffineForm;

export type ZonoEnv =
  | { readonly kind: 'bottom' }
  | {
      readonly kind: 'zono';
      readonly names: readonly string[];
      readonly symbolCount: number;
      readonly vars: readonly VarState[];
    };

type ZonoState = Extract<ZonoEnv, { kind: 'zono' }>;

const BOTTOM: ZonoEnv = { kind: 'bottom' };
const TOP_VAR: VarState = { kind: 'interval', lo: -Infinity, hi: Infinity };

function padCoeffs(coeffs: readonly number[], n: number): number[] {
  const out = coeffs.slice();
  while (out.length < n) out.push(0);
  return out;
}

function concretize(v: VarState): Interval {
  if (v.kind === 'interval') return { lo: v.lo, hi: v.hi };
  const radius = v.coeffs.reduce((s, c) => s + Math.abs(c), 0);
  return { lo: v.center - radius + v.slopLo, hi: v.center + radius + v.slopHi };
}

/** Collapses an affine form back to a plain interval once it has become
 * unbounded on either side — keeping meaningless-beyond-that-point
 * coefficients around would only complicate `leq`/`join` for no benefit. */
function normalize(v: AffineForm): VarState {
  const iv = concretize(v);
  if (iv.lo === -Infinity || iv.hi === Infinity) return { kind: 'interval', lo: iv.lo, hi: iv.hi };
  return v;
}

function scaleIntervalByCoeff(iv: Interval, coeff: number): Interval {
  return coeff >= 0 ? { lo: coeff * iv.lo, hi: coeff * iv.hi } : { lo: coeff * iv.hi, hi: coeff * iv.lo };
}

function varsEqual(a: VarState, b: VarState): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'interval' && b.kind === 'interval') return a.lo === b.lo && a.hi === b.hi;
  if (a.kind === 'affine' && b.kind === 'affine') {
    const width = Math.max(a.coeffs.length, b.coeffs.length);
    const ac = padCoeffs(a.coeffs, width);
    const bc = padCoeffs(b.coeffs, width);
    return (
      a.center === b.center &&
      a.slopLo === b.slopLo &&
      a.slopHi === b.slopHi &&
      ac.every((c, k) => c === bc[k])
    );
  }
  return false;
}

function leqVar(a: VarState, b: VarState): boolean {
  if (b.kind === 'interval') {
    const A = concretize(a);
    return A.lo >= b.lo && A.hi <= b.hi;
  }
  if (a.kind === 'interval') {
    // A plain box against a possibly-slanted shape: only safe to claim in
    // the degenerate single-point case (see the module doc comment).
    if (a.lo !== a.hi) return false;
    const B = concretize(b);
    return a.lo >= B.lo && a.lo <= B.hi;
  }
  return varsEqual(a, b);
}

function holds(op: CmpOp, x: number): boolean {
  switch (op) {
    case '<':
      return x < 0;
    case '<=':
      return x <= 0;
    case '>':
      return x > 0;
    case '>=':
      return x >= 0;
    case '==':
      return x === 0;
    case '!=':
      return x !== 0;
  }
}

/**
 * Evaluates `constant + Σ coeff·var` against the current state. Never
 * mints a fresh symbol — see the module doc comment for why.
 */
function evalAffineTerms(s: ZonoState, terms: ReadonlyMap<string, number>, constant: number): VarState {
  let center = constant;
  let coeffs: number[] = [];
  let slopLo = 0;
  let slopHi = 0;
  for (const [name, coeff] of terms) {
    const idx = s.names.indexOf(name);
    const v = s.vars[idx]!;
    if (v.kind === 'interval') {
      const scaled = scaleIntervalByCoeff({ lo: v.lo, hi: v.hi }, coeff);
      slopLo += scaled.lo;
      slopHi += scaled.hi;
    } else {
      center += coeff * v.center;
      const width = Math.max(coeffs.length, v.coeffs.length);
      coeffs = padCoeffs(coeffs, width);
      const vc = padCoeffs(v.coeffs, width);
      for (let k = 0; k < width; k++) coeffs[k]! += coeff * vc[k]!;
      const scaledSlop = scaleIntervalByCoeff({ lo: v.slopLo, hi: v.slopHi }, coeff);
      slopLo += scaledSlop.lo;
      slopHi += scaledSlop.hi;
    }
  }
  return normalize({ kind: 'affine', center, coeffs, slopLo, slopHi });
}

function intervalMultiply(a: Interval, b: Interval): VarState {
  const safeMul = (x: number, y: number): number => (x === 0 || y === 0 ? 0 : x * y);
  const corners = [safeMul(a.lo, b.lo), safeMul(a.lo, b.hi), safeMul(a.hi, b.lo), safeMul(a.hi, b.hi)];
  return { kind: 'interval', lo: Math.min(...corners), hi: Math.max(...corners) };
}

/**
 * The standard affine-arithmetic multiplication rule ("linearize and bound
 * the error"): for `x = cx + Ax`, `y = cy + Ay` (`Ax`/`Ay` being each
 * side's total generator + slop contribution), `x*y = cx*cy + cx*Ay +
 * cy*Ax + Ax*Ay`. The first three terms are exact and keep whatever
 * correlation `x`/`y` already had to other variables; the genuine
 * quadratic cross-term `Ax*Ay` is nonlinear and gets soundly bounded by the
 * product of each side's total magnitude, folded into `slop` rather than a
 * new symbol (see the module doc comment on why no fresh symbols here).
 */
function multiplyAffine(x: VarState, y: VarState): VarState {
  const xi = concretize(x);
  const yi = concretize(y);
  if (!Number.isFinite(xi.lo) || !Number.isFinite(xi.hi) || !Number.isFinite(yi.lo) || !Number.isFinite(yi.hi)) {
    return intervalMultiply(xi, yi);
  }
  if (x.kind === 'interval' || y.kind === 'interval') {
    return intervalMultiply(xi, yi);
  }
  const width = Math.max(x.coeffs.length, y.coeffs.length);
  const a = padCoeffs(x.coeffs, width);
  const b = padCoeffs(y.coeffs, width);
  const center = x.center * y.center;
  const coeffs = new Array(width).fill(0) as number[];
  for (let k = 0; k < width; k++) coeffs[k] = x.center * b[k]! + y.center * a[k]!;

  const fromYSlop = scaleIntervalByCoeff({ lo: y.slopLo, hi: y.slopHi }, x.center);
  const fromXSlop = scaleIntervalByCoeff({ lo: x.slopLo, hi: x.slopHi }, y.center);
  const magA = a.reduce((s2, v) => s2 + Math.abs(v), 0) + Math.max(Math.abs(x.slopLo), Math.abs(x.slopHi));
  const magB = b.reduce((s2, v) => s2 + Math.abs(v), 0) + Math.max(Math.abs(y.slopLo), Math.abs(y.slopHi));
  const cross = magA * magB;

  return normalize({
    kind: 'affine',
    center,
    coeffs,
    slopLo: fromYSlop.lo + fromXSlop.lo - cross,
    slopHi: fromYSlop.hi + fromXSlop.hi + cross,
  });
}

function tryMultiply(s: ZonoState, expr: Expr): VarState | undefined {
  if (expr.kind !== 'binary' || expr.op !== '*') return undefined;
  const l = asAffineExpr(expr.left);
  const r = asAffineExpr(expr.right);
  if (!l || !r) return undefined;
  const lv = evalAffineTerms(s, l.terms, l.constant);
  const rv = evalAffineTerms(s, r.terms, r.constant);
  return multiplyAffine(lv, rv);
}

function setVar(s: ZonoState, idx: number, v: VarState): ZonoEnv {
  const vars = s.vars.slice();
  vars[idx] = v;
  return { kind: 'zono', names: s.names, symbolCount: s.symbolCount, vars };
}

/**
 * Joins one variable's value. `a`'s existing coefficients on already-shared
 * symbols are kept unchanged — a center shift doesn't touch coefficients,
 * so it cannot corrupt whatever correlation `a` already has with other
 * variables through those symbols. What's new is added via one symbol
 * shared across every variable in this join call — the "standard zonotope
 * join construction" the plan calls for — capped by `MAX_SYMBOLS`; past the
 * cap, the same coverage is added as non-shared `slop` instead (the "order
 * reduction").
 *
 * The center is recomputed as the tight midpoint of the outer range rather
 * than pinned to `a.center`: pinning it there would force the whole result
 * to stay symmetric around a point that need not be anywhere near the
 * middle of what actually needs covering, which is needlessly loose (e.g.
 * covering `[0,1]` while anchored at `0` forces a radius of `1`, giving
 * `[-1,1]` instead of the achievable `[0,1]`-ish range). `Math.ceil` on an
 * odd-width outer range still costs up to one unit of looseness — the same
 * unavoidable integer-rounding cost Octagons' doubled self-pairs have.
 */
function joinVar(
  av: VarState,
  bv: VarState,
  freshIdx: number,
  useSharedFresh: boolean,
  newSymbolCount: number
): VarState {
  const A = concretize(av);
  const B = concretize(bv);
  const outerLo = Math.min(A.lo, B.lo);
  const outerHi = Math.max(A.hi, B.hi);
  if (!Number.isFinite(outerLo) || !Number.isFinite(outerHi)) {
    return { kind: 'interval', lo: outerLo, hi: outerHi };
  }
  if (av.kind === 'interval') {
    return { kind: 'interval', lo: outerLo, hi: outerHi };
  }
  const rA = av.coeffs.reduce((s2, v) => s2 + Math.abs(v), 0);
  const radius = Math.ceil((outerHi - outerLo) / 2);
  const center = outerLo + radius;
  const extra = Math.max(0, radius - rA);
  if (useSharedFresh) {
    const withFresh = padCoeffs(av.coeffs, newSymbolCount);
    withFresh[freshIdx] = extra;
    return { kind: 'affine', center, coeffs: withFresh, slopLo: 0, slopHi: 0 };
  }
  return { kind: 'affine', center, coeffs: av.coeffs, slopLo: -extra, slopHi: extra };
}

function joinState(a: ZonoState, b: ZonoState): ZonoState {
  const width = Math.max(a.symbolCount, b.symbolCount);
  const useSharedFresh = width < MAX_SYMBOLS;
  const freshIdx = width;
  const newSymbolCount = useSharedFresh ? width + 1 : width;
  const vars = a.names.map((_, i) =>
    joinVar(a.vars[i]!, b.vars[i]!, freshIdx, useSharedFresh, newSymbolCount)
  );
  return { kind: 'zono', names: a.names, symbolCount: newSymbolCount, vars };
}

function fmtBound(x: number): string {
  if (x === -Infinity) return '-∞';
  if (x === Infinity) return '+∞';
  return String(x);
}

function formatAffine(v: AffineForm): string {
  const parts: string[] = [];
  if (v.center !== 0) parts.push(String(v.center));
  v.coeffs.forEach((c, k) => {
    if (c === 0) return;
    const sign = c > 0 ? '+' : '-';
    const mag = Math.abs(c);
    parts.push(`${sign} ${mag === 1 ? '' : `${mag}·`}ε${k}`);
  });
  if (v.slopLo !== 0 || v.slopHi !== 0) {
    parts.push(`+ [${v.slopLo}, ${v.slopHi}]`);
  }
  if (parts.length === 0) return String(v.center);
  return parts.join(' ').replace(/^\+ /, '');
}

class ZonotopesDomain implements Domain<ZonoEnv> {
  readonly id = 'zonotopes';
  readonly name = 'Zonotopes';
  readonly finiteLattice = false;

  bottom(): ZonoEnv {
    return BOTTOM;
  }

  top(vars: readonly string[]): ZonoEnv {
    return { kind: 'zono', names: [...vars], symbolCount: 0, vars: vars.map(() => TOP_VAR) };
  }

  isBottom(s: ZonoEnv): boolean {
    return s.kind === 'bottom';
  }

  leq(a: ZonoEnv, b: ZonoEnv): boolean {
    if (a.kind === 'bottom') return true;
    if (b.kind === 'bottom') return false;
    return a.names.every((_, i) => leqVar(a.vars[i]!, b.vars[i]!));
  }

  join(a: ZonoEnv, b: ZonoEnv): ZonoEnv {
    if (a.kind === 'bottom') return b;
    if (b.kind === 'bottom') return a;
    return joinState(a, b);
  }

  meet(a: ZonoEnv, b: ZonoEnv): ZonoEnv {
    if (a.kind === 'bottom' || b.kind === 'bottom') return BOTTOM;
    const vars: VarState[] = [];
    for (let i = 0; i < a.names.length; i++) {
      const A = concretize(a.vars[i]!);
      const B = concretize(b.vars[i]!);
      const lo = Math.max(A.lo, B.lo);
      const hi = Math.min(A.hi, B.hi);
      if (lo > hi) return BOTTOM;
      vars.push({ kind: 'interval', lo, hi });
    }
    return { kind: 'zono', names: a.names, symbolCount: 0, vars };
  }

  widen(a: ZonoEnv, b: ZonoEnv): ZonoEnv {
    if (a.kind === 'bottom') return b;
    if (b.kind === 'bottom') return a;
    const vars = a.names.map((_, i) => {
      const av = a.vars[i]!;
      const A = concretize(av);
      const B = concretize(b.vars[i]!);
      if (B.lo < A.lo || B.hi > A.hi) {
        return { kind: 'interval' as const, lo: B.lo < A.lo ? -Infinity : A.lo, hi: B.hi > A.hi ? Infinity : A.hi };
      }
      return av; // unchanged — reused verbatim so the fixpoint check can see it hasn't moved
    });
    return { kind: 'zono', names: a.names, symbolCount: a.symbolCount, vars };
  }

  narrow(a: ZonoEnv, b: ZonoEnv): ZonoEnv {
    if (a.kind === 'bottom' || b.kind === 'bottom') return BOTTOM;
    const vars = a.names.map((_, i) => {
      const av = a.vars[i]!;
      const A = concretize(av);
      if (A.lo === -Infinity || A.hi === Infinity) {
        const B = concretize(b.vars[i]!);
        return { kind: 'interval' as const, lo: A.lo === -Infinity ? B.lo : A.lo, hi: A.hi === Infinity ? B.hi : A.hi };
      }
      return av;
    });
    return { kind: 'zono', names: a.names, symbolCount: a.symbolCount, vars };
  }

  assign(s: ZonoEnv, target: string, expr: Expr): ZonoEnv {
    if (s.kind === 'bottom') return s;
    const idx = s.names.indexOf(target);
    const t = asAffineExpr(expr);
    if (t) return setVar(s, idx, evalAffineTerms(s, t.terms, t.constant));
    const mult = tryMultiply(s, expr);
    if (mult) return setVar(s, idx, mult);
    return setVar(s, idx, TOP_VAR); // nondet, /, %: sound, honest fallback
  }

  assume(s: ZonoEnv, cond: Cond): ZonoEnv {
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
        const diff = difference(cond.left, cond.right);
        if (!diff) return s;

        if (diff.terms.length === 0) {
          return holds(cond.op, diff.constant) ? s : BOTTOM;
        }

        if (diff.terms.length === 1) {
          const [name, coeff] = diff.terms[0]!;
          const idx = s.names.indexOf(name);
          const cur = concretize(s.vars[idx]!);
          const op = coeff === 1 ? cond.op : flip(cond.op);
          const bound = coeff === 1 ? -diff.constant : diff.constant;
          const refined = intervalLattice.refine(op, { lo: cur.lo, hi: cur.hi }, { lo: bound, hi: bound });
          if (intervalLattice.isBottom(refined)) return BOTTOM;
          return setVar(s, idx, { kind: 'interval', lo: refined.lo, hi: refined.hi });
        }

        // Two variables: zonotopes have no natural precise half-space
        // intersection (see module doc comment) — concretizing to the
        // interval hull and intersecting only refines a single dimension
        // at a time, so a genuinely two-variable guard is a sound no-op,
        // the same fallback Zones/Octagons use for a shape they can't
        // represent exactly.
        return s;
      }
    }
  }

  format(s: ZonoEnv): DisplayState {
    if (s.kind === 'bottom') return { kind: 'bottom', vars: [] };
    const vars: VarValue[] = s.names.map((name, i) => {
      const iv = concretize(s.vars[i]!);
      const f = intervalLattice.format({ lo: iv.lo, hi: iv.hi });
      return { name, repr: f.repr, kind: f.kind };
    });
    const constraints: string[] = [];
    s.names.forEach((name, i) => {
      const v = s.vars[i]!;
      if (v.kind === 'affine' && v.coeffs.some((c) => c !== 0)) {
        constraints.push(`${name} = ${formatAffine(v)}`);
      }
    });
    return constraints.length > 0 ? { kind: 'state', vars, constraints } : { kind: 'state', vars };
  }

  changed(a: ZonoEnv, b: ZonoEnv): string[] {
    if (a.kind === 'zono' && b.kind === 'zono') {
      const out: string[] = [];
      for (let i = 0; i < a.names.length; i++) {
        if (!varsEqual(a.vars[i]!, b.vars[i]!)) out.push(a.names[i]!);
      }
      return out;
    }
    if (a.kind === 'zono') return [...a.names];
    if (b.kind === 'zono') return [...b.names];
    return [];
  }

  lossReport(old: ZonoEnv, joined: ZonoEnv, widened: ZonoEnv): LossItem[] {
    if (joined.kind === 'bottom' || widened.kind === 'bottom') return [];
    const out: LossItem[] = [];
    joined.names.forEach((name, i) => {
      const j = concretize(joined.vars[i]!);
      const w = concretize(widened.vars[i]!);
      const lostLower = j.lo > w.lo;
      const lostUpper = j.hi < w.hi;
      if (!lostLower && !lostUpper) return;
      const o = old.kind === 'bottom' ? { lo: Infinity, hi: -Infinity } : concretize(old.vars[i]!);
      const bound: LossItem['lostBound'] = lostLower && lostUpper ? 'both' : lostLower ? 'lower' : 'upper';
      const parts: string[] = [];
      if (lostUpper) {
        parts.push(
          `The upper bound on ${name} grew from ${fmtBound(o.hi)} to ${fmtBound(j.hi)}, ` +
            `so widening discarded it entirely, giving ${fmtBound(w.hi)}.`
        );
      }
      if (lostLower) {
        parts.push(
          `The lower bound on ${name} fell from ${fmtBound(o.lo)} to ${fmtBound(j.lo)}, ` +
            `so widening discarded it entirely, giving ${fmtBound(w.lo)}.`
        );
      }
      out.push({
        name,
        before: intervalLattice.format({ lo: o.lo, hi: o.hi }).repr,
        joined: intervalLattice.format({ lo: j.lo, hi: j.hi }).repr,
        widened: intervalLattice.format({ lo: w.lo, hi: w.hi }).repr,
        lostBound: bound,
        message: parts.join(' '),
      });
    });
    return out;
  }

  valueOf(s: ZonoEnv, variable: string): string | undefined {
    if (s.kind === 'bottom') return undefined;
    const idx = s.names.indexOf(variable);
    if (idx === -1) return undefined;
    const iv = concretize(s.vars[idx]!);
    return intervalLattice.format({ lo: iv.lo, hi: iv.hi }).repr;
  }
}

export const zonotopesDomain = new ZonotopesDomain();
