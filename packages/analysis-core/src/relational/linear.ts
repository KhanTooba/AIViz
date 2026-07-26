/**
 * Normalizes an `Expr` into an affine form over at most two variables with
 * ±1 coefficients: `±x ± y + c`. This is the exact shape Zones and Octagons
 * can represent (a difference or a sum of two variables, plus a constant);
 * anything that doesn't reduce to this shape — a coefficient other than ±1,
 * more than two distinct variables, any nonlinear operator — correctly fails
 * to parse, and callers fall back to a sound-but-imprecise havoc.
 *
 * Domain-agnostic on purpose: Zones and Octagons differ in *which* resulting
 * shapes they can act on exactly (Zones only differences, Octagons both
 * differences and sums), so that decision lives in each domain, not here.
 */

import type { Expr } from '../ir.js';

export interface LinearForm {
  /** At most two entries, one per distinct variable, coefficient ±1. */
  terms: [name: string, coeff: 1 | -1][];
  constant: number;
}

function negateForm(f: LinearForm): LinearForm {
  return {
    terms: f.terms.map(([name, c]) => [name, (-c) as 1 | -1]),
    constant: -f.constant,
  };
}

/** Combines two forms as `a + sign·b`, merging same-named terms and failing
 * if a coefficient other than ±1 or more than two variables results. */
function combine(a: LinearForm, b: LinearForm, sign: 1 | -1): LinearForm | undefined {
  const coeffs = new Map<string, number>();
  for (const [name, c] of a.terms) coeffs.set(name, (coeffs.get(name) ?? 0) + c);
  for (const [name, c] of b.terms) coeffs.set(name, (coeffs.get(name) ?? 0) + sign * c);

  const terms: [string, 1 | -1][] = [];
  for (const [name, c] of coeffs) {
    if (c === 0) continue; // cancelled out — fine, just drop it
    if (c !== 1 && c !== -1) return undefined; // e.g. `x + x` has coefficient 2 — not representable
    terms.push([name, c]);
  }
  if (terms.length > 2) return undefined; // relates more variables than Zones/Octagons can hold

  return { terms, constant: a.constant + sign * b.constant };
}

export function asLinearForm(e: Expr): LinearForm | undefined {
  switch (e.kind) {
    case 'const':
      return { terms: [], constant: e.value };
    case 'var':
      return { terms: [[e.name, 1]], constant: 0 };
    case 'neg': {
      const inner = asLinearForm(e.operand);
      return inner ? negateForm(inner) : undefined;
    }
    case 'binary': {
      if (e.op !== '+' && e.op !== '-') return undefined; // *, /, % are not affine
      const l = asLinearForm(e.left);
      const r = asLinearForm(e.right);
      if (!l || !r) return undefined;
      return combine(l, r, e.op === '+' ? 1 : -1);
    }
    case 'nondet':
      return undefined;
  }
}

/** `left - right` as a single normalized form — the natural way to read a
 * comparison `left op right` as `(left - right) op 0`. */
export function difference(left: Expr, right: Expr): LinearForm | undefined {
  const l = asLinearForm(left);
  const r = asLinearForm(right);
  if (!l || !r) return undefined;
  return combine(l, r, -1);
}
