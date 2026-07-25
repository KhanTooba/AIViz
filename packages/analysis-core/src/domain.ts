/**
 * The abstract domain interface, plus a non-relational base implementation.
 *
 * Sign, Intervals and Constant Propagation are all non-relational: they track
 * each variable independently. `NonRelationalDomain` lifts a per-value lattice
 * to a per-environment one, so each concrete domain only has to implement the
 * value-level operations. A relational domain (octagons, polyhedra) would
 * implement `Domain` directly instead.
 */

import type { DisplayState, LossItem, VarValue } from '@aiviz/trace-protocol';
import { type CmpOp, type Cond, type Expr, negate } from './ir.js';

export interface HasseNode {
  id: string;
  label: string;
}

export interface HasseDiagram {
  nodes: HasseNode[];
  /** `[lower, upper]` covering pairs, drawn bottom-to-top. */
  edges: [string, string][];
}

export interface Domain<T> {
  readonly id: string;
  readonly name: string;
  readonly finiteLattice: boolean;

  bottom(): T;
  top(vars: readonly string[]): T;
  isBottom(s: T): boolean;

  leq(a: T, b: T): boolean;
  join(a: T, b: T): T;
  meet(a: T, b: T): T;
  widen(a: T, b: T): T;
  narrow(a: T, b: T): T;

  assign(s: T, target: string, expr: Expr): T;
  assume(s: T, cond: Cond): T;

  format(s: T): DisplayState;
  /** Which variables differ between two states. Drives the changed-var highlight. */
  changed(a: T, b: T): string[];
  /** What widening discarded, given the plain-join result for comparison. */
  lossReport(old: T, joined: T, widened: T): LossItem[];

  /** Finite lattices only; infinite ones return undefined and the UI plots the
   * ascending chain actually traversed instead. */
  latticeGraph?(): HasseDiagram | undefined;
  /** Domain-specific value lookup used by the lattice view. */
  valueOf?(s: T, variable: string): string | undefined;
}

/** A lattice over individual values, from which a full domain is derived. */
export interface ValueLattice<V> {
  readonly id: string;
  readonly name: string;
  readonly finiteLattice: boolean;

  readonly bottom: V;
  readonly top: V;
  isBottom(v: V): boolean;
  isTop(v: V): boolean;
  equal(a: V, b: V): boolean;
  leq(a: V, b: V): boolean;
  join(a: V, b: V): V;
  meet(a: V, b: V): V;
  widen(a: V, b: V): V;
  narrow(a: V, b: V): V;

  constant(n: number): V;
  add(a: V, b: V): V;
  sub(a: V, b: V): V;
  mul(a: V, b: V): V;
  div(a: V, b: V): V;
  mod(a: V, b: V): V;
  neg(a: V): V;

  /** Refine `a` under the assumption that `a op b` holds. */
  refine(op: CmpOp, a: V, b: V): V;

  format(v: V): { repr: string; kind: VarValue['kind'] };
  /** Explains what widening gave up, or undefined if nothing was lost. */
  describeLoss(
    old: V,
    joined: V,
    widened: V
  ): { lostBound: LossItem['lostBound']; message: string } | undefined;

  latticeGraph?(): HasseDiagram | undefined;
}

/**
 * An environment: either unreachable, or a value per variable.
 *
 * Bottom is represented explicitly rather than as "some variable is bottom",
 * because those mean different things when reporting reachability.
 */
export type Env<V> =
  | { readonly kind: 'bottom' }
  | { readonly kind: 'env'; readonly vars: ReadonlyMap<string, V> };

const BOTTOM_ENV = { kind: 'bottom' } as const;

export class NonRelationalDomain<V> implements Domain<Env<V>> {
  readonly id: string;
  readonly name: string;
  readonly finiteLattice: boolean;

  constructor(private readonly L: ValueLattice<V>) {
    this.id = L.id;
    this.name = L.name;
    this.finiteLattice = L.finiteLattice;
  }

  bottom(): Env<V> {
    return BOTTOM_ENV;
  }

  top(vars: readonly string[]): Env<V> {
    return { kind: 'env', vars: new Map(vars.map((v) => [v, this.L.top])) };
  }

  isBottom(s: Env<V>): boolean {
    return s.kind === 'bottom';
  }

  private get(s: Env<V>, name: string): V {
    if (s.kind === 'bottom') return this.L.bottom;
    return s.vars.get(name) ?? this.L.top;
  }

  private names(a: Env<V>, b: Env<V>): string[] {
    const out = new Set<string>();
    if (a.kind === 'env') for (const k of a.vars.keys()) out.add(k);
    if (b.kind === 'env') for (const k of b.vars.keys()) out.add(k);
    return [...out];
  }

  /** Builds an environment, collapsing to bottom if any variable is bottom. */
  private build(entries: Iterable<[string, V]>): Env<V> {
    const vars = new Map<string, V>();
    for (const [k, v] of entries) {
      if (this.L.isBottom(v)) return BOTTOM_ENV;
      vars.set(k, v);
    }
    return { kind: 'env', vars };
  }

  leq(a: Env<V>, b: Env<V>): boolean {
    if (a.kind === 'bottom') return true;
    if (b.kind === 'bottom') return false;
    return this.names(a, b).every((n) => this.L.leq(this.get(a, n), this.get(b, n)));
  }

  join(a: Env<V>, b: Env<V>): Env<V> {
    if (a.kind === 'bottom') return b;
    if (b.kind === 'bottom') return a;
    return this.build(
      this.names(a, b).map((n) => [n, this.L.join(this.get(a, n), this.get(b, n))])
    );
  }

  meet(a: Env<V>, b: Env<V>): Env<V> {
    if (a.kind === 'bottom' || b.kind === 'bottom') return BOTTOM_ENV;
    return this.build(
      this.names(a, b).map((n) => [n, this.L.meet(this.get(a, n), this.get(b, n))])
    );
  }

  widen(a: Env<V>, b: Env<V>): Env<V> {
    if (a.kind === 'bottom') return b;
    if (b.kind === 'bottom') return a;
    return this.build(
      this.names(a, b).map((n) => [n, this.L.widen(this.get(a, n), this.get(b, n))])
    );
  }

  narrow(a: Env<V>, b: Env<V>): Env<V> {
    if (a.kind === 'bottom' || b.kind === 'bottom') return BOTTOM_ENV;
    return this.build(
      this.names(a, b).map((n) => [n, this.L.narrow(this.get(a, n), this.get(b, n))])
    );
  }

  eval(s: Env<V>, e: Expr): V {
    if (s.kind === 'bottom') return this.L.bottom;
    switch (e.kind) {
      case 'const':
        return this.L.constant(e.value);
      case 'var':
        return this.get(s, e.name);
      case 'nondet':
        return this.L.top;
      case 'neg':
        return this.L.neg(this.eval(s, e.operand));
      case 'binary': {
        const l = this.eval(s, e.left);
        const r = this.eval(s, e.right);
        switch (e.op) {
          case '+':
            return this.L.add(l, r);
          case '-':
            return this.L.sub(l, r);
          case '*':
            return this.L.mul(l, r);
          case '/':
            return this.L.div(l, r);
          case '%':
            return this.L.mod(l, r);
        }
      }
    }
  }

  assign(s: Env<V>, target: string, expr: Expr): Env<V> {
    if (s.kind === 'bottom') return s;
    const value = this.eval(s, expr);
    if (this.L.isBottom(value)) return BOTTOM_ENV;
    const vars = new Map(s.vars);
    vars.set(target, value);
    return { kind: 'env', vars };
  }

  havoc(s: Env<V>, target: string): Env<V> {
    if (s.kind === 'bottom') return s;
    const vars = new Map(s.vars);
    vars.set(target, this.L.top);
    return { kind: 'env', vars };
  }

  /**
   * Refines the environment under a condition.
   *
   * Only refines when one side is a plain variable — enough for the guards a C
   * frontend produces, and it never claims more than it can justify.
   */
  assume(s: Env<V>, cond: Cond): Env<V> {
    if (s.kind === 'bottom') return s;
    switch (cond.kind) {
      case 'true':
        return s;
      case 'false':
        return BOTTOM_ENV;
      case 'not':
        return this.assume(s, negate(cond.inner));
      case 'and':
        return this.assume(this.assume(s, cond.left), cond.right);
      case 'or':
        return this.join(this.assume(s, cond.left), this.assume(s, cond.right));
      case 'cmp': {
        const lv = this.eval(s, cond.left);
        const rv = this.eval(s, cond.right);
        const refinedL = this.L.refine(cond.op, lv, rv);
        const refinedR = this.L.refine(flip(cond.op), rv, lv);
        // Either side becoming bottom means the guard cannot hold at all.
        if (this.L.isBottom(refinedL) || this.L.isBottom(refinedR)) return BOTTOM_ENV;

        let out: Env<V> = s;
        if (cond.left.kind === 'var') {
          out = this.setVar(out, cond.left.name, refinedL);
        }
        if (cond.right.kind === 'var') {
          out = this.setVar(out, cond.right.name, refinedR);
        }
        return out;
      }
    }
  }

  private setVar(s: Env<V>, name: string, v: V): Env<V> {
    if (s.kind === 'bottom') return s;
    if (this.L.isBottom(v)) return BOTTOM_ENV;
    const vars = new Map(s.vars);
    vars.set(name, v);
    return { kind: 'env', vars };
  }

  format(s: Env<V>): DisplayState {
    if (s.kind === 'bottom') return { kind: 'bottom', vars: [] };
    const vars: VarValue[] = [...s.vars.entries()].map(([name, v]) => {
      const f = this.L.format(v);
      return { name, repr: f.repr, kind: f.kind };
    });
    return { kind: 'state', vars };
  }

  changed(a: Env<V>, b: Env<V>): string[] {
    if (a.kind === 'bottom' || b.kind === 'bottom') {
      return a.kind === b.kind ? [] : this.names(a, b);
    }
    return this.names(a, b).filter(
      (n) => !this.L.equal(this.get(a, n), this.get(b, n))
    );
  }

  lossReport(old: Env<V>, joined: Env<V>, widened: Env<V>): LossItem[] {
    if (widened.kind === 'bottom' || joined.kind === 'bottom') return [];
    const out: LossItem[] = [];
    for (const name of this.names(joined, widened)) {
      const o = this.get(old, name);
      const j = this.get(joined, name);
      const w = this.get(widened, name);
      if (this.L.equal(j, w)) continue;
      const described = this.L.describeLoss(o, j, w);
      if (!described) continue;
      out.push({
        name,
        before: this.L.format(o).repr,
        joined: this.L.format(j).repr,
        widened: this.L.format(w).repr,
        lostBound: described.lostBound,
        message: described.message,
      });
    }
    return out;
  }

  valueOf(s: Env<V>, variable: string): string | undefined {
    if (s.kind === 'bottom') return undefined;
    const v = s.vars.get(variable);
    return v === undefined ? undefined : this.L.format(v).repr;
  }

  latticeGraph(): HasseDiagram | undefined {
    return this.L.latticeGraph?.();
  }
}

export function flip(op: CmpOp): CmpOp {
  switch (op) {
    case '<':
      return '>';
    case '<=':
      return '>=';
    case '>':
      return '<';
    case '>=':
      return '<=';
    default:
      return op;
  }
}
