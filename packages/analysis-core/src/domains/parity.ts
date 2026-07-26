/**
 * The parity domain: is a value even, odd, both (⊤) or neither (⊥)?
 *
 * Same bitset trick as Sign, one size down: a value is a subset of
 * {even, odd}, so join is bitwise-OR and `leq` is a subset test. The lattice
 * has height 2 (⊥ < {even, odd} < ⊤), so — like Sign — no infinite ascending
 * chain exists and widening can safely be plain join.
 *
 * Parity is a genuinely different property from Sign or Intervals: it is the
 * cleanest domain for showing that "widening" is not one universal
 * algorithm — this domain's widen is trivial precisely because its lattice
 * is small, which is a fact about the domain, not about widening in general.
 */

import { NonRelationalDomain, type ValueLattice, type HasseDiagram } from '../domain.js';
import type { CmpOp } from '../ir.js';

export type Parity = number;

const EVEN = 1;
const ODD = 2;
const BOT: Parity = 0;
const TOP: Parity = EVEN | ODD;

const LABELS: Record<number, string> = {
  0: '⊥',
  1: 'even',
  2: 'odd',
  3: '⊤',
};

/** JS `%` can return a negative remainder for negative operands. */
const parityOf = (n: number): Parity => (((n % 2) + 2) % 2 === 0 ? EVEN : ODD);

function lift(f: (a: Parity, b: Parity) => Parity): (a: Parity, b: Parity) => Parity {
  return (a, b) => {
    if (a === BOT || b === BOT) return BOT;
    let out = BOT;
    for (const x of [EVEN, ODD]) {
      if ((a & x) === 0) continue;
      for (const y of [EVEN, ODD]) {
        if ((b & y) === 0) continue;
        out |= f(x, y);
      }
    }
    return out;
  };
}

const addP = lift((a, b) => (a === b ? EVEN : ODD));
// a - b has the same parity as a + b: subtracting an odd number flips parity
// exactly when adding one does.
const subP = lift((a, b) => (a === b ? EVEN : ODD));
const mulP = lift((a, b) => (a === EVEN || b === EVEN ? EVEN : ODD));

export const parityLattice: ValueLattice<Parity> = {
  id: 'parity',
  name: 'Parity',
  finiteLattice: true,

  bottom: BOT,
  top: TOP,

  isBottom: (v) => v === BOT,
  isTop: (v) => v === TOP,
  equal: (a, b) => a === b,
  leq: (a, b) => (a & ~b) === 0,
  join: (a, b) => a | b,
  meet: (a, b) => a & b,

  widen: (a, b) => a | b,
  narrow: (a, b) => a & b,

  constant: parityOf,
  add: addP,
  sub: subP,
  mul: mulP,
  // Division and modulo do not preserve parity in any useful way — e.g.
  // 6/2=3 (odd) but 8/2=4 (even) — so both fall back to ⊤ rather than
  // claiming a precision the arithmetic does not support.
  div: (a, b) => (a === BOT || b === BOT ? BOT : TOP),
  mod: (a, b) => (a === BOT || b === BOT ? BOT : TOP),
  neg: (a) => a, // -x always has the same parity as x

  refine(op: CmpOp, a: Parity, b: Parity): Parity {
    if (a === BOT || b === BOT) return BOT;
    // Ordering tells us nothing about parity; only equality does. If b is
    // known to be exactly one parity, an asserted `a == b` forces a to match.
    if (op === '==') return a & b;
    return a;
  },

  format(v) {
    if (v === BOT) return { repr: '⊥', kind: 'bottom' };
    if (v === TOP) return { repr: '⊤', kind: 'top' };
    return { repr: LABELS[v] ?? '?', kind: 'value' };
  },

  describeLoss(_old, joined, widened) {
    if (joined === widened) return undefined;
    return {
      lostBound: 'both',
      message:
        `Widened from ${LABELS[joined]} to ${LABELS[widened]}. Parity's lattice has ` +
        `height 2, so widening is just the join here too — there is no infinite ` +
        `climb to cut off, so nothing beyond the join itself is ever given up.`,
    };
  },

  latticeGraph(): HasseDiagram {
    return {
      nodes: [0, 1, 2, 3].map((m) => ({ id: String(m), label: LABELS[m]! })),
      edges: [
        ['0', '1'],
        ['0', '2'],
        ['1', '3'],
        ['2', '3'],
      ],
    };
  },
};

export const parityDomain = new NonRelationalDomain(parityLattice);
