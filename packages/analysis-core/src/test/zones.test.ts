import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zonesDomain, type ZoneEnv } from '../domains/zones.js';
import type { CmpOp, Cond, Expr } from '../ir.js';

const v = (name: string): Expr => ({ kind: 'var', name });
const n = (value: number): Expr => ({ kind: 'const', value });
const add = (l: Expr, r: Expr): Expr => ({ kind: 'binary', op: '+', left: l, right: r });
const mul = (l: Expr, r: Expr): Expr => ({ kind: 'binary', op: '*', left: l, right: r });
const cmp = (op: CmpOp, l: Expr, r: Expr): Cond => ({ kind: 'cmp', op, left: l, right: r });

function repr(s: ZoneEnv, name: string): string | undefined {
  return zonesDomain.format(s).vars.find((x) => x.name === name)?.repr;
}
function constraintsOf(s: ZoneEnv): string[] {
  return zonesDomain.format(s).constraints ?? [];
}

test('top gives every variable ⊤ and no constraints', () => {
  const s = zonesDomain.top(['x', 'y']);
  assert.equal(repr(s, 'x'), '⊤');
  assert.equal(repr(s, 'y'), '⊤');
  assert.deepEqual(constraintsOf(s), []);
});

test('x := 5 pins x exactly, no relation to y', () => {
  let s = zonesDomain.top(['x', 'y']);
  s = zonesDomain.assign(s, 'x', n(5));
  assert.equal(repr(s, 'x'), '[5, 5]');
  assert.equal(repr(s, 'y'), '⊤');
});

test('y := x + 5 is exact and creates a real relation, both directions', () => {
  let s = zonesDomain.top(['x', 'y']);
  s = zonesDomain.assign(s, 'x', n(0));
  s = zonesDomain.assign(s, 'y', add(v('x'), n(5)));
  assert.equal(repr(s, 'y'), '[5, 5]');
  const cs = constraintsOf(s);
  assert.ok(cs.some((c) => c.includes('y - x ≤ 5')), `expected y-x≤5 in ${JSON.stringify(cs)}`);
  assert.ok(cs.some((c) => c.includes('x - y ≤ -5')), `expected x-y≤-5 in ${JSON.stringify(cs)}`);
});

test('x := x + y preserves x\'s relation to y, loosened by y\'s own range (the accumulator case)', () => {
  let s = zonesDomain.top(['x', 'y']);
  s = zonesDomain.assign(s, 'x', n(0));
  s = zonesDomain.assume(s, cmp('>=', v('y'), n(0)));
  s = zonesDomain.assume(s, cmp('<=', v('y'), n(3)));
  // x := x + y, with y ∈ [0, 3] and x = 0 beforehand.
  s = zonesDomain.assign(s, 'x', add(v('x'), v('y')));
  assert.equal(repr(s, 'x'), '[0, 3]');
  const cs = constraintsOf(s);
  // The relation to y must survive: x ≤ y (since x = old_x + y = 0 + y = y here).
  assert.ok(cs.length > 0, 'expected a surviving relation between x and y, not a full havoc');
});

test('assume single-variable bound: x < 10 tightens x, leaves y alone', () => {
  let s = zonesDomain.top(['x', 'y']);
  s = zonesDomain.assume(s, cmp('<', v('x'), n(10)));
  assert.equal(repr(s, 'x'), '(-∞, 9]');
  assert.equal(repr(s, 'y'), '⊤');
});

test('assume a genuine difference guard: x < y is exact', () => {
  let s = zonesDomain.top(['x', 'y']);
  s = zonesDomain.assume(s, cmp('<', v('x'), v('y')));
  const cs = constraintsOf(s);
  assert.ok(cs.some((c) => c.includes('x - y ≤ -1')), `expected x-y≤-1 in ${JSON.stringify(cs)}`);
});

test('an unsatisfiable guard yields bottom', () => {
  let s = zonesDomain.top(['x']);
  s = zonesDomain.assign(s, 'x', n(5));
  s = zonesDomain.assume(s, cmp('>', v('x'), n(10))); // 5 > 10 is impossible
  assert.equal(zonesDomain.isBottom(s), true);
});

test('a sum guard (x + y < 10) is not representable in Zones — sound no-op, not wrong', () => {
  let s = zonesDomain.top(['x', 'y']);
  const before = zonesDomain.format(s);
  s = zonesDomain.assume(s, cmp('<', add(v('x'), v('y')), n(10)));
  assert.deepEqual(zonesDomain.format(s), before, 'a sum guard must leave Zones unchanged, not guess');
});

test('a nonlinear assignment (x := y * z) havocs x soundly', () => {
  let s = zonesDomain.top(['x', 'y', 'z']);
  s = zonesDomain.assign(s, 'y', n(3));
  s = zonesDomain.assign(s, 'x', mul(v('y'), v('z')));
  assert.equal(repr(s, 'x'), '⊤');
  assert.equal(repr(s, 'y'), '[3, 3]', 'unrelated variables must not be disturbed');
});

test('x := -y is not exact in Zones (needs reflection): falls back to a sound interval bound', () => {
  let s = zonesDomain.top(['x', 'y']);
  s = zonesDomain.assign(s, 'y', n(4));
  s = zonesDomain.assign(s, 'x', { kind: 'neg', operand: v('y') });
  assert.equal(repr(s, 'x'), '[-4, -4]', 'the VALUE is still exactly right via the interval fallback');
});

test('join of two exact constants is their smallest containing interval, and drops the tighter relation', () => {
  let a = zonesDomain.top(['x']);
  a = zonesDomain.assign(a, 'x', n(0));
  let b = zonesDomain.top(['x']);
  b = zonesDomain.assign(b, 'x', n(5));
  const j = zonesDomain.join(a, b);
  assert.equal(repr(j, 'x'), '[0, 5]');
});

test('meet of x≤5 and x≥6 is bottom', () => {
  let s = zonesDomain.top(['x']);
  s = zonesDomain.assume(s, cmp('<=', v('x'), n(5)));
  let s2 = zonesDomain.top(['x']);
  s2 = zonesDomain.assume(s2, cmp('>=', v('x'), n(6)));
  assert.equal(zonesDomain.isBottom(zonesDomain.meet(s, s2)), true);
});

test('changed reports only variables whose relations actually differ', () => {
  let s = zonesDomain.top(['x', 'y']);
  s = zonesDomain.assign(s, 'x', n(0));
  const s2 = zonesDomain.assign(s, 'x', n(1));
  const diff = zonesDomain.changed(s, s2);
  assert.deepEqual(diff, ['x']);
});

test('bottom is absorbing for join and identity-like for meet', () => {
  const bot = zonesDomain.bottom();
  const top = zonesDomain.top(['x']);
  assert.equal(zonesDomain.join(bot, top), top);
  assert.equal(zonesDomain.isBottom(zonesDomain.meet(bot, top)), true);
});

test('subst x := x + 1 in a loop keeps widening honest: lossReport names the relation', () => {
  let old = zonesDomain.top(['x', 'y']);
  old = zonesDomain.assign(old, 'x', n(0));
  old = zonesDomain.assign(old, 'y', n(0));
  let grown = zonesDomain.assign(old, 'x', add(v('x'), n(1)));
  const joined = zonesDomain.join(old, grown);
  const widened = zonesDomain.widen(old, joined);
  const loss = zonesDomain.lossReport(old, joined, widened);
  assert.ok(loss.length > 0, 'expected reported loss when a bound actually grew');
  assert.ok(loss.every((l) => l.message.includes('widening discards it entirely')));
});
