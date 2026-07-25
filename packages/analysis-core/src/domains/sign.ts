/**
 * The sign domain.
 *
 * A value is a subset of {negative, zero, positive}, encoded as a 3-bit mask.
 * That makes join bitwise-OR, meet bitwise-AND and `leq` a subset test, and it
 * gives the full 8-element lattice (including ≤0, ≥0 and ≠0) rather than the
 * impoverished 5-element one — which matters because the Hasse diagram of this
 * lattice is the clearest picture of "abstract order" a learner will see.
 */

import { NonRelationalDomain, type ValueLattice, type HasseDiagram } from '../domain.js';
import type { CmpOp } from '../ir.js';

export type Sign = number;

const NEG = 1;
const ZERO = 2;
const POS = 4;
const BOT: Sign = 0;
const TOP: Sign = NEG | ZERO | POS;

const LABELS: Record<number, string> = {
  0: '⊥',
  1: '-',
  2: '0',
  3: '≤0',
  4: '+',
  5: '≠0',
  6: '≥0',
  7: '⊤',
};

const signOf = (n: number): Sign => (n < 0 ? NEG : n === 0 ? ZERO : POS);

/** Lifts a binary operation on single signs to one on sign sets. */
function lift(f: (a: Sign, b: Sign) => Sign): (a: Sign, b: Sign) => Sign {
  return (a, b) => {
    if (a === BOT || b === BOT) return BOT;
    let out = BOT;
    for (const x of [NEG, ZERO, POS]) {
      if ((a & x) === 0) continue;
      for (const y of [NEG, ZERO, POS]) {
        if ((b & y) === 0) continue;
        out |= f(x, y);
      }
    }
    return out;
  };
}

const addS = lift((a, b) => {
  if (a === ZERO) return b;
  if (b === ZERO) return a;
  if (a === b) return a; // neg+neg = neg, pos+pos = pos
  return TOP; // opposite signs: anything
});

const mulS = lift((a, b) => {
  if (a === ZERO || b === ZERO) return ZERO;
  return a === b ? POS : NEG;
});

const divS = lift((a, b) => {
  if (b === ZERO) return BOT; // division by zero is not a value
  if (a === ZERO) return ZERO;
  // Integer division truncates, so 1/2 is 0 — the result may lose its sign.
  return a === b ? POS | ZERO : NEG | ZERO;
});

const modS = lift((a, b) => {
  if (b === ZERO) return BOT;
  return a === ZERO ? ZERO : a | ZERO;
});

const negS = (a: Sign): Sign => {
  let out = BOT;
  if (a & NEG) out |= POS;
  if (a & ZERO) out |= ZERO;
  if (a & POS) out |= NEG;
  return out;
};

export const signLattice: ValueLattice<Sign> = {
  id: 'sign',
  name: 'Sign',
  finiteLattice: true,

  bottom: BOT,
  top: TOP,

  isBottom: (v) => v === BOT,
  isTop: (v) => v === TOP,
  equal: (a, b) => a === b,
  leq: (a, b) => (a & ~b) === 0,
  join: (a, b) => a | b,
  meet: (a, b) => a & b,

  // The lattice has height 3, so no infinite ascending chains exist and
  // widening can safely be plain join. This is exactly why Sign converges
  // faster than Intervals on the same program.
  widen: (a, b) => a | b,
  narrow: (a, b) => a & b,

  constant: signOf,
  add: addS,
  sub: (a, b) => addS(a, negS(b)),
  mul: mulS,
  div: divS,
  mod: modS,
  neg: negS,

  refine(op: CmpOp, a: Sign, b: Sign): Sign {
    if (a === BOT || b === BOT) return BOT;
    // Keep only the signs of `a` for which some value of `b` makes `a op b` true.
    let out = BOT;
    for (const x of [NEG, ZERO, POS]) {
      if ((a & x) === 0) continue;
      for (const y of [NEG, ZERO, POS]) {
        if ((b & y) === 0) continue;
        if (possible(op, x, y)) {
          out |= x;
          break;
        }
      }
    }
    return out;
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
        `Widened from ${LABELS[joined]} to ${LABELS[widened]}. In a finite lattice ` +
        `like Sign this is just the join, so nothing is lost to termination here.`,
    };
  },

  latticeGraph(): HasseDiagram {
    const nodes = [0, 1, 2, 3, 4, 5, 6, 7].map((m) => ({
      id: String(m),
      label: LABELS[m]!,
    }));
    // An edge for each covering pair: b is a above a iff b adds exactly one bit.
    const edges: [string, string][] = [];
    for (let a = 0; a < 8; a++) {
      for (let b = 0; b < 8; b++) {
        if (a !== b && (a & ~b) === 0 && popcount(b) === popcount(a) + 1) {
          edges.push([String(a), String(b)]);
        }
      }
    }
    return { nodes, edges };
  },
};

function popcount(n: number): number {
  let c = 0;
  while (n) {
    c += n & 1;
    n >>= 1;
  }
  return c;
}

/** Can `x op y` hold for some concrete values with these signs? */
function possible(op: CmpOp, x: Sign, y: Sign): boolean {
  const lt: Record<string, boolean> = {
    // x < y
    [`${NEG},${NEG}`]: true,
    [`${NEG},${ZERO}`]: true,
    [`${NEG},${POS}`]: true,
    [`${ZERO},${NEG}`]: false,
    [`${ZERO},${ZERO}`]: false,
    [`${ZERO},${POS}`]: true,
    [`${POS},${NEG}`]: false,
    [`${POS},${ZERO}`]: false,
    [`${POS},${POS}`]: true,
  };
  const eq: Record<string, boolean> = {
    [`${NEG},${NEG}`]: true,
    [`${NEG},${ZERO}`]: false,
    [`${NEG},${POS}`]: false,
    [`${ZERO},${NEG}`]: false,
    [`${ZERO},${ZERO}`]: true,
    [`${ZERO},${POS}`]: false,
    [`${POS},${NEG}`]: false,
    [`${POS},${ZERO}`]: false,
    [`${POS},${POS}`]: true,
  };
  const key = `${x},${y}`;
  const canLt = lt[key] ?? true;
  const canEq = eq[key] ?? true;
  const canGt = lt[`${y},${x}`] ?? true;

  switch (op) {
    case '<':
      return canLt;
    case '<=':
      return canLt || canEq;
    case '>':
      return canGt;
    case '>=':
      return canGt || canEq;
    case '==':
      return canEq;
    case '!=':
      return canLt || canGt;
  }
}

export const signDomain = new NonRelationalDomain(signLattice);
