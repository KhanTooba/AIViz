/**
 * The Octagon domain: constraints of the form `±x ± y ≤ c` — Zones plus
 * sums, via Miné's standard doubled-variable encoding. Each program
 * variable `x_i` gets two matrix dimensions, `2i` (its "positive" potential,
 * `+x_i`) and `2i+1` (its "negative" potential, `−x_i`); a cell `m[a][b]`
 * is then always an ordinary difference bound between two *potentials*,
 * which is what lets a genuine sum like `y + z ≤ c` sit in the same matrix
 * as a difference like `y − z ≤ c`.
 *
 * That doubling has one real consequence Zones never has to deal with:
 * plain Floyd–Warshall closure treats `2i` and `2i+1` as if they were
 * unrelated dimensions, even though they describe the same variable. It
 * misses tightenings that only appear once you recognize the coupling — see
 * `strongClosure` below, the one genuinely new (and correctness-critical)
 * piece this domain needs beyond what `../relational/dbm.ts` already
 * provides. Self-bounds are stored *doubled* (`m[2i][2i+1]` holds `2 × x_i`'s
 * upper bound) so the strengthening step's arithmetic never needs to round —
 * every value it touches is an exact even integer by construction.
 */

import type { CmpOp, Cond, Expr } from '../ir.js';
import { negate } from '../ir.js';
import { type Domain } from '../domain.js';
import type { DisplayState, LossItem, VarValue } from '@aiviz/trace-protocol';
import { intervalLattice } from './intervals.js';
import {
  closure,
  emptyMatrix,
  forgetVar,
  isConsistent,
  joinMatrix,
  leqMatrix,
  meetMatrix,
  narrowMatrix,
  tighten,
  widenMatrix,
  type Matrix,
} from '../relational/dbm.js';
import { asLinearForm, difference } from '../relational/linear.js';

const posIdx = (varIdx: number): number => 2 * varIdx;
const negIdx = (varIdx: number): number => 2 * varIdx + 1;
/** Flips a potential index to its negation partner: `2i ↔ 2i+1`. */
const bar = (k: number): number => (k % 2 === 0 ? k + 1 : k - 1);

/**
 * Restores the one invariant plain Floyd–Warshall closure does not know
 * about: `m[i][j]` and `m[bar(j)][bar(i)]` always describe the *same*
 * underlying fact (`potential_i − potential_j`, since `potential_bar(k) =
 * −potential_k`), so they must always carry the same value. Writing only
 * one side of this pair (which a naive `tighten` call does) leaves the
 * matrix unable to combine two constraints that only agree once you look at
 * them from the mirrored side — e.g. `x − y ≤ 3` and `x + y ≤ 3` together
 * imply `x ≤ 3`, but only once `x + y ≤ 3`'s mirror image (`y + x ≤ 3`,
 * stored at a different cell) is present for Floyd–Warshall to route
 * through as an intermediate step.
 */
function symmetrize(m: Matrix): Matrix {
  const n2 = m.length;
  const out = m.map((row) => [...row]);
  for (let i = 0; i < n2; i++) {
    for (let j = 0; j < n2; j++) {
      out[i]![j] = Math.min(m[i]![j]!, m[bar(j)]![bar(i)]!);
    }
  }
  return out;
}

/**
 * Rounds every self-pair cell down to the nearest even value it can
 * soundly be. Closure can derive a self-bound (`m[2i][2i+1]`, meaning
 * `2·x_i ≤ c`) from a path through two ordinary (non-doubled) cross-variable
 * differences, and their sum need not be even — e.g. `2x ≤ 7` is a sound
 * but non-canonical way of saying the tightest fact an integer `x` actually
 * supports, `2x ≤ 6` (`x ≤ 3`). Skipping this leaves later arithmetic that
 * reads these cells as "2 × an integer" silently wrong by half a unit.
 */
function tightenSelfParity(m: Matrix): Matrix {
  const out = m.map((row) => [...row]);
  const n2 = m.length;
  for (let k = 0; k + 1 < n2; k += 2) {
    const hi = out[k]![k + 1]!;
    if (hi !== Infinity) out[k]![k + 1] = 2 * Math.floor(hi / 2);
    const lo = out[k + 1]![k]!;
    if (lo !== Infinity) out[k + 1]![k] = 2 * Math.floor(lo / 2);
  }
  return out;
}

function strongClosure(m: Matrix): Matrix {
  const step1 = closure(symmetrize(m));
  return closure(tightenSelfParity(step1));
}

// Every DBM-core operation only plain-closes; Octagons additionally needs
// the strengthening pass for the result to be maximally precise (still
// sound without it, just needlessly loose).
const oJoin = (a: Matrix, b: Matrix): Matrix => strongClosure(joinMatrix(a, b));
const oMeet = (a: Matrix, b: Matrix): Matrix => strongClosure(meetMatrix(a, b));
const oWiden = (a: Matrix, b: Matrix): Matrix => strongClosure(widenMatrix(a, b));
const oNarrow = (a: Matrix, b: Matrix): Matrix => strongClosure(narrowMatrix(a, b));

export type OctEnv =
  | { readonly kind: 'bottom' }
  | { readonly kind: 'oct'; readonly names: readonly string[]; readonly m: Matrix };

const BOTTOM: OctEnv = { kind: 'bottom' };

function varIndexOf(names: readonly string[], name: string): number {
  return names.indexOf(name);
}

interface Interval {
  lo: number;
  hi: number;
}

function projectInterval(m: Matrix, varIdx: number): Interval {
  const p = posIdx(varIdx);
  const n = negIdx(varIdx);
  const doubledHi = m[p]![n]!;
  const doubledLo = m[n]![p]!;
  // Closure can derive a self-bound from a path through ordinary
  // cross-variable cells, and their sum need not be even (e.g. `2x ≤ 7`).
  // For an integer x, `2x ≤ 7` really means `x ≤ 3` (floor), and `-2x ≤ 7`
  // (i.e. `x ≥ -3.5`) really means `x ≥ -3` (ceiling on the negated half).
  return {
    hi: doubledHi === Infinity ? Infinity : Math.floor(doubledHi / 2),
    lo: doubledLo === Infinity ? -Infinity : Math.ceil(-doubledLo / 2),
  };
}

function scaleInterval(iv: Interval, coeff: 1 | -1): Interval {
  if (coeff === 1) return iv;
  return {
    lo: iv.hi === Infinity ? -Infinity : -iv.hi,
    hi: iv.lo === -Infinity ? Infinity : -iv.lo,
  };
}

function shiftInterval(iv: Interval, k: number): Interval {
  return {
    lo: iv.lo === -Infinity ? -Infinity : iv.lo + k,
    hi: iv.hi === Infinity ? Infinity : iv.hi + k,
  };
}

/** Forgets everything about one variable — both of its potentials. */
function forgetOctVar(m: Matrix, varIdx: number): Matrix {
  return forgetVar(forgetVar(m, posIdx(varIdx)), negIdx(varIdx));
}

/** Pins a variable to an exact constant `[c, c]`. */
function pinConstant(m: Matrix, varIdx: number, c: number): Matrix {
  const forgotten = forgetOctVar(m, varIdx);
  const p = posIdx(varIdx);
  const n = negIdx(varIdx);
  return tighten(tighten(forgotten, p, n, 2 * c), n, p, -2 * c);
}

/**
 * `target := src + delta` (or `target := -src + delta` when `reflected`),
 * `delta ∈ [lo, hi]`. Handles the cross-relations to every other variable
 * (the same shift-by-range idea Zones uses, applied to both potentials)
 * *and* the self-pair, which needs separate treatment since it is stored
 * doubled — see the module doc comment.
 */
function shiftOct(
  m: Matrix,
  targetVarIdx: number,
  srcVarIdx: number,
  reflected: boolean,
  lo: number,
  hi: number
): Matrix {
  const tP = posIdx(targetVarIdx);
  const tN = negIdx(targetVarIdx);
  const sP = reflected ? negIdx(srcVarIdx) : posIdx(srcVarIdx);
  const sN = reflected ? posIdx(srcVarIdx) : negIdx(srcVarIdx);
  const n2 = m.length;
  const out = m.map((row) => [...row]);

  for (let k = 0; k < n2; k++) {
    if (k === tP || k === tN) continue;
    const fromSrcP = m[sP]![k]!;
    const toSrcP = m[k]![sP]!;
    const fromSrcN = m[sN]![k]!;
    const toSrcN = m[k]![sN]!;
    out[tP]![k] = fromSrcP === Infinity || hi === Infinity ? Infinity : fromSrcP + hi;
    out[k]![tP] = toSrcP === Infinity || lo === -Infinity ? Infinity : toSrcP - lo;
    out[tN]![k] = fromSrcN === Infinity || lo === -Infinity ? Infinity : fromSrcN - lo;
    out[k]![tN] = toSrcN === Infinity || hi === Infinity ? Infinity : toSrcN + hi;
  }

  // Self-pair: 2·target = 2·src + 2·delta, derived from src's own doubled
  // self-bound directly — the cross-relation formulas above don't touch it
  // (k skips tP/tN), so it needs this dedicated step.
  const srcSelfHi = m[sP]![sN]!;
  const srcSelfLo = m[sN]![sP]!;
  out[tP]![tN] = srcSelfHi === Infinity || hi === Infinity ? Infinity : srcSelfHi + 2 * hi;
  out[tN]![tP] = srcSelfLo === Infinity || lo === -Infinity ? Infinity : srcSelfLo - 2 * lo;
  out[tP]![tP] = 0;
  out[tN]![tN] = 0;

  return strongClosure(out);
}

/** Constrains `potentialA − potentialB (op) c`. `undefined` means "not a
 * single convex constraint" (only `!=`). */
function applyPotentialConstraint(
  m: Matrix,
  a: number,
  b: number,
  op: CmpOp,
  c: number
): Matrix | undefined {
  switch (op) {
    case '<':
      return tighten(m, a, b, c - 1);
    case '<=':
      return tighten(m, a, b, c);
    case '>':
      return tighten(m, b, a, -(c + 1));
    case '>=':
      return tighten(m, b, a, -c);
    case '==':
      return tighten(tighten(m, a, b, c), b, a, -c);
    case '!=':
      return undefined;
  }
}

/**
 * Constrains a variable's own *doubled* bound: `2·name (op) doubledC`.
 *
 * Deliberately separate from `applyPotentialConstraint` — that function's
 * strict-inequality adjustment (`±1`) is correct for an ordinary integer
 * difference between two distinct variables, but the self-pair cell here
 * holds `2 × name`, which only ever takes even values, so stepping to the
 * next strict value needs `±2`. Using `±1` here would silently produce an
 * odd (impossible) doubled bound instead of tightening to the correct one.
 */
function applySelfBound(m: Matrix, p: number, q: number, op: CmpOp, doubledC: number): Matrix | undefined {
  switch (op) {
    case '<':
      return tighten(m, p, q, doubledC - 2);
    case '<=':
      return tighten(m, p, q, doubledC);
    case '>':
      return tighten(m, q, p, -(doubledC + 2));
    case '>=':
      return tighten(m, q, p, -doubledC);
    case '==':
      return tighten(tighten(m, p, q, doubledC), q, p, -doubledC);
    case '!=':
      return undefined;
  }
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

/** Formats an ordinary (undoubled) cross-variable difference/sum bound. */
function formatDiff(c: number): string {
  return c === Infinity ? '⊤' : String(c);
}

/** Formats a variable's own doubled self-bound as the real variable-space
 * value it represents — floor for an upper bound, ceiling (on the negated
 * cell) for a lower bound, matching `projectInterval`'s rounding rules. */
function formatSelfHi(doubledC: number): string {
  return doubledC === Infinity ? '⊤' : String(Math.floor(doubledC / 2));
}
function formatSelfLo(doubledC: number): string {
  return doubledC === Infinity ? '⊤' : String(Math.ceil(-doubledC / 2));
}

class OctagonsDomain implements Domain<OctEnv> {
  readonly id = 'octagons';
  readonly name = 'Octagons';
  readonly finiteLattice = false;

  bottom(): OctEnv {
    return BOTTOM;
  }

  top(vars: readonly string[]): OctEnv {
    return { kind: 'oct', names: [...vars], m: emptyMatrix(2 * vars.length) };
  }

  isBottom(s: OctEnv): boolean {
    return s.kind === 'bottom';
  }

  leq(a: OctEnv, b: OctEnv): boolean {
    if (a.kind === 'bottom') return true;
    if (b.kind === 'bottom') return false;
    return leqMatrix(a.m, b.m);
  }

  join(a: OctEnv, b: OctEnv): OctEnv {
    if (a.kind === 'bottom') return b;
    if (b.kind === 'bottom') return a;
    return { kind: 'oct', names: a.names, m: oJoin(a.m, b.m) };
  }

  meet(a: OctEnv, b: OctEnv): OctEnv {
    if (a.kind === 'bottom' || b.kind === 'bottom') return BOTTOM;
    const m = oMeet(a.m, b.m);
    return isConsistent(m) ? { kind: 'oct', names: a.names, m } : BOTTOM;
  }

  widen(a: OctEnv, b: OctEnv): OctEnv {
    if (a.kind === 'bottom') return b;
    if (b.kind === 'bottom') return a;
    return { kind: 'oct', names: a.names, m: oWiden(a.m, b.m) };
  }

  narrow(a: OctEnv, b: OctEnv): OctEnv {
    if (a.kind === 'bottom' || b.kind === 'bottom') return BOTTOM;
    return { kind: 'oct', names: a.names, m: oNarrow(a.m, b.m) };
  }

  assign(s: OctEnv, target: string, expr: Expr): OctEnv {
    if (s.kind === 'bottom') return s;
    const targetIdx = varIndexOf(s.names, target);
    const form = asLinearForm(expr);

    if (!form) {
      return { kind: 'oct', names: s.names, m: forgetOctVar(s.m, targetIdx) };
    }

    if (form.terms.length === 0) {
      return { kind: 'oct', names: s.names, m: pinConstant(s.m, targetIdx, form.constant) };
    }

    if (form.terms.length === 1) {
      const [name, coeff] = form.terms[0]!;
      const nameIdx = varIndexOf(s.names, name);
      // Exact either way — unlike Zones, negation (coeff -1) needs no
      // fallback here: it is exactly what "reflected" means.
      const m = shiftOct(s.m, targetIdx, nameIdx, coeff === -1, form.constant, form.constant);
      return { kind: 'oct', names: s.names, m };
    }

    // form.terms.length === 2: x := c1*t1 + c2*t2 + k. Either term can serve
    // as the "base" to shift from — c1's sign just selects reflected or not
    // — so, unlike Zones, there is no linear 2-term shape that has to fall
    // back to a full havoc; only genuinely nonlinear expressions do. EXCEPT:
    // when the target itself is one of the two terms (the accumulator case,
    // `x := x + y`), that term *must* be the base — basing the shift on the
    // other term instead would silently discard x's relation to y rather
    // than just losing precision on it, since shiftOct's cross-relation
    // loop reads the base's OWN prior relations, not the target's.
    const [t1, c1] = form.terms[0]!;
    const [t2, c2] = form.terms[1]!;
    const i1 = varIndexOf(s.names, t1);
    const i2 = varIndexOf(s.names, t2);
    const [baseIdx, baseCoeff, otherIdx, otherCoeff] =
      i2 === targetIdx && i1 !== targetIdx ? [i2, c2, i1, c1] : [i1, c1, i2, c2];
    const baseIv = scaleInterval(projectInterval(s.m, baseIdx), baseCoeff);
    const delta = shiftInterval(scaleInterval(projectInterval(s.m, otherIdx), otherCoeff), form.constant);
    let m = shiftOct(s.m, targetIdx, baseIdx, baseCoeff === -1, delta.lo, delta.hi);

    // shiftOct above only carries forward relations `base` already had to
    // other dimensions — it cannot manufacture a relation to `other` itself
    // out of nothing, even though one is always exactly derivable:
    // `target - otherCoeff*other = baseCoeff*base_old + constant`. Without
    // this, an accumulator update whose two operands had no prior relation
    // (e.g. `x := x + y` where `x` and `y` were bounded independently) would
    // silently lose the very relation the assignment creates.
    const targetP = posIdx(targetIdx);
    const otherP = otherCoeff === 1 ? posIdx(otherIdx) : negIdx(otherIdx);
    const hi = baseIv.hi === Infinity ? Infinity : baseIv.hi + form.constant;
    const lo = baseIv.lo === -Infinity ? -Infinity : baseIv.lo + form.constant;
    if (hi !== Infinity) m = tighten(m, targetP, otherP, hi);
    if (lo !== -Infinity) m = tighten(m, otherP, targetP, -lo);
    m = strongClosure(m);
    return { kind: 'oct', names: s.names, m };
  }

  assume(s: OctEnv, cond: Cond): OctEnv {
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
          const nameIdx = varIndexOf(s.names, name);
          // diff = coeff*name + constant; guard is coeff*name op -constant.
          // Represent "name" via its positive potential when coeff=1, or its
          // negative potential when coeff=-1 (which already IS "-name", so
          // the comparison direction does not need flipping the way Zones'
          // single-variable case does — the doubled encoding absorbs it).
          const a = coeff === 1 ? posIdx(nameIdx) : negIdx(nameIdx);
          const bound = coeff === 1 ? -diff.constant : diff.constant;
          // There is no zero node in this encoding; a single-variable bound
          // is expressed against the variable's own doubled self-pair.
          const raw = applySelfBound(s.m, a, bar(a), cond.op, 2 * bound);
          if (!raw) return s;
          const m = strongClosure(raw);
          return isConsistent(m) ? { kind: 'oct', names: s.names, m } : BOTTOM;
        }

        // Two variables: both differences AND sums are representable here.
        const [n1, c1] = diff.terms[0]!;
        const [n2, c2] = diff.terms[1]!;
        const i1 = varIndexOf(s.names, n1);
        const i2 = varIndexOf(s.names, n2);
        // c1*n1 + c2*n2 op -constant. Choose the potential pair matching
        // the sign combination: (+,-)/(-,+) is a difference, (+,+)/(-,-) a sum.
        const a = c1 === 1 ? posIdx(i1) : negIdx(i1);
        const b = c2 === 1 ? negIdx(i2) : posIdx(i2);
        const raw = applyPotentialConstraint(s.m, a, b, cond.op, -diff.constant);
        if (!raw) return s;
        const m = strongClosure(raw);
        return isConsistent(m) ? { kind: 'oct', names: s.names, m } : BOTTOM;
      }
    }
  }

  format(s: OctEnv): DisplayState {
    if (s.kind === 'bottom') return { kind: 'bottom', vars: [] };
    const vars: VarValue[] = s.names.map((name, i) => {
      const iv = projectInterval(s.m, i);
      const f = intervalLattice.format({ lo: iv.lo, hi: iv.hi });
      return { name, repr: f.repr, kind: f.kind };
    });

    const constraints: string[] = [];
    const n = s.names.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const diffBound = s.m[posIdx(i)]![posIdx(j)]!;
        if (diffBound !== Infinity) {
          constraints.push(`${s.names[i]} - ${s.names[j]} ≤ ${diffBound}`);
        }
        const sumBound = s.m[posIdx(i)]![negIdx(j)]!;
        if (sumBound !== Infinity && i < j) {
          constraints.push(`${s.names[i]} + ${s.names[j]} ≤ ${sumBound}`);
        }
      }
    }
    return constraints.length > 0 ? { kind: 'state', vars, constraints } : { kind: 'state', vars };
  }

  changed(a: OctEnv, b: OctEnv): string[] {
    if (a.kind === 'oct' && b.kind === 'oct') {
      const out: string[] = [];
      const n = a.names.length;
      for (let v = 0; v < n; v++) {
        const p = posIdx(v);
        const q = negIdx(v);
        let differs = false;
        for (let k = 0; k < a.m.length; k++) {
          if (a.m[p]![k] !== b.m[p]![k] || a.m[k]![p] !== b.m[k]![p] || a.m[q]![k] !== b.m[q]![k] || a.m[k]![q] !== b.m[k]![q]) {
            differs = true;
            break;
          }
        }
        if (differs) out.push(a.names[v]!);
      }
      return out;
    }
    if (a.kind === 'oct') return [...a.names];
    if (b.kind === 'oct') return [...b.names];
    return [];
  }

  lossReport(old: OctEnv, joined: OctEnv, widened: OctEnv): LossItem[] {
    if (joined.kind === 'bottom' || widened.kind === 'bottom') return [];
    const out: LossItem[] = [];
    const n = joined.names.length;
    const oldM = old.kind === 'bottom' ? undefined : old.m;

    const report = (label: string, jc: number, wc: number, oc: number, fmt: (c: number) => string): void => {
      if (jc === wc) return;
      out.push({
        name: label,
        before: fmt(oc),
        joined: fmt(jc),
        widened: fmt(wc),
        lostBound: 'upper',
        message:
          `The bound on ${label} grew from ${fmt(oc)} to ${fmt(jc)} between ` +
          `iterations, so widening discards it entirely, giving ${fmt(wc)}. ` +
          `Plain join would have kept ${fmt(jc)}; that relation is now unknown.`,
      });
    };

    for (let i = 0; i < n; i++) {
      const name = joined.names[i]!;
      const p = posIdx(i);
      const q = negIdx(i);
      report(
        `${name} (upper bound)`,
        joined.m[p]![q]!,
        widened.m[p]![q]!,
        oldM ? oldM[p]![q]! : Infinity,
        formatSelfHi
      );
      report(
        `${name} (lower bound)`,
        joined.m[q]![p]!,
        widened.m[q]![p]!,
        oldM ? oldM[q]![p]! : Infinity,
        formatSelfLo
      );
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const b = joined.names[j]!;
        report(
          `${name} − ${b}`,
          joined.m[posIdx(i)]![posIdx(j)]!,
          widened.m[posIdx(i)]![posIdx(j)]!,
          oldM ? oldM[posIdx(i)]![posIdx(j)]! : Infinity,
          formatDiff
        );
        if (i < j) {
          report(
            `${name} + ${b}`,
            joined.m[posIdx(i)]![negIdx(j)]!,
            widened.m[posIdx(i)]![negIdx(j)]!,
            oldM ? oldM[posIdx(i)]![negIdx(j)]! : Infinity,
            formatDiff
          );
        }
      }
    }
    return out;
  }

  valueOf(s: OctEnv, variable: string): string | undefined {
    if (s.kind === 'bottom') return undefined;
    const idx = s.names.indexOf(variable);
    if (idx === -1) return undefined;
    const iv = projectInterval(s.m, idx);
    return intervalLattice.format({ lo: iv.lo, hi: iv.hi }).repr;
  }
}

export const octagonsDomain = new OctagonsDomain();
