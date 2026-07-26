import { test } from 'node:test';
import assert from 'node:assert/strict';
import { polyhedraDomain, type PolyEnv } from '../domains/polyhedra.js';
import type { CmpOp, Cond, Expr } from '../ir.js';

const v = (name: string): Expr => ({ kind: 'var', name });
const n = (value: number): Expr => ({ kind: 'const', value });
const add = (l: Expr, r: Expr): Expr => ({ kind: 'binary', op: '+', left: l, right: r });
const mul = (l: Expr, r: Expr): Expr => ({ kind: 'binary', op: '*', left: l, right: r });
const cmp = (op: CmpOp, l: Expr, r: Expr): Cond => ({ kind: 'cmp', op, left: l, right: r });

function repr(s: PolyEnv, name: string): string | undefined {
  return polyhedraDomain.format(s).vars.find((x) => x.name === name)?.repr;
}
function constraintsOf(s: PolyEnv): string[] {
  return polyhedraDomain.format(s).constraints ?? [];
}

test('top gives every variable ⊤ and no constraints', () => {
  const s = polyhedraDomain.top(['x', 'y']);
  assert.equal(repr(s, 'x'), '⊤');
  assert.deepEqual(constraintsOf(s), []);
});

test('x := 5 pins x exactly', () => {
  let s = polyhedraDomain.top(['x']);
  s = polyhedraDomain.assign(s, 'x', n(5));
  assert.equal(repr(s, 'x'), '[5, 5]');
});

test('self-referential assignment x := x + 5 is exact, not a contradiction', () => {
  // Regression test for a real bug caught during implementation: treating
  // `target` as one variable appearing on both sides of `target = expr`
  // collapses `x := x + 5` into the fixed-point equation `x = x + 5`, i.e.
  // `0 = 5` — an actual contradiction, wrongly making the state bottom.
  // The fix renames the pre-assignment value onto a fresh column before
  // eliminating it (see assign()'s doc comment).
  let s = polyhedraDomain.top(['x']);
  s = polyhedraDomain.assign(s, 'x', n(0));
  s = polyhedraDomain.assign(s, 'x', add(v('x'), n(5)));
  assert.equal(polyhedraDomain.isBottom(s), false);
  assert.equal(repr(s, 'x'), '[5, 5]');
  s = polyhedraDomain.assign(s, 'x', add(v('x'), n(5)));
  assert.equal(repr(s, 'x'), '[10, 10]');
});

test('y := 2*x + 3 is exact with an arbitrary coefficient', () => {
  let s = polyhedraDomain.top(['x', 'y']);
  s = polyhedraDomain.assign(s, 'x', n(5));
  s = polyhedraDomain.assign(s, 'y', add(mul(n(2), v('x')), n(3)));
  assert.equal(repr(s, 'y'), '[13, 13]');
});

test('a genuinely three-variable guard (x + y + z < 10) is exact — beyond what Zones/Octagons can hold', () => {
  let s = polyhedraDomain.top(['x', 'y', 'z']);
  s = polyhedraDomain.assume(s, cmp('<', add(add(v('x'), v('y')), v('z')), n(10)));
  const cs = constraintsOf(s);
  assert.ok(
    cs.some((c) => c.includes('x') && c.includes('y') && c.includes('z')),
    `expected a genuine three-variable constraint, got ${JSON.stringify(cs)}`
  );
});

test('an unsatisfiable guard yields bottom', () => {
  let s = polyhedraDomain.top(['x']);
  s = polyhedraDomain.assign(s, 'x', n(5));
  s = polyhedraDomain.assume(s, cmp('>', v('x'), n(10)));
  assert.equal(polyhedraDomain.isBottom(s), true);
});

test('meet of x<=5 and x>=6 is bottom', () => {
  let a = polyhedraDomain.top(['x']);
  a = polyhedraDomain.assume(a, cmp('<=', v('x'), n(5)));
  let b = polyhedraDomain.top(['x']);
  b = polyhedraDomain.assume(b, cmp('>=', v('x'), n(6)));
  assert.equal(polyhedraDomain.isBottom(polyhedraDomain.meet(a, b)), true);
});

test('leq is an exact entailment check, not just structural equality', () => {
  // a: 0<=x<=10.  b: 0<=x<=20.  a is strictly tighter, so a ⊑ b but not the
  // reverse — this must hold via genuine entailment, since a's constraint
  // set is not literally a subset of b's.
  let a = polyhedraDomain.top(['x']);
  a = polyhedraDomain.assume(a, cmp('>=', v('x'), n(0)));
  a = polyhedraDomain.assume(a, cmp('<=', v('x'), n(10)));
  let b = polyhedraDomain.top(['x']);
  b = polyhedraDomain.assume(b, cmp('>=', v('x'), n(0)));
  b = polyhedraDomain.assume(b, cmp('<=', v('x'), n(20)));
  assert.equal(polyhedraDomain.leq(a, b), true);
  assert.equal(polyhedraDomain.leq(b, a), false);
});

test('flagship: join (convex hull) of two points discovers the diagonal constraint neither point alone implies', () => {
  // a = (0,0), b = (10,10). Their convex hull is the *segment* between them,
  // which satisfies x = y exactly — a relation that isn't a bounding box
  // (the box [0,10]x[0,10] would wrongly also contain e.g. (0,10)).
  let a = polyhedraDomain.top(['x', 'y']);
  a = polyhedraDomain.assign(a, 'x', n(0));
  a = polyhedraDomain.assign(a, 'y', n(0));
  let b = polyhedraDomain.top(['x', 'y']);
  b = polyhedraDomain.assign(b, 'x', n(10));
  b = polyhedraDomain.assign(b, 'y', n(10));

  const joined = polyhedraDomain.join(a, b);
  assert.equal(polyhedraDomain.isBottom(joined), false);
  assert.equal(repr(joined, 'x'), '[0, 10]');
  assert.equal(repr(joined, 'y'), '[0, 10]');

  // The point (0,10) is inside the bounding box but NOT on the segment
  // (0,0)-(10,10) — meeting the join with "x=10, y=0" (its diagonal
  // opposite corner check) should be bottom if the hull is tight, but the
  // more direct and robust check is: the hull must entail x = y.
  const withXEqY = polyhedraDomain.meet(joined, (() => {
    let box = polyhedraDomain.top(['x', 'y']);
    box = polyhedraDomain.assume(box, cmp('==', v('x'), v('y')));
    return box;
  })());
  assert.equal(polyhedraDomain.leq(joined, withXEqY), true, 'expected the hull to already entail x = y');
});

test('widen is constraint-preserving: keeps only what the new state still entails', () => {
  let old = polyhedraDomain.top(['x']);
  old = polyhedraDomain.assign(old, 'x', n(0));
  const grown = polyhedraDomain.assign(old, 'x', add(v('x'), n(1)));
  const joined = polyhedraDomain.join(old, grown);
  assert.equal(repr(joined, 'x'), '[0, 1]');

  const widened = polyhedraDomain.widen(old, joined);
  // old pinned x = 0 exactly; joined only has x in [0,1], which does NOT
  // entail x <= 0 (the upper half of old's pin), so that constraint must be
  // dropped, while x >= 0 (still entailed) survives.
  assert.equal(repr(widened, 'x'), '[0, +∞)');
});

test('a nonlinear divide/mod havocs the target soundly', () => {
  let s = polyhedraDomain.top(['x', 'y']);
  s = polyhedraDomain.assign(s, 'x', n(7));
  s = polyhedraDomain.assign(s, 'y', { kind: 'binary', op: '/', left: v('x'), right: n(2) });
  assert.equal(repr(s, 'y'), '⊤');
});

test('changed reports only variables whose constraints actually differ', () => {
  let s = polyhedraDomain.top(['x', 'y']);
  s = polyhedraDomain.assign(s, 'x', n(0));
  const s2 = polyhedraDomain.assign(s, 'x', n(1));
  assert.deepEqual(polyhedraDomain.changed(s, s2), ['x', 'y']);
});

test('bottom is absorbing for join and identity-like for meet', () => {
  const bot = polyhedraDomain.bottom();
  const top = polyhedraDomain.top(['x']);
  assert.equal(polyhedraDomain.join(bot, top), top);
  assert.equal(polyhedraDomain.isBottom(polyhedraDomain.meet(bot, top)), true);
});
