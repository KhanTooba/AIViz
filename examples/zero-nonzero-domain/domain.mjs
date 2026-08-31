// A small, finite value lattice suitable for teaching and experimentation.
// AIViz's NonRelationalDomain supplies environments and transfer plumbing;
// this module describes just one abstract integer value.

const BOT = 0;
const ZERO = 1;
const NONZERO = 2;
const TOP = ZERO | NONZERO;

const labels = {
  [BOT]: '⊥',
  [ZERO]: '0',
  [NONZERO]: '≠0',
  [TOP]: '⊤',
};

function isBottom(value) {
  return value === BOT;
}

function binary(left, right, operation) {
  if (isBottom(left) || isBottom(right)) return BOT;
  let result = BOT;
  for (const leftValue of [ZERO, NONZERO]) {
    if ((left & leftValue) === 0) continue;
    for (const rightValue of [ZERO, NONZERO]) {
      if ((right & rightValue) === 0) continue;
      result |= operation(leftValue, rightValue);
    }
  }
  return result;
}

export const lattice = {
  id: 'zero-nonzero',
  name: 'Zero / Nonzero',
  finiteLattice: true,
  bottom: BOT,
  top: TOP,
  isBottom,
  isTop: (value) => value === TOP,
  equal: (left, right) => left === right,
  leq: (left, right) => (left & ~right) === 0,
  join: (left, right) => left | right,
  meet: (left, right) => left & right,
  widen: (left, right) => left | right,
  narrow: (left, right) => left & right,
  constant: (value) => (value === 0 ? ZERO : NONZERO),
  add: (left, right) => binary(left, right, (a, b) => (a === ZERO ? b : b === ZERO ? a : TOP)),
  sub: (left, right) => binary(left, right, (a, b) => (a === ZERO ? b : b === ZERO ? a : TOP)),
  mul: (left, right) => binary(left, right, (a, b) => (a === ZERO || b === ZERO ? ZERO : NONZERO)),
  div: (left, right) => binary(left, right, (a, _b) => (a === ZERO ? ZERO : TOP)),
  mod: (left, right) => binary(left, right, () => TOP),
  neg: (value) => value,
  refine: (operator, left, right) => {
    if (isBottom(left) || isBottom(right)) return BOT;
    if (operator === '==' && right !== TOP) return left & right;
    if (operator === '!=' && right === ZERO) return left & NONZERO;
    return left;
  },
  format: (value) => ({
    repr: labels[value] ?? '?',
    kind: value === BOT ? 'bottom' : value === TOP ? 'top' : 'value',
  }),
  describeLoss: () => undefined,
  latticeGraph: () => ({
    nodes: [
      { id: 'bottom', label: '⊥' },
      { id: 'zero', label: '0' },
      { id: 'nonzero', label: '≠0' },
      { id: 'top', label: '⊤' },
    ],
    edges: [
      ['bottom', 'zero'],
      ['bottom', 'nonzero'],
      ['zero', 'top'],
      ['nonzero', 'top'],
    ],
  }),
};
