/**
 * Normalizes an `Expr` into `constant + Σ coeff·var` with arbitrary integer
 * coefficients over any number of distinct variables — unlike
 * `relational/linear.ts`'s `asLinearForm`, which is deliberately capped at
 * two variables with ±1 coefficients (the exact shape Zones/Octagons' DBM
 * cells can hold). Zonotopes and Polyhedra both use this instead, since
 * neither representation is matrix-shaped that way.
 *
 * A product of two variable-carrying subexpressions correctly fails here —
 * it needs the operands' actual values, not just their syntactic shape, so
 * each domain handles it separately.
 */

import type { Expr } from '../ir.js';

export interface AffineTerms {
  readonly terms: ReadonlyMap<string, number>;
  readonly constant: number;
}

function scaleTerms(t: AffineTerms, k: number): AffineTerms {
  const terms = new Map<string, number>();
  for (const [name, c] of t.terms) terms.set(name, c * k);
  return { terms, constant: t.constant * k };
}

function combineTerms(a: AffineTerms, b: AffineTerms, sign: 1 | -1): AffineTerms {
  const terms = new Map(a.terms);
  for (const [name, c] of b.terms) {
    const nc = (terms.get(name) ?? 0) + sign * c;
    if (nc === 0) terms.delete(name);
    else terms.set(name, nc);
  }
  return { terms, constant: a.constant + sign * b.constant };
}

export function asAffineExpr(e: Expr): AffineTerms | undefined {
  switch (e.kind) {
    case 'const':
      return { terms: new Map(), constant: e.value };
    case 'var':
      return { terms: new Map([[e.name, 1]]), constant: 0 };
    case 'neg': {
      const inner = asAffineExpr(e.operand);
      return inner ? scaleTerms(inner, -1) : undefined;
    }
    case 'binary': {
      if (e.op === '+' || e.op === '-') {
        const l = asAffineExpr(e.left);
        const r = asAffineExpr(e.right);
        if (!l || !r) return undefined;
        return combineTerms(l, r, e.op === '+' ? 1 : -1);
      }
      if (e.op === '*') {
        const l = asAffineExpr(e.left);
        const r = asAffineExpr(e.right);
        if (!l || !r) return undefined;
        if (l.terms.size === 0) return scaleTerms(r, l.constant);
        if (r.terms.size === 0) return scaleTerms(l, r.constant);
        return undefined; // both sides reference variables — genuinely nonlinear
      }
      return undefined; // /, % are not affine
    }
    case 'nondet':
      return undefined;
  }
}
