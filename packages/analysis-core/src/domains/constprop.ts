/**
 * Constant propagation over the flat lattice: ⊥ < any single constant < ⊤.
 *
 * The flat lattice has height 2, so no infinite ascending chain exists and
 * widening is plain join. Pedagogically this is the cleanest illustration of a
 * join *losing* information: two different constants meet and immediately
 * collapse to ⊤, with no interval to soften the fall.
 */

import { NonRelationalDomain, type ValueLattice, type HasseDiagram } from '../domain.js';
import type { CmpOp } from '../ir.js';

export type Const =
  | { readonly k: 'bottom' }
  | { readonly k: 'const'; readonly value: number }
  | { readonly k: 'top' };

const BOT: Const = { k: 'bottom' };
const TOP: Const = { k: 'top' };
const cst = (value: number): Const => ({ k: 'const', value });

/** Applies a concrete operation only when both operands are known constants. */
function strict(f: (a: number, b: number) => number | undefined) {
  return (a: Const, b: Const): Const => {
    if (a.k === 'bottom' || b.k === 'bottom') return BOT;
    if (a.k === 'top' || b.k === 'top') return TOP;
    const r = f(a.value, b.value);
    return r === undefined ? BOT : cst(r);
  };
}

export const constLattice: ValueLattice<Const> = {
  id: 'constprop',
  name: 'Constant Propagation',
  finiteLattice: false,

  bottom: BOT,
  top: TOP,

  isBottom: (v) => v.k === 'bottom',
  isTop: (v) => v.k === 'top',
  equal: (a, b) =>
    a.k === b.k && (a.k !== 'const' || a.value === (b as { value: number }).value),

  leq(a, b) {
    if (a.k === 'bottom') return true;
    if (b.k === 'top') return true;
    if (a.k === 'top') return false;
    return b.k === 'const' && a.value === b.value;
  },

  join(a, b) {
    if (a.k === 'bottom') return b;
    if (b.k === 'bottom') return a;
    if (a.k === 'top' || b.k === 'top') return TOP;
    // Two different constants have no common value: straight to ⊤.
    return a.value === b.value ? a : TOP;
  },

  meet(a, b) {
    if (a.k === 'bottom' || b.k === 'bottom') return BOT;
    if (a.k === 'top') return b;
    if (b.k === 'top') return a;
    return a.value === (b as { value: number }).value ? a : BOT;
  },

  // Height 2: join already terminates, so widening need not lose anything.
  widen: (a, b) => constLattice.join(a, b),
  narrow: (a, b) => constLattice.meet(a, b),

  constant: cst,
  add: strict((a, b) => a + b),
  sub: strict((a, b) => a - b),
  mul: strict((a, b) => a * b),
  div: strict((a, b) => (b === 0 ? undefined : Math.trunc(a / b))),
  mod: strict((a, b) => (b === 0 ? undefined : a % b)),
  neg: (a) => (a.k === 'const' ? cst(-a.value) : a),

  refine(op: CmpOp, a: Const, b: Const): Const {
    if (a.k === 'bottom' || b.k === 'bottom') return BOT;
    // Only `x == c` yields new information in a flat lattice.
    if (op === '==' && a.k === 'top' && b.k === 'const') return b;
    if (a.k !== 'const' || b.k !== 'const') return a;
    return holds(op, a.value, b.value) ? a : BOT;
  },

  format(v) {
    if (v.k === 'bottom') return { repr: '⊥', kind: 'bottom' };
    if (v.k === 'top') return { repr: '⊤', kind: 'top' };
    return { repr: String(v.value), kind: 'value' };
  },

  describeLoss(_old, joined, widened) {
    if (constLattice.equal(joined, widened)) return undefined;
    return {
      lostBound: 'both',
      message:
        'In the flat constant lattice, widening is the same as join, so nothing ' +
        'extra is given up for termination.',
    };
  },

  latticeGraph(): HasseDiagram | undefined {
    // Infinitely many constants sit between ⊥ and ⊤, so no finite diagram.
    return undefined;
  },
};

function holds(op: CmpOp, a: number, b: number): boolean {
  switch (op) {
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    case '==':
      return a === b;
    case '!=':
      return a !== b;
  }
}

export const constDomain = new NonRelationalDomain(constLattice);
