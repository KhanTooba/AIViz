/**
 * Builds the analysis CFG from a tree-sitter C function.
 *
 * Loops are desugared into explicit header/body/latch blocks and compound
 * assignments into plain ones, so the engine only ever sees `assign`, `assume`
 * and `havoc`. Every instruction and guard keeps the exact source span it came
 * from, which is what makes click-a-line-highlight-a-block precise.
 */

import type { LineRange, SourceSpan } from '@aiviz/trace-protocol';
import type { Cfg, CfgBlock, CfgEdge, Cond, Expr, Instr } from '@aiviz/analysis-core';
import { negate } from '@aiviz/analysis-core';
import type { Node } from 'web-tree-sitter';
import { labelOf, spanOf } from './parser.js';

interface MutableBlock {
  id: string;
  instrs: Instr[];
  succs: CfgEdge[];
  preds: string[];
  lines: Set<number>;
  label?: string;
}

const COMPOUND_ASSIGN: Record<string, '+' | '-' | '*' | '/' | '%'> = {
  '+=': '+',
  '-=': '-',
  '*=': '*',
  '/=': '/',
  '%=': '%',
};

export class CfgBuilder {
  private readonly blocks = new Map<string, MutableBlock>();
  private counter = 0;
  private readonly loops: { breakTo: string; continueTo: string }[] = [];
  private readonly variables: { name: string; type: string; declLine?: number }[] = [];
  private readonly seenVars = new Set<string>();
  private readonly exitId: string;

  constructor() {
    this.exitId = this.newBlock('exit');
  }

  private newBlock(label?: string): string {
    const id = `b${this.counter++}`;
    this.blocks.set(id, {
      id,
      instrs: [],
      succs: [],
      preds: [],
      lines: new Set(),
      ...(label ? { label } : {}),
    });
    return id;
  }

  private block(id: string): MutableBlock {
    const b = this.blocks.get(id);
    if (!b) throw new Error(`unknown block ${id}`);
    return b;
  }

  private addEdge(from: string, to: string, cond?: Cond, label?: string): void {
    const b = this.block(from);
    if (b.succs.some((e) => e.target === to && !cond)) return;
    b.succs.push({ target: to, ...(cond ? { cond } : {}), ...(label ? { label } : {}) });
    const target = this.block(to);
    if (!target.preds.includes(from)) target.preds.push(from);
  }

  private addLines(id: string, span: SourceSpan): void {
    const b = this.block(id);
    for (let line = span.startLine; line <= span.endLine; line++) b.lines.add(line);
  }

  private addInstr(id: string, instr: Instr): void {
    const b = this.block(id);
    b.instrs.push(instr);
    this.addLines(id, instr.span);
    this.appendLabel(id, instr.text);
  }

  /**
   * Adds a line to a block's display label.
   *
   * A straight-line run of statements with no branch between them all lands
   * in one block, and the CFG view renders every line in `label` — so each
   * statement must be appended here, not just the first (control-flow header
   * blocks such as `while (...)` set their label directly via `newBlock` and
   * never call this, so they stay single-line).
   */
  private appendLabel(id: string, text: string): void {
    const b = this.block(id);
    b.label = b.label ? `${b.label}\n${text}` : text;
  }

  /** Condition text without its enclosing parens, so labels read `while (i < 10)`. */
  private condLabel(node: Node | null, max = 20): string {
    if (!node) return 'true';
    const inner =
      node.type === 'parenthesized_expression' ? (node.namedChild(0) ?? node) : node;
    return labelOf(inner, max);
  }

  private declare(name: string, type: string, declLine?: number): void {
    if (this.seenVars.has(name)) return;
    this.seenVars.add(name);
    this.variables.push({ name, type, ...(declLine !== undefined ? { declLine } : {}) });
  }

  // ---------------------------------------------------------------- expressions

  private expr(node: Node | null): Expr {
    if (!node) return { kind: 'nondet' };
    switch (node.type) {
      case 'number_literal': {
        const value = Number(node.text.replace(/[uUlL]+$/, ''));
        return Number.isFinite(value) ? { kind: 'const', value } : { kind: 'nondet' };
      }
      case 'true':
        return { kind: 'const', value: 1 };
      case 'false':
        return { kind: 'const', value: 0 };
      case 'identifier':
        return { kind: 'var', name: node.text };
      case 'parenthesized_expression':
        return this.expr(node.namedChild(0));
      case 'unary_expression': {
        const op = node.childForFieldName('operator')?.text;
        const arg = node.childForFieldName('argument');
        if (op === '-') return { kind: 'neg', operand: this.expr(arg) };
        if (op === '+') return this.expr(arg);
        return { kind: 'nondet' };
      }
      case 'binary_expression': {
        const op = node.childForFieldName('operator')?.text;
        if (op === '+' || op === '-' || op === '*' || op === '/' || op === '%') {
          return {
            kind: 'binary',
            op,
            left: this.expr(node.childForFieldName('left')),
            right: this.expr(node.childForFieldName('right')),
          };
        }
        // A comparison used as a value is 0 or 1; we do not track that precisely.
        return { kind: 'nondet' };
      }
      default:
        return { kind: 'nondet' };
    }
  }

  /**
   * Turns an expression into a condition.
   *
   * C treats any non-zero value as true, so a bare `while (n)` becomes `n != 0`
   * rather than being thrown away as unmodellable.
   */
  private cond(node: Node | null): Cond {
    if (!node) return { kind: 'true' };
    switch (node.type) {
      case 'parenthesized_expression':
        return this.cond(node.namedChild(0));
      case 'unary_expression': {
        if (node.childForFieldName('operator')?.text === '!') {
          return negate(this.cond(node.childForFieldName('argument')));
        }
        break;
      }
      case 'binary_expression': {
        const op = node.childForFieldName('operator')?.text;
        const left = node.childForFieldName('left');
        const right = node.childForFieldName('right');
        if (op === '&&') {
          return { kind: 'and', left: this.cond(left), right: this.cond(right) };
        }
        if (op === '||') {
          return { kind: 'or', left: this.cond(left), right: this.cond(right) };
        }
        if (op === '<' || op === '<=' || op === '>' || op === '>=' || op === '==' || op === '!=') {
          return { kind: 'cmp', op, left: this.expr(left), right: this.expr(right) };
        }
        break;
      }
      case 'number_literal':
        return Number(node.text) === 0 ? { kind: 'false' } : { kind: 'true' };
    }
    // Fall back to the C truth test.
    return { kind: 'cmp', op: '!=', left: this.expr(node), right: { kind: 'const', value: 0 } };
  }

  // ---------------------------------------------------------------- statements

  /** Returns the block control continues in, or null if it cannot fall through. */
  private stmt(node: Node, cur: string): string | null {
    switch (node.type) {
      case 'compound_statement': {
        let at: string | null = cur;
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (!child || child.type === 'comment') continue;
          if (at === null) return null; // unreachable tail
          at = this.stmt(child, at);
        }
        return at;
      }

      case 'declaration':
        return this.declaration(node, cur);

      case 'expression_statement': {
        const inner = node.namedChild(0);
        if (inner) this.effect(inner, cur, node);
        return cur;
      }

      case 'if_statement':
        return this.ifStmt(node, cur);
      case 'while_statement':
        return this.whileStmt(node, cur);
      case 'for_statement':
        return this.forStmt(node, cur);
      case 'do_statement':
        return this.doStmt(node, cur);

      case 'break_statement': {
        const target = this.loops.at(-1)?.breakTo;
        if (target) this.addEdge(cur, target);
        this.addLines(cur, spanOf(node));
        this.appendLabel(cur, labelOf(node));
        return null;
      }
      case 'continue_statement': {
        const target = this.loops.at(-1)?.continueTo;
        if (target) this.addEdge(cur, target);
        this.addLines(cur, spanOf(node));
        this.appendLabel(cur, labelOf(node));
        return null;
      }
      case 'return_statement': {
        this.addLines(cur, spanOf(node));
        this.appendLabel(cur, labelOf(node));
        this.addEdge(cur, this.exitId);
        return null;
      }

      case 'comment':
        return cur;
      default:
        // The precheck runs first, so anything reaching here is a modelling gap
        // rather than user error; treat it as having no effect.
        return cur;
    }
  }

  private declaration(node: Node, cur: string): string {
    const type = node.childForFieldName('type')?.text ?? 'int';
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;

      if (child.type === 'init_declarator') {
        const name = child.childForFieldName('declarator')?.text;
        const value = child.childForFieldName('value');
        if (!name) continue;
        this.declare(name, type, child.startPosition.row + 1);
        this.addInstr(cur, {
          kind: 'assign',
          target: name,
          expr: this.expr(value),
          span: spanOf(node),
          // One label line per declarator, not the whole declaration — a
          // block with `int i = 0, j = 1;` must show two distinct lines, not
          // the same full statement text repeated twice.
          text: `${type} ${labelOf(child)};`,
        });
      } else if (child.type === 'identifier') {
        // `int x;` — declared but uninitialised, so nothing is known about it.
        this.declare(child.text, type, child.startPosition.row + 1);
        this.addInstr(cur, {
          kind: 'havoc',
          target: child.text,
          span: spanOf(node),
          text: `${type} ${child.text};`,
        });
      }
    }
    return cur;
  }

  /** Applies the side effect of an expression statement. */
  private effect(node: Node, cur: string, stmtNode: Node): void {
    if (node.type === 'assignment_expression') {
      const left = node.childForFieldName('left');
      const op = node.childForFieldName('operator')?.text ?? '=';
      const right = node.childForFieldName('right');
      if (left?.type !== 'identifier') return;
      const name = left.text;
      this.declare(name, 'int');

      const compound = COMPOUND_ASSIGN[op];
      const expr: Expr = compound
        ? {
            kind: 'binary',
            op: compound,
            left: { kind: 'var', name },
            right: this.expr(right),
          }
        : this.expr(right);

      this.addInstr(cur, {
        kind: 'assign',
        target: name,
        expr,
        span: spanOf(stmtNode),
        text: labelOf(stmtNode),
      });
      return;
    }

    if (node.type === 'update_expression') {
      const arg = node.childForFieldName('argument');
      const op = node.childForFieldName('operator')?.text;
      if (arg?.type !== 'identifier') return;
      const name = arg.text;
      this.declare(name, 'int');
      // As a statement, `++x` and `x++` are the same thing.
      this.addInstr(cur, {
        kind: 'assign',
        target: name,
        expr: {
          kind: 'binary',
          op: op === '--' ? '-' : '+',
          left: { kind: 'var', name },
          right: { kind: 'const', value: 1 },
        },
        span: spanOf(stmtNode),
        text: labelOf(stmtNode),
      });
    }
  }

  private ifStmt(node: Node, cur: string): string | null {
    const condNode = node.childForFieldName('condition');
    const cond = this.cond(condNode);
    if (condNode) this.addLines(cur, spanOf(condNode));
    this.block(cur).label ??= `if (${this.condLabel(condNode, 20)})`;

    const thenId = this.newBlock();
    const join = this.newBlock();
    this.addEdge(cur, thenId, cond, this.condLabel(condNode, 20));

    const consequence = node.childForFieldName('consequence');
    const thenExit = consequence ? this.stmt(consequence, thenId) : thenId;
    if (thenExit !== null) this.addEdge(thenExit, join);

    const alternativeClause = node.childForFieldName('alternative');
    // tree-sitter wraps the else branch in an `else_clause`.
    const alternative =
      alternativeClause?.type === 'else_clause'
        ? alternativeClause.namedChild(0)
        : alternativeClause;

    if (alternative) {
      const elseId = this.newBlock();
      this.addEdge(cur, elseId, negate(cond), `!(${this.condLabel(condNode, 16)})`);
      const elseExit = this.stmt(alternative, elseId);
      if (elseExit !== null) this.addEdge(elseExit, join);
    } else {
      this.addEdge(cur, join, negate(cond), `!(${this.condLabel(condNode, 16)})`);
    }

    return join;
  }

  private whileStmt(node: Node, cur: string): string {
    const condNode = node.childForFieldName('condition');
    const cond = this.cond(condNode);

    const header = this.newBlock(`while (${this.condLabel(condNode, 20)})`);
    if (condNode) this.addLines(header, spanOf(condNode));
    this.addEdge(cur, header);

    const body = this.newBlock();
    const exit = this.newBlock();
    this.addEdge(header, body, cond, this.condLabel(condNode, 20));
    this.addEdge(header, exit, negate(cond), `!(${this.condLabel(condNode, 16)})`);

    this.loops.push({ breakTo: exit, continueTo: header });
    const bodyNode = node.childForFieldName('body');
    const bodyExit = bodyNode ? this.stmt(bodyNode, body) : body;
    if (bodyExit !== null) this.addEdge(bodyExit, header);
    this.loops.pop();

    return exit;
  }

  /**
   * `for (init; cond; update) body` becomes
   * `init; header: assume(cond); body; latch: update; goto header`.
   *
   * The latch carries the update, whose source span sits back up on the `for`
   * line — this is exactly why one source line can map to several blocks.
   */
  private forStmt(node: Node, cur: string): string {
    const initializer = node.childForFieldName('initializer');
    if (initializer) {
      if (initializer.type === 'declaration') this.declaration(initializer, cur);
      else this.effect(initializer, cur, initializer);
    }

    const condNode = node.childForFieldName('condition');
    const cond = condNode ? this.cond(condNode) : ({ kind: 'true' } as Cond);
    const label = condNode ? labelOf(condNode, 20) : 'true';

    const header = this.newBlock(`for (…; ${label}; …)`);
    if (condNode) this.addLines(header, spanOf(condNode));
    else this.addLines(header, spanOf(node));
    this.addEdge(cur, header);

    const body = this.newBlock();
    const latch = this.newBlock();
    const exit = this.newBlock();
    this.addEdge(header, body, cond, label);
    this.addEdge(header, exit, negate(cond), `!(${label})`);

    // `continue` in a for-loop runs the update, so it targets the latch.
    this.loops.push({ breakTo: exit, continueTo: latch });
    const bodyNode = node.childForFieldName('body');
    const bodyExit = bodyNode ? this.stmt(bodyNode, body) : body;
    if (bodyExit !== null) this.addEdge(bodyExit, latch);
    this.loops.pop();

    const update = node.childForFieldName('update');
    if (update) this.effect(update, latch, update);
    this.block(latch).label ??= update ? labelOf(update) : 'latch';
    this.addEdge(latch, header);

    return exit;
  }

  private doStmt(node: Node, cur: string): string {
    const body = this.newBlock();
    this.addEdge(cur, body);

    const condNode = node.childForFieldName('condition');
    const cond = this.cond(condNode);
    const check = this.newBlock(`while (${this.condLabel(condNode, 20)})`);
    if (condNode) this.addLines(check, spanOf(condNode));
    const exit = this.newBlock();

    this.loops.push({ breakTo: exit, continueTo: check });
    const bodyNode = node.childForFieldName('body');
    const bodyExit = bodyNode ? this.stmt(bodyNode, body) : body;
    if (bodyExit !== null) this.addEdge(bodyExit, check);
    this.loops.pop();

    this.addEdge(check, body, cond, this.condLabel(condNode, 20));
    this.addEdge(check, exit, negate(cond), `!(${this.condLabel(condNode, 16)})`);
    return exit;
  }

  // ---------------------------------------------------------------- assembly

  build(fn: Node): Cfg {
    const entry = this.newBlock('entry');

    // Parameters are inputs: known to exist, but with no known value.
    const params = fn.childForFieldName('declarator')?.childForFieldName('parameters');
    if (params) {
      for (let i = 0; i < params.namedChildCount; i++) {
        const p = params.namedChild(i);
        const declarator = p?.childForFieldName('declarator');
        if (p?.type !== 'parameter_declaration' || declarator?.type !== 'identifier') continue;
        const type = p.childForFieldName('type')?.text ?? 'int';
        this.declare(declarator.text, type, declarator.startPosition.row + 1);
        this.addInstr(entry, {
          kind: 'havoc',
          target: declarator.text,
          span: spanOf(declarator),
          text: `parameter ${declarator.text}`,
        });
      }
    }

    const body = fn.childForFieldName('body');
    const tail = body ? this.stmt(body, entry) : entry;
    if (tail !== null) this.addEdge(tail, this.exitId);

    // The exit block's own line is the closing brace, which reads better than
    // leaving it unmapped.
    if (this.block(this.exitId).lines.size === 0 && body) {
      this.block(this.exitId).lines.add(body.endPosition.row + 1);
    }
    this.block(this.exitId).label ??= 'exit';

    // Renumber in traversal order from the entry. The builder allocates the
    // exit block first (it needs a `return` target before parsing starts), so
    // without this the exit block would be called `b0` — actively confusing in
    // a tool whose whole job is to be readable.
    const order = this.orderFrom(entry);
    const rename = new Map(order.map((id, i) => [id, `b${i}`]));
    const keep = (id: string): boolean => rename.has(id);
    const renamed = (id: string): string => rename.get(id) ?? id;

    const blocks: CfgBlock[] = order.map((id) => {
      const b = this.block(id);
      return {
        id: renamed(id),
        instrs: b.instrs,
        succs: b.succs
          .filter((e) => keep(e.target))
          .map((e) => ({ ...e, target: renamed(e.target) })),
        preds: b.preds.filter(keep).map(renamed),
        lines: compressLines(b.lines),
        ...(b.label ? { label: b.label } : {}),
        ...(id === entry ? { isEntry: true } : {}),
        ...(id === this.exitId ? { isExit: true } : {}),
      };
    });

    return {
      entry: renamed(entry),
      exit: renamed(this.exitId),
      blocks,
      variables: this.variables,
    };
  }

  /**
   * Blocks reachable from the entry, in depth-first order.
   *
   * Also drops blocks the builder allocated but nothing ever reaches — the
   * join block after an `if` whose branches both return, for instance.
   */
  private orderFrom(entry: string): string[] {
    const seen = new Set<string>([entry]);
    const out: string[] = [];
    const stack = [entry];
    while (stack.length > 0) {
      const id = stack.pop()!;
      out.push(id);
      // Reversed so the first successor is visited first on a LIFO stack.
      const succs = this.block(id).succs;
      for (let i = succs.length - 1; i >= 0; i--) {
        const target = succs[i]!.target;
        if (!seen.has(target)) {
          seen.add(target);
          stack.push(target);
        }
      }
    }
    return out;
  }
}

/** Turns a set of line numbers into contiguous ranges: {7,9,10,11} -> 7, 9–11. */
export function compressLines(lines: Set<number>): LineRange[] {
  const sorted = [...lines].sort((a, b) => a - b);
  const out: LineRange[] = [];
  for (const line of sorted) {
    const last = out.at(-1);
    if (last && line === last.end + 1) last.end = line;
    else out.push({ start: line, end: line });
  }
  return out;
}

export function buildCfg(fn: Node): Cfg {
  return new CfgBuilder().build(fn);
}
