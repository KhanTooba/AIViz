/**
 * The Zones domain: constraints of the form `x − y ≤ c`.
 *
 * The classic answer to "Intervals can't relate `i` and `total`": Zones
 * tracks a Difference Bound Matrix (see `../relational/dbm.ts`) instead of
 * one interval per variable, so a fact like `total − i ≤ 45` can survive a
 * loop even though neither variable's own range is bounded.
 *
 * This implements `Domain<T>` directly rather than going through
 * `NonRelationalDomain<V>` — a relational domain's `assign`/`assume` have to
 * see and update the *whole* environment at once, not one variable in
 * isolation, which is exactly what `NonRelationalDomain` cannot express.
 */

import type { CmpOp, Cond, Expr } from '../ir.js';
import { negate } from '../ir.js';
import { flip, type Domain } from '../domain.js';
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

/** Matrix index 0 is the constant zero, per `dbm.ts`'s convention. */
const ZERO = 0;

export type ZoneEnv =
  | { readonly kind: 'bottom' }
  | { readonly kind: 'zone'; readonly names: readonly string[]; readonly m: Matrix };

const BOTTOM: ZoneEnv = { kind: 'bottom' };

function indexOf(names: readonly string[], name: string): number {
  return names.indexOf(name) + 1;
}

interface Interval {
  lo: number;
  hi: number;
}

function projectInterval(m: Matrix, idx: number): Interval {
  const hi = m[idx]![ZERO]!;
  const negLo = m[ZERO]![idx]!;
  return { lo: negLo === Infinity ? -Infinity : -negLo, hi };
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

function addIntervals(a: Interval, b: Interval): Interval {
  return {
    lo: a.lo === -Infinity || b.lo === -Infinity ? -Infinity : a.lo + b.lo,
    hi: a.hi === Infinity || b.hi === Infinity ? Infinity : a.hi + b.hi,
  };
}

/**
 * Shifts `srcIdx`'s entire row/column onto `targetIdx`, offset by the
 * *range* `[lo, hi]` rather than a fixed constant.
 *
 * This is the one operation that makes accumulator loops (`total := total +
 * i`) relationally interesting: `src` can be `target` itself, in which case
 * this preserves every existing relation `target` had to other variables,
 * loosened by the added range — instead of discarding them via a full
 * havoc, which is what a naive implementation would do here. When `lo ===
 * hi` (a fixed constant, e.g. `x := y + 3`) this is an exact transformer;
 * when `[lo, hi]` is a genuine range (e.g. the current bound on some other
 * variable `z` in `x := x + z`) it is a sound, precision-preserving
 * approximation, not a full discard.
 */
function shiftByRange(m: Matrix, targetIdx: number, srcIdx: number, lo: number, hi: number): Matrix {
  const n = m.length;
  const out = m.map((row) => [...row]);
  for (let k = 0; k < n; k++) {
    if (k === targetIdx) continue;
    const fromSrc = m[srcIdx]![k]!;
    const toSrc = m[k]![srcIdx]!;
    out[targetIdx]![k] = fromSrc === Infinity || hi === Infinity ? Infinity : fromSrc + hi;
    out[k]![targetIdx] = toSrc === Infinity || lo === -Infinity ? Infinity : toSrc - lo;
  }
  out[targetIdx]![targetIdx] = 0;
  return closure(out);
}

/** Forgets a variable entirely, then re-establishes only its own interval
 * bound — the sound fallback for an assignment with no usable "base" row
 * (a fresh combination of two other variables' negated forms, or a bare
 * reflection `x := -y`). Loses any relation to other variables; keeps only
 * what an interval domain would have known. */
function reboundVar(m: Matrix, targetIdx: number, lo: number, hi: number): Matrix {
  let out = forgetVar(m, targetIdx);
  if (hi !== Infinity) out = tighten(out, targetIdx, ZERO, hi);
  if (lo !== -Infinity) out = tighten(out, ZERO, targetIdx, -lo);
  return out;
}

/** Constrains `posIdx − negIdx (op) c`. `undefined` means "not a single
 * convex constraint" (only `!=` — the guard is left unrefined, soundly). */
function applyDiffConstraint(
  m: Matrix,
  posIdx: number,
  negIdx: number,
  op: CmpOp,
  c: number
): Matrix | undefined {
  switch (op) {
    case '<':
      return tighten(m, posIdx, negIdx, c - 1);
    case '<=':
      return tighten(m, posIdx, negIdx, c);
    case '>':
      return tighten(m, negIdx, posIdx, -(c + 1));
    case '>=':
      return tighten(m, negIdx, posIdx, -c);
    case '==':
      return tighten(tighten(m, posIdx, negIdx, c), negIdx, posIdx, -c);
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

function formatBound(c: number): string {
  return c === Infinity ? '⊤' : String(c);
}

class ZonesDomain implements Domain<ZoneEnv> {
  readonly id = 'zones';
  readonly name = 'Zones';
  readonly finiteLattice = false;

  bottom(): ZoneEnv {
    return BOTTOM;
  }

  top(vars: readonly string[]): ZoneEnv {
    return { kind: 'zone', names: [...vars], m: emptyMatrix(vars.length + 1) };
  }

  isBottom(s: ZoneEnv): boolean {
    return s.kind === 'bottom';
  }

  leq(a: ZoneEnv, b: ZoneEnv): boolean {
    if (a.kind === 'bottom') return true;
    if (b.kind === 'bottom') return false;
    return leqMatrix(a.m, b.m);
  }

  join(a: ZoneEnv, b: ZoneEnv): ZoneEnv {
    if (a.kind === 'bottom') return b;
    if (b.kind === 'bottom') return a;
    return { kind: 'zone', names: a.names, m: joinMatrix(a.m, b.m) };
  }

  meet(a: ZoneEnv, b: ZoneEnv): ZoneEnv {
    if (a.kind === 'bottom' || b.kind === 'bottom') return BOTTOM;
    const m = meetMatrix(a.m, b.m);
    return isConsistent(m) ? { kind: 'zone', names: a.names, m } : BOTTOM;
  }

  widen(a: ZoneEnv, b: ZoneEnv): ZoneEnv {
    if (a.kind === 'bottom') return b;
    if (b.kind === 'bottom') return a;
    return { kind: 'zone', names: a.names, m: widenMatrix(a.m, b.m) };
  }

  narrow(a: ZoneEnv, b: ZoneEnv): ZoneEnv {
    if (a.kind === 'bottom' || b.kind === 'bottom') return BOTTOM;
    return { kind: 'zone', names: a.names, m: narrowMatrix(a.m, b.m) };
  }

  assign(s: ZoneEnv, target: string, expr: Expr): ZoneEnv {
    if (s.kind === 'bottom') return s;
    const targetIdx = indexOf(s.names, target);
    const form = asLinearForm(expr);

    if (!form) {
      // nondet, or anything nonlinear (*, /, %): sound, honest fallback —
      // forget the target rather than guess a bound we can't justify.
      return { kind: 'zone', names: s.names, m: forgetVar(s.m, targetIdx) };
    }

    if (form.terms.length === 0) {
      // Exact: x := c.
      const forgotten = forgetVar(s.m, targetIdx);
      const m = tighten(
        tighten(forgotten, targetIdx, ZERO, form.constant),
        ZERO,
        targetIdx,
        -form.constant
      );
      return { kind: 'zone', names: s.names, m };
    }

    if (form.terms.length === 1) {
      const [name, coeff] = form.terms[0]!;
      const nameIdx = indexOf(s.names, name);
      if (coeff === 1) {
        // Exact: x := y + c (y may be x itself — the trivial "x := x + c").
        const m = shiftByRange(s.m, targetIdx, nameIdx, form.constant, form.constant);
        return { kind: 'zone', names: s.names, m };
      }
      // x := -y + c: a reflection, not representable as a shift in Zones
      // (Octagons' doubled encoding handles this exactly). Sound fallback:
      // negate y's own interval and use that as x's new, unrelated bound.
      const iv = shiftInterval(scaleInterval(projectInterval(s.m, nameIdx), -1), form.constant);
      const m = reboundVar(s.m, targetIdx, iv.lo, iv.hi);
      return { kind: 'zone', names: s.names, m };
    }

    // form.terms.length === 2: x := c1*t1 + c2*t2 + k.
    const [n1, c1] = form.terms[0]!;
    const [n2, c2] = form.terms[1]!;
    const i1 = indexOf(s.names, n1);
    const i2 = indexOf(s.names, n2);

    if (c1 === 1) {
      const delta = shiftInterval(scaleInterval(projectInterval(s.m, i2), c2), form.constant);
      return { kind: 'zone', names: s.names, m: shiftByRange(s.m, targetIdx, i1, delta.lo, delta.hi) };
    }
    if (c2 === 1) {
      const delta = shiftInterval(scaleInterval(projectInterval(s.m, i1), c1), form.constant);
      return { kind: 'zone', names: s.names, m: shiftByRange(s.m, targetIdx, i2, delta.lo, delta.hi) };
    }
    // Both coefficients -1 (e.g. x := -y - z + k): no term usable as a base
    // row without reflecting first, which needs Octagons. Sound fallback:
    // bound x from the combined interval alone, relating it to nothing.
    const iv1 = scaleInterval(projectInterval(s.m, i1), c1);
    const iv2 = scaleInterval(projectInterval(s.m, i2), c2);
    const combined = shiftInterval(addIntervals(iv1, iv2), form.constant);
    const m = reboundVar(s.m, targetIdx, combined.lo, combined.hi);
    return { kind: 'zone', names: s.names, m };
  }

  assume(s: ZoneEnv, cond: Cond): ZoneEnv {
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
        if (!diff) return s; // nonlinear guard: sound no-op

        if (diff.terms.length === 0) {
          return holds(cond.op, diff.constant) ? s : BOTTOM;
        }

        if (diff.terms.length === 1) {
          const [name, coeff] = diff.terms[0]!;
          const nameIdx = indexOf(s.names, name);
          const op2 = coeff === 1 ? cond.op : flip(cond.op);
          const bound = coeff === 1 ? -diff.constant : diff.constant;
          const m = applyDiffConstraint(s.m, nameIdx, ZERO, op2, bound);
          if (!m) return s;
          return isConsistent(m) ? { kind: 'zone', names: s.names, m } : BOTTOM;
        }

        // Two variables: only a genuine *difference* (opposite-sign
        // coefficients) is representable in Zones — a sum needs Octagons.
        const [n1, c1] = diff.terms[0]!;
        const [n2, c2] = diff.terms[1]!;
        if (c1 === c2) return s;
        const i1 = indexOf(s.names, n1);
        const i2 = indexOf(s.names, n2);
        const posIdx = c1 === 1 ? i1 : i2;
        const negIdx = c1 === 1 ? i2 : i1;
        const m = applyDiffConstraint(s.m, posIdx, negIdx, cond.op, -diff.constant);
        if (!m) return s;
        return isConsistent(m) ? { kind: 'zone', names: s.names, m } : BOTTOM;
      }
    }
  }

  format(s: ZoneEnv): DisplayState {
    if (s.kind === 'bottom') return { kind: 'bottom', vars: [] };
    const vars: VarValue[] = s.names.map((name, i) => {
      const iv = projectInterval(s.m, i + 1);
      const f = intervalLattice.format({ lo: iv.lo, hi: iv.hi });
      return { name, repr: f.repr, kind: f.kind };
    });

    const constraints: string[] = [];
    const n = s.names.length;
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= n; j++) {
        if (i === j) continue;
        const c = s.m[i]![j]!;
        if (c !== Infinity) {
          constraints.push(`${s.names[i - 1]} - ${s.names[j - 1]} ≤ ${c}`);
        }
      }
    }
    return constraints.length > 0 ? { kind: 'state', vars, constraints } : { kind: 'state', vars };
  }

  changed(a: ZoneEnv, b: ZoneEnv): string[] {
    if (a.kind === 'zone' && b.kind === 'zone') {
      const out: string[] = [];
      const n = a.names.length;
      for (let idx = 1; idx <= n; idx++) {
        let differs = false;
        for (let k = 0; k <= n; k++) {
          if (a.m[idx]![k] !== b.m[idx]![k] || a.m[k]![idx] !== b.m[k]![idx]) {
            differs = true;
            break;
          }
        }
        if (differs) out.push(a.names[idx - 1]!);
      }
      return out;
    }
    if (a.kind === 'zone') return [...a.names];
    if (b.kind === 'zone') return [...b.names];
    return [];
  }

  lossReport(old: ZoneEnv, joined: ZoneEnv, widened: ZoneEnv): LossItem[] {
    if (joined.kind === 'bottom' || widened.kind === 'bottom') return [];
    const out: LossItem[] = [];
    const n = joined.names.length;
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= n; j++) {
        if (i === j) continue;
        const jc = joined.m[i]![j]!;
        const wc = widened.m[i]![j]!;
        if (jc === wc) continue;
        const oc = old.kind === 'bottom' ? Infinity : old.m[i]![j]!;
        const a = joined.names[i - 1]!;
        const b = joined.names[j - 1]!;
        out.push({
          name: `${a} − ${b}`,
          before: formatBound(oc),
          joined: formatBound(jc),
          widened: formatBound(wc),
          lostBound: 'upper',
          message:
            `The bound on ${a} − ${b} grew from ${formatBound(oc)} to ${formatBound(jc)} between ` +
            `iterations, so widening discards it entirely, giving ${formatBound(wc)}. ` +
            `Plain join would have kept ${formatBound(jc)}; that relation is now unknown.`,
        });
      }
    }
    return out;
  }

  // Explicitly overrides `Object.prototype.valueOf` (every object has one by
  // default, with an incompatible signature) with the real, optional
  // `Domain<T>` member of the same name.
  valueOf(s: ZoneEnv, variable: string): string | undefined {
    if (s.kind === 'bottom') return undefined;
    const idx = s.names.indexOf(variable);
    if (idx === -1) return undefined;
    const iv = projectInterval(s.m, idx + 1);
    return intervalLattice.format({ lo: iv.lo, hi: iv.hi }).repr;
  }
}

export const zonesDomain = new ZonesDomain();
