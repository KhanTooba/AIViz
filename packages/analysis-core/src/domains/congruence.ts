/**
 * The congruence domain: values of the form `residue + modulus·ℤ`.
 *
 * `modulus === 0` is the convention for an exact constant (a class with a
 * single element); `modulus === 1` is ⊤ (every residue is congruent mod 1).
 * This is an infinite lattice — moduli can shrink toward 1 without any fixed
 * bound — so unlike Sign and Parity it needs a real widening operator, and
 * its widening is deliberately much coarser than intervals': the moment a
 * loop's value stops being congruent to what it was, this domain gives up
 * entirely and jumps to ⊤, rather than trying to find a coarser common
 * modulus. That contrast — "widening is not one universal algorithm, some
 * domains are far blunter about it than others" — is the whole reason this
 * domain is worth having alongside Intervals.
 */

import { NonRelationalDomain, type ValueLattice, type HasseDiagram } from '../domain.js';
import type { CmpOp } from '../ir.js';

export type Congruence =
  | { readonly kind: 'bottom' }
  | { readonly kind: 'cong'; readonly modulus: number; readonly residue: number };

const BOT: Congruence = { kind: 'bottom' };
const TOP: Congruence = { kind: 'cong', modulus: 1, residue: 0 };

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** Euclidean gcd, with the standard convention gcd(0, n) = |n|. */
function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}
const gcd3 = (a: number, b: number, c: number): number => gcd(gcd(a, b), c);

/** Extended Euclidean algorithm: returns [g, x, y] with a·x + b·y = g. */
function extgcd(a: number, b: number): [number, number, number] {
  if (b === 0) return [a, 1, 0];
  const [g, x1, y1] = extgcd(b, a % b);
  return [g, y1, x1 - Math.floor(a / b) * y1];
}

/** Builds a class, normalising the residue into `[0, modulus)` when modulus > 0. */
function mk(modulus: number, residue: number): Congruence {
  return modulus === 0
    ? { kind: 'cong', modulus: 0, residue }
    : { kind: 'cong', modulus, residue: mod(residue, modulus) };
}

function isBot(v: Congruence): v is { readonly kind: 'bottom' } {
  return v.kind === 'bottom';
}

/**
 * Solves `x ≡ r1 (mod m1)`, `x ≡ r2 (mod m2)` for possibly non-coprime moduli
 * via the general Chinese Remainder Theorem. Returns `undefined` when the two
 * classes are disjoint (no such `x` exists).
 */
function crt(m1: number, r1: number, m2: number, r2: number): Congruence | undefined {
  const g = gcd(m1, m2);
  if (mod(r1 - r2, g) !== 0) return undefined;
  const lcm = (m1 / g) * m2;
  const [, p] = extgcd(m1 / g, m2 / g);
  const t = mod(((r2 - r1) / g) * p, m2 / g);
  return mk(lcm, r1 + m1 * t);
}

function meetC(a: Congruence, b: Congruence): Congruence {
  if (isBot(a) || isBot(b)) return BOT;
  if (a.modulus === 0 && b.modulus === 0) {
    return a.residue === b.residue ? a : BOT;
  }
  // Exactly one of a, b is exact here (both-exact was handled above). An
  // exact value is the more precise operand, so keep it if it is consistent
  // with the other's congruence class, rather than losing precision to CRT.
  if (a.modulus === 0) return mod(a.residue, b.modulus) === mod(b.residue, b.modulus) ? a : BOT;
  if (b.modulus === 0) return meetC(b, a);
  const result = crt(a.modulus, a.residue, b.modulus, b.residue);
  return result ?? BOT;
}

export const congruenceLattice: ValueLattice<Congruence> = {
  id: 'congruence',
  name: 'Congruence',
  finiteLattice: false,

  bottom: BOT,
  top: TOP,

  isBottom: isBot,
  isTop: (v) => v.kind === 'cong' && v.modulus === 1,
  equal: (a, b) =>
    (isBot(a) && isBot(b)) ||
    (!isBot(a) && !isBot(b) && a.modulus === b.modulus && a.residue === b.residue),

  leq(a, b) {
    if (isBot(a)) return true;
    if (isBot(b)) return false;
    if (b.modulus === 0) return a.modulus === 0 && a.residue === b.residue;
    if (a.modulus === 0) return mod(a.residue, b.modulus) === mod(b.residue, b.modulus);
    return a.modulus % b.modulus === 0 && mod(a.residue, b.modulus) === mod(b.residue, b.modulus);
  },

  join(a, b) {
    if (isBot(a)) return b;
    if (isBot(b)) return a;
    const g = gcd3(a.modulus, b.modulus, a.residue - b.residue);
    if (g === 0) return a; // both exact and equal — gcd(0,0,0) only when residues match
    return mk(g, a.residue);
  },

  meet: meetC,

  // Moduli have no fixed lower bound of interest here: rather than search for
  // a coarser common modulus (an intervals-style "push the growing bound to
  // infinity" strategy has no direct analogue for congruences), this domain
  // simply gives up and jumps to ⊤ the moment the value changes between
  // iterations. Two iterations is always enough to reach a fixed point.
  widen(a, b) {
    if (isBot(a)) return b;
    if (isBot(b)) return a;
    return congruenceLattice.equal(a, b) ? a : TOP;
  },

  // Once widening has given up to ⊤, narrowing adopts whatever the next real
  // join computes — recovering exactly the precision the coarse widen threw away.
  narrow(a, b) {
    if (isBot(a) || isBot(b)) return BOT;
    return congruenceLattice.isTop(a) ? b : a;
  },

  constant: (n) => mk(0, n),

  add(a, b) {
    if (isBot(a) || isBot(b)) return BOT;
    return mk(gcd(a.modulus, b.modulus), a.residue + b.residue);
  },
  sub(a, b) {
    if (isBot(a) || isBot(b)) return BOT;
    return mk(gcd(a.modulus, b.modulus), a.residue - b.residue);
  },
  // Sound over-approximation of the product of two congruence classes
  // (Granger's formula): the result modulus is the gcd of the three ways the
  // moduli can contribute, and the residue is just the product of residues.
  mul(a, b) {
    if (isBot(a) || isBot(b)) return BOT;
    const g = gcd3(a.modulus * b.modulus, a.modulus * b.residue, b.modulus * a.residue);
    return mk(g, a.residue * b.residue);
  },
  // Division and modulo do not preserve congruence structure in general —
  // only the exact/exact case is precise; everything else falls back to ⊤.
  div(a, b) {
    if (isBot(a) || isBot(b)) return BOT;
    if (a.modulus === 0 && b.modulus === 0) {
      return b.residue === 0 ? TOP : mk(0, Math.trunc(a.residue / b.residue));
    }
    return TOP;
  },
  mod(a, b) {
    if (isBot(a) || isBot(b)) return BOT;
    if (a.modulus === 0 && b.modulus === 0) {
      return b.residue === 0 ? TOP : mk(0, a.residue % b.residue);
    }
    return TOP;
  },
  neg: (a) => (isBot(a) ? BOT : mk(a.modulus, -a.residue)),

  refine(op: CmpOp, a: Congruence, b: Congruence): Congruence {
    if (isBot(a) || isBot(b)) return BOT;
    // Only equality relates two congruence classes soundly; the others carry
    // no periodicity information (x < y says nothing about x's residue).
    if (op === '==') return meetC(a, b);
    return a;
  },

  format(v) {
    if (isBot(v)) return { repr: '⊥', kind: 'bottom' };
    if (v.modulus === 1) return { repr: '⊤', kind: 'top' };
    if (v.modulus === 0) return { repr: String(v.residue), kind: 'value' };
    return { repr: `${v.residue} + ${v.modulus}ℤ`, kind: 'value' };
  },

  describeLoss(old, joined, widened) {
    if (congruenceLattice.equal(joined, widened)) return undefined;
    return {
      lostBound: 'both',
      message:
        `The value changed from ${congruenceLattice.format(old).repr} to ` +
        `${congruenceLattice.format(joined).repr} between iterations. This domain does ` +
        `not search for a coarser common modulus the way intervals push a growing bound ` +
        `to infinity — it simply discards all congruence information and jumps to ⊤. ` +
        `That is a much blunter widening than intervals uses, and it is a property of ` +
        `this domain, not a universal rule about widening.`,
    };
  },

  // Infinite lattice — no finite Hasse diagram exists (moduli range over all
  // positive integers). The client falls back to the ascending chain view.
  latticeGraph(): HasseDiagram | undefined {
    return undefined;
  },
};

export const congruenceDomain = new NonRelationalDomain(congruenceLattice);
