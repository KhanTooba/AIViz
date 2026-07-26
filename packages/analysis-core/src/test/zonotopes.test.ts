import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zonotopesDomain, type ZonoEnv } from '../domains/zonotopes.js';
import type { CmpOp, Cond, Expr } from '../ir.js';

const v = (name: string): Expr => ({ kind: 'var', name });
const n = (value: number): Expr => ({ kind: 'const', value });
const add = (l: Expr, r: Expr): Expr => ({ kind: 'binary', op: '+', left: l, right: r });
const mul = (l: Expr, r: Expr): Expr => ({ kind: 'binary', op: '*', left: l, right: r });
const cmp = (op: CmpOp, l: Expr, r: Expr): Cond => ({ kind: 'cmp', op, left: l, right: r });

function repr(s: ZonoEnv, name: string): string | undefined {
  return zonotopesDomain.format(s).vars.find((x) => x.name === name)?.repr;
}
function constraintsOf(s: ZonoEnv): string[] {
  return zonotopesDomain.format(s).constraints ?? [];
}

test('top gives every variable ⊤ and no constraints', () => {
  const s = zonotopesDomain.top(['x', 'y']);
  assert.equal(repr(s, 'x'), '⊤');
  assert.deepEqual(constraintsOf(s), []);
});

test('x := 5 pins x exactly, no spurious relation', () => {
  let s = zonotopesDomain.top(['x']);
  s = zonotopesDomain.assign(s, 'x', n(5));
  assert.equal(repr(s, 'x'), '[5, 5]');
  assert.deepEqual(constraintsOf(s), []);
});

test('y := 2*x + 3 is exact with an arbitrary (non ±1) coefficient', () => {
  // Zones/Octagons are restricted to ±1 coefficients by their matrix shape;
  // Zonotopes' affine-form representation has no such restriction.
  let s = zonotopesDomain.top(['x', 'y']);
  s = zonotopesDomain.assign(s, 'x', n(5));
  s = zonotopesDomain.assign(s, 'y', add(mul(n(2), v('x')), n(3)));
  assert.equal(repr(s, 'y'), '[13, 13]');
});

test('assume single-variable bound: x < 10 tightens x, leaves y alone', () => {
  let s = zonotopesDomain.top(['x', 'y']);
  s = zonotopesDomain.assume(s, cmp('<', v('x'), n(10)));
  assert.equal(repr(s, 'x'), '(-∞, 9]');
  assert.equal(repr(s, 'y'), '⊤');
});

test('an unsatisfiable guard yields bottom', () => {
  let s = zonotopesDomain.top(['x']);
  s = zonotopesDomain.assign(s, 'x', n(5));
  s = zonotopesDomain.assume(s, cmp('>', v('x'), n(10)));
  assert.equal(zonotopesDomain.isBottom(s), true);
});

test('a sum guard (x + y < 10) is a sound no-op — no natural half-space intersection', () => {
  let s = zonotopesDomain.top(['x', 'y']);
  s = zonotopesDomain.assume(s, cmp('<', add(v('x'), v('y')), n(10)));
  assert.equal(repr(s, 'x'), '⊤');
  assert.equal(repr(s, 'y'), '⊤');
});

test('nonlinear x*x is a sound (if not perfectly tight) enclosure', () => {
  let s = zonotopesDomain.top(['x', 'y']);
  s = zonotopesDomain.assume(s, cmp('>=', v('x'), n(2)));
  s = zonotopesDomain.assume(s, cmp('<=', v('x'), n(5)));
  s = zonotopesDomain.assign(s, 'y', mul(v('x'), v('x')));
  // x in [2,5] => x*x in [4,25] at the true extremes; the affine-arithmetic
  // approximation must at least contain that range, though it need not be
  // exactly that tight.
  const yRepr = repr(s, 'y');
  const match = /\[(-?\d+), (\d+)\]/.exec(yRepr ?? '');
  assert.ok(match, `expected a bounded interval for y, got ${yRepr}`);
  const lo = Number(match![1]);
  const hi = Number(match![2]);
  assert.ok(lo <= 4, `expected lo <= 4, got ${lo}`);
  assert.ok(hi >= 25, `expected hi >= 25, got ${hi}`);
});

test('meet of x<=5 and x>=6 is bottom', () => {
  let a = zonotopesDomain.top(['x']);
  a = zonotopesDomain.assume(a, cmp('<=', v('x'), n(5)));
  let b = zonotopesDomain.top(['x']);
  b = zonotopesDomain.assume(b, cmp('>=', v('x'), n(6)));
  assert.equal(zonotopesDomain.isBottom(zonotopesDomain.meet(a, b)), true);
});

test('flagship: join of two branches keeps y - x correlated via a shared symbol, even though neither is individually precise', () => {
  // Branch A: x = 0, y = x + 5 = 5.  Branch B: x = 10, y = x + 5 = 15.
  // y - x = 5 in *both* branches. After the join, x and y should not just
  // be independently-widened boxes: they should share the same new symbol
  // with matching coefficients, so the correlation "y - x = 5" survives
  // even though x and y are each only known up to a wide range.
  let branchA = zonotopesDomain.top(['x', 'y']);
  branchA = zonotopesDomain.assign(branchA, 'x', n(0));
  branchA = zonotopesDomain.assign(branchA, 'y', add(v('x'), n(5)));

  let branchB = zonotopesDomain.top(['x', 'y']);
  branchB = zonotopesDomain.assign(branchB, 'x', n(10));
  branchB = zonotopesDomain.assign(branchB, 'y', add(v('x'), n(5)));

  const joined = zonotopesDomain.join(branchA, branchB);
  assert.equal(zonotopesDomain.isBottom(joined), false);

  const xRepr = repr(joined, 'x');
  const yRepr = repr(joined, 'y');
  assert.equal(xRepr, '[0, 10]');
  assert.equal(yRepr, '[5, 15]');

  // The payoff: x and y's affine forms must reference the *same* symbol
  // with the *same* coefficient, which is what makes y - x = 5 exact
  // despite neither variable being individually precise.
  const cs = constraintsOf(joined);
  const xForm = cs.find((c) => c.startsWith('x ='));
  const yForm = cs.find((c) => c.startsWith('y ='));
  assert.ok(xForm && yForm, `expected both x and y to carry an affine form, got ${JSON.stringify(cs)}`);
  const xSymbol = /ε(\d+)/.exec(xForm!)?.[1];
  const ySymbol = /ε(\d+)/.exec(yForm!)?.[1];
  assert.ok(xSymbol !== undefined && xSymbol === ySymbol, `expected x and y to share a symbol, got ${JSON.stringify(cs)}`);
});

test('widen jumps only the bound that actually grew, and lossReport names it', () => {
  // x + 2 (not +1) keeps the joined outer range [0,2] an even width, so the
  // join's own integer rounding (see `joinVar`'s doc comment) doesn't
  // introduce an incidental off-by-one that would muddy this test's actual
  // point: only the upper bound moved, so only it should widen.
  let old = zonotopesDomain.top(['x']);
  old = zonotopesDomain.assign(old, 'x', n(0));
  const grown = zonotopesDomain.assign(old, 'x', add(v('x'), n(2)));
  const joined = zonotopesDomain.join(old, grown);
  assert.equal(repr(joined, 'x'), '[0, 2]');

  const widened = zonotopesDomain.widen(old, joined);
  // Only the upper bound moved between old (x=0) and joined (x in [0,2]);
  // the lower bound (0) never changed, so it must survive widening.
  assert.equal(repr(widened, 'x'), '[0, +∞)');

  const loss = zonotopesDomain.lossReport(old, joined, widened);
  assert.ok(loss.length > 0);
  assert.ok(loss.every((l) => l.message.includes('widening discarded it entirely')));
});

test('narrow only refines bounds widening had sent to infinity', () => {
  let old = zonotopesDomain.top(['x']);
  old = zonotopesDomain.assign(old, 'x', n(0));
  const grown = zonotopesDomain.assign(old, 'x', add(v('x'), n(2)));
  const joined = zonotopesDomain.join(old, grown);
  const widened = zonotopesDomain.widen(old, joined);
  assert.equal(repr(widened, 'x'), '[0, +∞)');

  const narrowed = zonotopesDomain.narrow(widened, joined);
  assert.equal(repr(narrowed, 'x'), '[0, 2]');
});

test('changed reports only variables whose value actually differs', () => {
  let s = zonotopesDomain.top(['x', 'y']);
  s = zonotopesDomain.assign(s, 'x', n(0));
  const s2 = zonotopesDomain.assign(s, 'x', n(1));
  assert.deepEqual(zonotopesDomain.changed(s, s2), ['x']);
});

test('bottom is absorbing for join and identity-like for meet', () => {
  const bot = zonotopesDomain.bottom();
  const top = zonotopesDomain.top(['x']);
  assert.equal(zonotopesDomain.join(bot, top), top);
  assert.equal(zonotopesDomain.isBottom(zonotopesDomain.meet(bot, top)), true);
});

test('a nonlinear divide/mod havocs the target soundly', () => {
  let s = zonotopesDomain.top(['x', 'y']);
  s = zonotopesDomain.assign(s, 'x', n(7));
  s = zonotopesDomain.assign(s, 'y', { kind: 'binary', op: '/', left: v('x'), right: n(2) });
  assert.equal(repr(s, 'y'), '⊤');
});

test('leq is reflexive and detects a real fixpoint (structural equality of affine states)', () => {
  let s = zonotopesDomain.top(['x']);
  s = zonotopesDomain.assign(s, 'x', n(5));
  const s2 = zonotopesDomain.assign(zonotopesDomain.top(['x']), 'x', n(5));
  assert.equal(zonotopesDomain.leq(s, s2), true);
  assert.equal(zonotopesDomain.leq(s2, s), true);
});
