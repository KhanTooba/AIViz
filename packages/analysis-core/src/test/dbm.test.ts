import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closure,
  emptyMatrix,
  equalMatrix,
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

// Dimensions for these tests: 0 = constant zero, 1 = x, 2 = y, 3 = z.
const ZERO = 0;
const X = 1;
const Y = 2;
const Z = 3;

function withBounds(entries: [number, number, number][]): Matrix {
  let m = emptyMatrix(4);
  for (const [i, j, c] of entries) m = tighten(m, i, j, c);
  return m;
}

test('emptyMatrix has zero on the diagonal and +Infinity elsewhere', () => {
  const m = emptyMatrix(3);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      assert.equal(m[i]![j]!, i === j ? 0 : Infinity);
    }
  }
});

test('closure derives a transitive bound: x-y≤2 and y-z≤3 implies x-z≤5', () => {
  // x - y ≤ 2, y - z ≤ 3
  const m = withBounds([
    [X, Y, 2],
    [Y, Z, 3],
  ]);
  const closed = closure(m);
  assert.equal(closed[X]![Z], 5);
});

test('closure picks the tightest of several paths, hand-verified', () => {
  // x-y≤1, y-z≤1, and directly x-z≤10 — closure must prefer 1+1=2 over 10.
  const m = withBounds([
    [X, Y, 1],
    [Y, Z, 1],
    [X, Z, 10],
  ]);
  const closed = closure(m);
  assert.equal(closed[X]![Z], 2);
});

test('a negative cycle (x-y≤1 and y-x≤-3) is inconsistent — x < x-2 is impossible', () => {
  // x - y ≤ 1 and y - x ≤ -3 implies x - x ≤ 1 + -3 = -2, a negative self-loop.
  const m = withBounds([
    [X, Y, 1],
    [Y, X, -3],
  ]);
  const closed = closure(m);
  assert.equal(isConsistent(closed), false);
});

test('a satisfiable system stays consistent', () => {
  const m = closure(withBounds([[X, ZERO, 10], [ZERO, X, 0]])); // 0 ≤ x ≤ 10
  assert.equal(isConsistent(m), true);
});

test('leq is reflexive, and a tighter matrix is leq a looser one', () => {
  const tight = closure(withBounds([[X, ZERO, 5]])); // x ≤ 5
  const loose = closure(withBounds([[X, ZERO, 10]])); // x ≤ 10
  assert.equal(leqMatrix(tight, tight), true);
  assert.equal(leqMatrix(tight, loose), true, 'x≤5 implies x≤10');
  assert.equal(leqMatrix(loose, tight), false, 'x≤10 does not imply x≤5');
});

test('join is the loosest bound either side allows (a true least upper bound)', () => {
  const a = closure(withBounds([[X, ZERO, 5]])); // x ≤ 5
  const b = closure(withBounds([[X, ZERO, 10]])); // x ≤ 10
  const j = joinMatrix(a, b);
  assert.equal(j[X]![ZERO], 10, 'join of x≤5 and x≤10 is x≤10');
  // Least upper bound: both operands ⊑ join, and join ⊑ any common upper bound.
  assert.equal(leqMatrix(a, j), true);
  assert.equal(leqMatrix(b, j), true);
});

test('meet tightens to the strictest bound and detects contradictions', () => {
  const a = closure(withBounds([[X, ZERO, 10]])); // x ≤ 10
  const b = closure(withBounds([[X, ZERO, 5]])); // x ≤ 5
  const m = meetMatrix(a, b);
  assert.equal(m[X]![ZERO], 5, 'meet of x≤10 and x≤5 is x≤5');
  assert.equal(isConsistent(m), true);

  // x ≤ 5 met with x ≥ 6 (i.e. -x ≤ -6) must be inconsistent.
  const c = closure(withBounds([[ZERO, X, -6]])); // -x ≤ -6, i.e. x ≥ 6
  const contradiction = meetMatrix(a, c);
  const tightened = meetMatrix(contradiction, b);
  assert.equal(isConsistent(tightened), false, 'x≤5 and x≥6 cannot both hold');
});

test('widen jumps a growing bound to +Infinity and leaves a stable one alone', () => {
  const old = closure(withBounds([[X, ZERO, 3]])); // x ≤ 3
  const grown = closure(withBounds([[X, ZERO, 7]])); // x ≤ 7 — grew
  const widened = widenMatrix(old, grown);
  assert.equal(widened[X]![ZERO], Infinity, 'a bound that grew is discarded entirely');

  const same = closure(withBounds([[X, ZERO, 3]])); // unchanged
  const stillStable = widenMatrix(old, same);
  assert.equal(stillStable[X]![ZERO], 3, 'a bound that did not grow is kept');
});

test('widening a matrix against itself changes nothing (idempotent on a fixed point)', () => {
  const m = closure(withBounds([[X, Y, 2], [Y, Z, 3]]));
  const widened = widenMatrix(m, m);
  assert.equal(equalMatrix(m, widened), true);
});

test('narrow recovers a bound only where widening had discarded it', () => {
  const widened = closure(withBounds([[X, ZERO, 3]])); // only x≤3 known; y untouched (∞)
  const fresh = closure(withBounds([[X, ZERO, 3], [Y, ZERO, 9]])); // fresh join found x≤3, y≤9
  const narrowed = narrowMatrix(widened, fresh);
  // x≤3 was already finite (not thrown away by widening) — stays exactly as it was.
  assert.equal(narrowed[X]![ZERO], 3);
  // y was ∞ (i.e. widened-away or never known) — narrowing adopts the fresh bound.
  assert.equal(narrowed[Y]![ZERO], 9);
});

test('forgetVar resets one variable\'s relations but leaves everyone else alone', () => {
  const m = closure(withBounds([[X, Y, 2], [Y, Z, 3], [X, Z, 5]]));
  const forgotten = forgetVar(m, X);
  assert.equal(forgotten[X]![Y], Infinity);
  assert.equal(forgotten[Y]![X], Infinity);
  assert.equal(forgotten[X]![Z], Infinity);
  assert.equal(forgotten[X]![X], 0);
  // y-z is unrelated to x and must survive untouched.
  assert.equal(forgotten[Y]![Z], m[Y]![Z]);
});

test('tighten only tightens — a looser constant leaves the matrix unchanged', () => {
  const m = closure(withBounds([[X, ZERO, 5]]));
  const same = tighten(m, X, ZERO, 10); // looser than the existing x≤5
  assert.equal(same[X]![ZERO], 5, 'a looser bound must not widen what we already know');
});
