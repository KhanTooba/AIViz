/**
 * A deliberately tiny IR.
 *
 * Frontends desugar their source language into these four instruction kinds, so
 * a domain only ever implements `assign` and `assume` rather than a transfer
 * function per C construct. Every instruction keeps its source span, which is
 * what makes source-level highlighting exact.
 */

import type { LineRange, SourceSpan } from '@aiviz/trace-protocol';

export type { LineRange, SourceSpan };

export type BinOp = '+' | '-' | '*' | '/' | '%';
export type CmpOp = '<' | '<=' | '>' | '>=' | '==' | '!=';

export type Expr =
  | { kind: 'const'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'binary'; op: BinOp; left: Expr; right: Expr }
  | { kind: 'neg'; operand: Expr }
  /** A value we cannot model (e.g. a parameter): anything at all. */
  | { kind: 'nondet' };

export type Cond =
  | { kind: 'cmp'; op: CmpOp; left: Expr; right: Expr }
  | { kind: 'not'; inner: Cond }
  | { kind: 'and'; left: Cond; right: Cond }
  | { kind: 'or'; left: Cond; right: Cond }
  | { kind: 'true' }
  | { kind: 'false' };

export type Instr =
  | { kind: 'assign'; target: string; expr: Expr; span: SourceSpan; text: string }
  | { kind: 'assume'; cond: Cond; span: SourceSpan; text: string }
  /** Forget everything known about a variable. */
  | { kind: 'havoc'; target: string; span: SourceSpan; text: string };

export interface CfgEdge {
  target: string;
  /** Guard that must hold to take this edge; absent means unconditional. */
  cond?: Cond;
  /** Rendered guard, e.g. `i < 10` or `!(i < 10)`. */
  label?: string;
}

export interface CfgBlock {
  id: string;
  instrs: Instr[];
  succs: CfgEdge[];
  preds: string[];
  lines: LineRange[];
  label?: string;
  isEntry?: boolean;
  isExit?: boolean;
  isLoopHeader?: boolean;
}

export interface Cfg {
  entry: string;
  exit?: string;
  blocks: CfgBlock[];
  /** Variables in scope, in declaration order. */
  variables: { name: string; type: string; declLine?: number }[];
}

export function blockMap(cfg: Cfg): Map<string, CfgBlock> {
  return new Map(cfg.blocks.map((b) => [b.id, b]));
}

/** Renders an expression back to something close to the original source. */
export function exprToString(e: Expr): string {
  switch (e.kind) {
    case 'const':
      return String(e.value);
    case 'var':
      return e.name;
    case 'neg':
      return `-${exprToString(e.operand)}`;
    case 'nondet':
      return '?';
    case 'binary':
      return `${exprToString(e.left)} ${e.op} ${exprToString(e.right)}`;
  }
}

export function condToString(c: Cond): string {
  switch (c.kind) {
    case 'cmp':
      return `${exprToString(c.left)} ${c.op} ${exprToString(c.right)}`;
    case 'not':
      return `!(${condToString(c.inner)})`;
    case 'and':
      return `${condToString(c.left)} && ${condToString(c.right)}`;
    case 'or':
      return `${condToString(c.left)} || ${condToString(c.right)}`;
    case 'true':
      return 'true';
    case 'false':
      return 'false';
  }
}

/** Negates a condition, pushing the negation inward where it is cheap to do so. */
export function negate(c: Cond): Cond {
  switch (c.kind) {
    case 'true':
      return { kind: 'false' };
    case 'false':
      return { kind: 'true' };
    case 'not':
      return c.inner;
    case 'cmp': {
      const flip: Record<CmpOp, CmpOp> = {
        '<': '>=',
        '<=': '>',
        '>': '<=',
        '>=': '<',
        '==': '!=',
        '!=': '==',
      };
      return { kind: 'cmp', op: flip[c.op], left: c.left, right: c.right };
    }
    // De Morgan: keeps `assume` able to split conjunctions precisely.
    case 'and':
      return { kind: 'or', left: negate(c.left), right: negate(c.right) };
    case 'or':
      return { kind: 'and', left: negate(c.left), right: negate(c.right) };
  }
}
