import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asLinearForm, difference } from '../relational/linear.js';
import type { Expr } from '../ir.js';

const v = (name: string): Expr => ({ kind: 'var', name });
const n = (value: number): Expr => ({ kind: 'const', value });
const add = (l: Expr, r: Expr): Expr => ({ kind: 'binary', op: '+', left: l, right: r });
const sub = (l: Expr, r: Expr): Expr => ({ kind: 'binary', op: '-', left: l, right: r });
const mul = (l: Expr, r: Expr): Expr => ({ kind: 'binary', op: '*', left: l, right: r });
const neg = (e: Expr): Expr => ({ kind: 'neg', operand: e });

test('a bare constant parses with no terms', () => {
  assert.deepEqual(asLinearForm(n(5)), { terms: [], constant: 5 });
});

test('a bare variable parses as a single +1 term', () => {
  assert.deepEqual(asLinearForm(v('x')), { terms: [['x', 1]], constant: 0 });
});

test('x + 3 keeps the term and the constant', () => {
  assert.deepEqual(asLinearForm(add(v('x'), n(3))), { terms: [['x', 1]], constant: 3 });
});

test('negation flips the coefficient and the constant', () => {
  assert.deepEqual(asLinearForm(neg(add(v('x'), n(3)))), { terms: [['x', -1]], constant: -3 });
});

test('x - y is a two-variable form with opposite coefficients', () => {
  const f = asLinearForm(sub(v('x'), v('y')));
  assert.deepEqual(f, {
    terms: [
      ['x', 1],
      ['y', -1],
    ],
    constant: 0,
  });
});

test('x + y is a two-variable form with matching coefficients', () => {
  const f = asLinearForm(add(v('x'), v('y')));
  assert.deepEqual(f, {
    terms: [
      ['x', 1],
      ['y', 1],
    ],
    constant: 0,
  });
});

test('x + x has coefficient 2 — not representable, correctly fails to parse', () => {
  assert.equal(asLinearForm(add(v('x'), v('x'))), undefined);
});

test('x - x cancels to a bare constant', () => {
  assert.deepEqual(asLinearForm(sub(v('x'), v('x'))), { terms: [], constant: 0 });
});

test('three distinct variables exceed what Zones/Octagons can hold', () => {
  assert.equal(asLinearForm(add(add(v('x'), v('y')), v('z'))), undefined);
});

test('multiplication is not affine and fails to parse', () => {
  assert.equal(asLinearForm(mul(v('x'), v('y'))), undefined);
  assert.equal(asLinearForm(mul(v('x'), n(2))), undefined);
});

test('difference(x, y) matches x - y', () => {
  assert.deepEqual(difference(v('x'), v('y')), asLinearForm(sub(v('x'), v('y'))));
});

test('difference(x, 5) is a single-variable bound', () => {
  assert.deepEqual(difference(v('x'), n(5)), { terms: [['x', 1]], constant: -5 });
});

test('difference fails when either side is nonlinear', () => {
  assert.equal(difference(mul(v('x'), v('y')), n(0)), undefined);
});
