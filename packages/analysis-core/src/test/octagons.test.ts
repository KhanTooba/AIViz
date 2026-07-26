import { test } from 'node:test';
import assert from 'node:assert/strict';
import { octagonsDomain, type OctEnv } from '../domains/octagons.js';
import type { CmpOp, Cond, Expr } from '../ir.js';

const v = (name: string): Expr => ({ kind: 'var', name });
const n = (value: number): Expr => ({ kind: 'const', value });
const add = (l: Expr, r: Expr): Expr => ({ kind: 'binary', op: '+', left: l, right: r });
const sub = (l: Expr, r: Expr): Expr => ({ kind: 'binary', op: '-', left: l, right: r });
const neg = (e: Expr): Expr => ({ kind: 'neg', operand: e });
const cmp = (op: CmpOp, l: Expr, r: Expr): Cond => ({ kind: 'cmp', op, left: l, right: r });

function repr(s: OctEnv, name: string): string | undefined {
  return octagonsDomain.format(s).vars.find((x) => x.name === name)?.repr;
}
function constraintsOf(s: OctEnv): string[] {
  return octagonsDomain.format(s).constraints ?? [];
}

test('top gives every variable ⊤ and no constraints', () => {
  const s = octagonsDomain.top(['x', 'y']);
  assert.equal(repr(s, 'x'), '⊤');
  assert.deepEqual(constraintsOf(s), []);
});

test('x := 5 pins x exactly', () => {
  let s = octagonsDomain.top(['x']);
  s = octagonsDomain.assign(s, 'x', n(5));
  assert.equal(repr(s, 'x'), '[5, 5]');
});

test('y := x + 5 is exact, both directions', () => {
  let s = octagonsDomain.top(['x', 'y']);
  s = octagonsDomain.assign(s, 'x', n(0));
  s = octagonsDomain.assign(s, 'y', add(v('x'), n(5)));
  assert.equal(repr(s, 'y'), '[5, 5]');
  const cs = constraintsOf(s);
  assert.ok(cs.some((c) => c.includes('y - x ≤ 5')));
});

test('x := -y is exact in Octagons — unlike Zones, no fallback needed', () => {
  let s = octagonsDomain.top(['x', 'y']);
  s = octagonsDomain.assume(s, cmp('>=', v('y'), n(2)));
  s = octagonsDomain.assume(s, cmp('<=', v('y'), n(5)));
  s = octagonsDomain.assign(s, 'x', neg(v('y')));
  // y ∈ [2,5] ⟹ x = -y ∈ [-5,-2], AND the relation x+y=0 must survive.
  assert.equal(repr(s, 'x'), '[-5, -2]');
  const cs = constraintsOf(s);
  assert.ok(
    cs.some((c) => c.includes('x + y ≤ 0')),
    `expected the exact relation x+y≤0 to survive, got ${JSON.stringify(cs)}`
  );
});

test('a sum guard (x + y < 10) is exact in Octagons — unlike Zones', () => {
  let s = octagonsDomain.top(['x', 'y']);
  s = octagonsDomain.assume(s, cmp('<', add(v('x'), v('y')), n(10)));
  const cs = constraintsOf(s);
  assert.ok(
    cs.some((c) => c.includes('x + y ≤ 9')),
    `expected x+y≤9, got ${JSON.stringify(cs)}`
  );
});

test('strong closure: x-y≤3 and x+y≤3 together must derive x≤3 (plain closure alone cannot)', () => {
  // This is the textbook example strong closure exists for: neither
  // constraint alone gives a bound on x, but averaging them does, and that
  // requires recognizing that y's two potentials (+y, -y) are coupled.
  let s = octagonsDomain.top(['x', 'y']);
  s = octagonsDomain.assume(s, cmp('<=', sub(v('x'), v('y')), n(3)));
  s = octagonsDomain.assume(s, cmp('<=', add(v('x'), v('y')), n(3)));
  const x = repr(s, 'x');
  assert.equal(x, '(-∞, 3]', `expected strong closure to derive x≤3, got x=${x}`);
});

test('x := x + y preserves the relation to y (the accumulator case), same as Zones', () => {
  let s = octagonsDomain.top(['x', 'y']);
  s = octagonsDomain.assign(s, 'x', n(0));
  s = octagonsDomain.assume(s, cmp('>=', v('y'), n(0)));
  s = octagonsDomain.assume(s, cmp('<=', v('y'), n(3)));
  s = octagonsDomain.assign(s, 'x', add(v('x'), v('y')));
  assert.equal(repr(s, 'x'), '[0, 3]');
  assert.ok(constraintsOf(s).length > 0);
});

test('an unsatisfiable guard yields bottom', () => {
  let s = octagonsDomain.top(['x']);
  s = octagonsDomain.assign(s, 'x', n(5));
  s = octagonsDomain.assume(s, cmp('>', v('x'), n(10)));
  assert.equal(octagonsDomain.isBottom(s), true);
});

test('meet of x≤5 and x≥6 is bottom', () => {
  let a = octagonsDomain.top(['x']);
  a = octagonsDomain.assume(a, cmp('<=', v('x'), n(5)));
  let b = octagonsDomain.top(['x']);
  b = octagonsDomain.assume(b, cmp('>=', v('x'), n(6)));
  assert.equal(octagonsDomain.isBottom(octagonsDomain.meet(a, b)), true);
});

test('join of two exact constants is their smallest containing interval', () => {
  let a = octagonsDomain.top(['x']);
  a = octagonsDomain.assign(a, 'x', n(0));
  let b = octagonsDomain.top(['x']);
  b = octagonsDomain.assign(b, 'x', n(5));
  assert.equal(repr(octagonsDomain.join(a, b), 'x'), '[0, 5]');
});

test('widen jumps a growing self-bound to +∞, keeping the lower bound that never moved', () => {
  let old = octagonsDomain.top(['x']);
  old = octagonsDomain.assign(old, 'x', n(0));
  const grown = octagonsDomain.assign(old, 'x', add(v('x'), n(1)));
  const joined = octagonsDomain.join(old, grown);
  // joined = [0,1]: the lower bound (0) never changed between old and
  // joined, only the upper bound grew (0 -> 1) — so widening only discards
  // the upper bound, giving [0, +infinity), not top.
  const widened = octagonsDomain.widen(old, joined);
  assert.equal(repr(widened, 'x'), '[0, +∞)');
  const loss = octagonsDomain.lossReport(old, joined, widened);
  assert.ok(loss.length > 0);
  assert.ok(loss.some((l) => l.name.includes('upper bound')));
  assert.ok(loss.every((l) => l.message.includes('widening discards it entirely')));
});

test('a strict comparison correctly steps by 1 on the real variable, not the doubled cell', () => {
  // Regression check for the ±2-vs-±1 self-bound bug caught during review:
  // x < 10 must give x ≤ 9 exactly, not an off-by-one from the doubling.
  let s = octagonsDomain.top(['x']);
  s = octagonsDomain.assume(s, cmp('<', v('x'), n(10)));
  assert.equal(repr(s, 'x'), '(-∞, 9]');
  let t = octagonsDomain.top(['x']);
  t = octagonsDomain.assume(t, cmp('>', v('x'), n(10)));
  assert.equal(repr(t, 'x'), '[11, +∞)');
});

test('changed reports only variables whose relations actually differ', () => {
  let s = octagonsDomain.top(['x', 'y']);
  s = octagonsDomain.assign(s, 'x', n(0));
  const s2 = octagonsDomain.assign(s, 'x', n(1));
  assert.deepEqual(octagonsDomain.changed(s, s2), ['x']);
});

test('bottom is absorbing for join and identity-like for meet', () => {
  const bot = octagonsDomain.bottom();
  const top = octagonsDomain.top(['x']);
  assert.equal(octagonsDomain.join(bot, top), top);
  assert.equal(octagonsDomain.isBottom(octagonsDomain.meet(bot, top)), true);
});
