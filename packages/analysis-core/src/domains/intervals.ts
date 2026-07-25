/**
 * The interval domain over the integers.
 *
 * Bottom is represented as the empty interval (lo > hi) rather than a separate
 * tag, which makes join/meet fall out of min/max without special cases.
 */

import type { LossItem } from '@aiviz/trace-protocol';
import { NonRelationalDomain, type ValueLattice, type HasseDiagram } from '../domain.js';
import type { CmpOp } from '../ir.js';

export interface Interval {
  readonly lo: number;
  readonly hi: number;
}

const BOTTOM: Interval = { lo: Infinity, hi: -Infinity };
const TOP: Interval = { lo: -Infinity, hi: Infinity };

const isBot = (v: Interval): boolean => v.lo > v.hi;

function mk(lo: number, hi: number): Interval {
  if (lo > hi) return BOTTOM;
  return { lo, hi };
}

/**
 * Endpoint multiplication where 0 absorbs infinity.
 *
 * Plain `0 * Infinity` is NaN in JS, but for interval endpoints the right
 * answer is 0 — e.g. [0,5] * [2,+inf) is [0,+inf), not [NaN,...].
 */
function mulEnd(x: number, y: number): number {
  if (x === 0 || y === 0) return 0;
  return x * y;
}

function truncToward0(x: number): number {
  return Number.isFinite(x) ? Math.trunc(x) : x;
}

function fmtBound(x: number): string {
  if (x === -Infinity) return '-∞';
  if (x === Infinity) return '+∞';
  return String(x);
}

export const intervalLattice: ValueLattice<Interval> = {
  id: 'intervals',
  name: 'Intervals',
  finiteLattice: false,

  bottom: BOTTOM,
  top: TOP,

  isBottom: isBot,
  isTop: (v) => v.lo === -Infinity && v.hi === Infinity,
  equal: (a, b) => (isBot(a) && isBot(b)) || (a.lo === b.lo && a.hi === b.hi),

  leq(a, b) {
    if (isBot(a)) return true;
    if (isBot(b)) return false;
    return a.lo >= b.lo && a.hi <= b.hi;
  },

  join(a, b) {
    if (isBot(a)) return b;
    if (isBot(b)) return a;
    return mk(Math.min(a.lo, b.lo), Math.max(a.hi, b.hi));
  },

  meet(a, b) {
    if (isBot(a) || isBot(b)) return BOTTOM;
    return mk(Math.max(a.lo, b.lo), Math.min(a.hi, b.hi));
  },

  /**
   * Classic interval widening: any bound that grew is thrown to infinity.
   * This is what guarantees termination on ascending chains.
   */
  widen(a, b) {
    if (isBot(a)) return b;
    if (isBot(b)) return a;
    return mk(
      b.lo < a.lo ? -Infinity : a.lo,
      b.hi > a.hi ? Infinity : a.hi
    );
  },

  /**
   * Narrowing only refines bounds that widening had sent to infinity, so it
   * cannot undo genuine information and still terminates.
   */
  narrow(a, b) {
    if (isBot(a) || isBot(b)) return BOTTOM;
    return mk(
      a.lo === -Infinity ? b.lo : a.lo,
      a.hi === Infinity ? b.hi : a.hi
    );
  },

  constant: (n) => mk(n, n),

  add: (a, b) => (isBot(a) || isBot(b) ? BOTTOM : mk(a.lo + b.lo, a.hi + b.hi)),
  sub: (a, b) => (isBot(a) || isBot(b) ? BOTTOM : mk(a.lo - b.hi, a.hi - b.lo)),

  mul(a, b) {
    if (isBot(a) || isBot(b)) return BOTTOM;
    const corners = [
      mulEnd(a.lo, b.lo),
      mulEnd(a.lo, b.hi),
      mulEnd(a.hi, b.lo),
      mulEnd(a.hi, b.hi),
    ];
    return mk(Math.min(...corners), Math.max(...corners));
  },

  div(a, b) {
    if (isBot(a) || isBot(b)) return BOTTOM;
    // A divisor spanning zero could produce anything; stay sound rather than clever.
    if (b.lo <= 0 && b.hi >= 0) return TOP;
    const corners = [a.lo / b.lo, a.lo / b.hi, a.hi / b.lo, a.hi / b.hi].map(truncToward0);
    return mk(Math.min(...corners), Math.max(...corners));
  },

  mod(a, b) {
    if (isBot(a) || isBot(b)) return BOTTOM;
    // Only the common non-negative case is modelled precisely.
    if (a.lo >= 0 && b.lo > 0 && Number.isFinite(b.hi)) {
      return mk(0, Math.min(a.hi, b.hi - 1));
    }
    return TOP;
  },

  neg: (a) => (isBot(a) ? BOTTOM : mk(-a.hi, -a.lo)),

  refine(op: CmpOp, a: Interval, b: Interval): Interval {
    if (isBot(a) || isBot(b)) return BOTTOM;
    switch (op) {
      // Integers, so a strict bound tightens by one.
      case '<':
        return mk(a.lo, Math.min(a.hi, b.hi - 1));
      case '<=':
        return mk(a.lo, Math.min(a.hi, b.hi));
      case '>':
        return mk(Math.max(a.lo, b.lo + 1), a.hi);
      case '>=':
        return mk(Math.max(a.lo, b.lo), a.hi);
      case '==':
        return mk(Math.max(a.lo, b.lo), Math.min(a.hi, b.hi));
      case '!=':
        // Only refinable when the excluded value sits exactly on an endpoint.
        if (b.lo === b.hi) {
          if (a.lo === b.lo) return mk(a.lo + 1, a.hi);
          if (a.hi === b.hi) return mk(a.lo, a.hi - 1);
        }
        return a;
    }
  },

  format(v) {
    if (isBot(v)) return { repr: '⊥', kind: 'bottom' };
    if (v.lo === -Infinity && v.hi === Infinity) return { repr: '⊤', kind: 'top' };
    const open = v.lo === -Infinity ? '(' : '[';
    const close = v.hi === Infinity ? ')' : ']';
    return {
      repr: `${open}${fmtBound(v.lo)}, ${fmtBound(v.hi)}${close}`,
      kind: 'value',
    };
  },

  describeLoss(old, joined, widened) {
    const lostLower = joined.lo > widened.lo;
    const lostUpper = joined.hi < widened.hi;
    if (!lostLower && !lostUpper) return undefined;

    const bound: LossItem['lostBound'] = lostLower && lostUpper ? 'both' : lostLower ? 'lower' : 'upper';
    const parts: string[] = [];
    if (lostUpper) {
      parts.push(
        `The upper bound grew from ${fmtBound(old.hi)} to ${fmtBound(joined.hi)}, ` +
          `so widening discarded it entirely.`
      );
    }
    if (lostLower) {
      parts.push(
        `The lower bound fell from ${fmtBound(old.lo)} to ${fmtBound(joined.lo)}, ` +
          `so widening discarded it entirely.`
      );
    }
    const joinedRepr = intervalLattice.format(joined).repr;
    parts.push(
      `Plain join would have kept ${joinedRepr}; that bound is now unknown here.`
    );
    return { lostBound: bound, message: parts.join(' ') };
  },

  latticeGraph(): HasseDiagram | undefined {
    // The interval lattice is infinite, so there is no finite Hasse diagram.
    // The UI falls back to plotting the ascending chain actually traversed.
    return undefined;
  },
};

export const intervalDomain = new NonRelationalDomain(intervalLattice);
