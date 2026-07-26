/**
 * Builds the analysis CFG from a parsed LLVM function.
 *
 * LLVM IR already has an explicit CFG via basic blocks and terminators, so —
 * unlike the tree-sitter C provider, which has to desugar `for`/`while`/
 * `do-while` into headers/bodies/latches — this builder mostly maps LLVM
 * blocks onto `CfgBlock`s directly. The one genuinely new translation
 * challenge is SSA `phi` nodes: the engine's `join()` already reconciles
 * per-predecessor-edge state purely by variable *name* (confirmed directly
 * in `analysis-core/src/engine.ts`), so a phi `%x = phi i32 [ %a, %P1 ],
 * [ %b, %P2 ]` becomes an ordinary `assign x := ...` placed on *each*
 * incoming edge — never inside the merge block itself. To do this soundly
 * even when a predecessor has more than one successor (a "critical edge"),
 * every predecessor→phi-bearing-block edge that needs a phi-assign gets its
 * own private intermediate block, unconditionally — this is simpler than
 * detecting which edges are actually critical and is correct either way.
 *
 * Per-block value environment: a compile-time-only map from SSA register to
 * the `Expr`/`Cond` it represents, reset at each block boundary. Plain
 * temporaries (results of `load`, arithmetic, `icmp`) get inlined into
 * whatever consumes them and are never materialized as their own tracked
 * `Cfg.variables` entry — only `alloca` slots, `phi` results, and function
 * parameters are, since those are the things that persist as a real
 * "variable" across instructions/blocks (parameters are defined by the
 * function signature itself, not by any in-block instruction, so they get
 * the same treatment `precheck.ts`'s cross-block check gives them).
 * `precheck.ts` has already rejected any function where a plain temporary
 * crosses a block boundary some other way, so this
 * environment never needs to look outside the current block except for
 * resolving a phi's incoming value, which explicitly uses the *predecessor*
 * block's own environment (see the phi-resolution pass below).
 */

import type { LineRange, SourceSpan } from '@aiviz/trace-protocol';
import type { Cfg, CfgBlock, CfgEdge, Cond, Expr, Instr } from '@aiviz/analysis-core';
import { condToString, exprToString, negate } from '@aiviz/analysis-core';
import type { LlvmFunction, LlvmValue } from './parser.js';

function spanOf(line: number): SourceSpan {
  return { startLine: line, startColumn: 1, endLine: line, endColumn: 1 };
}

interface MutableBlock {
  id: string;
  instrs: Instr[];
  succs: CfgEdge[];
  preds: string[];
  lines: Set<number>;
  label?: string;
}

interface BlockEnv {
  regExpr: Map<string, Expr>;
  regCond: Map<string, Cond>;
}

const EXIT_ID = '$exit';

export function buildCfg(fn: LlvmFunction): Cfg {
  const variables: { name: string; type: string; declLine?: number }[] = [];
  const seenVars = new Set<string>();
  function declare(name: string, declLine?: number): void {
    if (seenVars.has(name)) return;
    seenVars.add(name);
    variables.push({ name, type: 'i32', ...(declLine !== undefined ? { declLine } : {}) });
  }

  // --- pass 1: translate each block's non-terminator instructions --------

  const blockInstrs = new Map<string, Instr[]>();
  const blockEnv = new Map<string, BlockEnv>();
  const blockPhis = new Map<
    string,
    { result: string; incoming: readonly { value: LlvmValue; pred: string }[]; line: number }[]
  >();
  const blockLines = new Map<string, Set<number>>();
  type Terminator =
    | { kind: 'ret' }
    | { kind: 'br-uncond'; target: string }
    | { kind: 'br-cond'; cond: Cond; ifTrue: string; ifFalse: string };
  const blockTerm = new Map<string, Terminator>();

  for (const b of fn.blocks) {
    const regExpr = new Map<string, Expr>();
    const regCond = new Map<string, Cond>();
    const instrs: Instr[] = [];
    const phis: { result: string; incoming: readonly { value: LlvmValue; pred: string }[]; line: number }[] = [];
    const lines = new Set<number>();

    function resolveValue(v: LlvmValue): Expr {
      if (v.kind === 'imm') return { kind: 'const', value: v.value };
      return regExpr.get(v.name) ?? { kind: 'var', name: v.name };
    }
    function resolveCond(v: LlvmValue): Cond {
      if (v.kind === 'imm') return v.value !== 0 ? { kind: 'true' } : { kind: 'false' };
      const c = regCond.get(v.name);
      if (c) return c;
      // A bare i1 value used as a condition (a loaded/phi'd boolean, not the
      // direct result of `icmp`) — treat it as a truthiness test, mirroring
      // the C frontend's own fallback for a bare identifier used as a guard.
      return { kind: 'cmp', op: '!=', left: resolveValue(v), right: { kind: 'const', value: 0 } };
    }

    for (const instr of b.instrs) {
      switch (instr.kind) {
        case 'alloca':
          declare(instr.result, instr.line);
          instrs.push({
            kind: 'havoc',
            target: instr.result,
            span: spanOf(instr.line),
            text: `%${instr.result} = alloca i32`,
          });
          lines.add(instr.line);
          break;
        case 'load':
          regExpr.set(instr.result, { kind: 'var', name: instr.ptr });
          break;
        case 'store': {
          const expr = resolveValue(instr.value);
          instrs.push({
            kind: 'assign',
            target: instr.ptr,
            expr,
            span: spanOf(instr.line),
            text: `store ${exprToString(expr)}, ptr %${instr.ptr}`,
          });
          lines.add(instr.line);
          break;
        }
        case 'binop':
          regExpr.set(instr.result, {
            kind: 'binary',
            op: instr.op,
            left: resolveValue(instr.lhs),
            right: resolveValue(instr.rhs),
          });
          break;
        case 'icmp':
          regCond.set(instr.result, {
            kind: 'cmp',
            op: instr.op,
            left: resolveValue(instr.lhs),
            right: resolveValue(instr.rhs),
          });
          break;
        case 'phi':
          declare(instr.result, instr.line);
          // Phis are grouped at the top of an LLVM block, so a later
          // same-block instruction may legitimately read this result
          // directly (e.g. incrementing the phi'd induction variable).
          regExpr.set(instr.result, { kind: 'var', name: instr.result });
          phis.push({ result: instr.result, incoming: instr.incoming, line: instr.line });
          break;
        case 'ret':
          if (instr.value) {
            declare('$ret', instr.line);
            const expr = resolveValue(instr.value);
            instrs.push({
              kind: 'assign',
              target: '$ret',
              expr,
              span: spanOf(instr.line),
              text: `ret ${exprToString(expr)}`,
            });
          }
          lines.add(instr.line);
          blockTerm.set(b.label, { kind: 'ret' });
          break;
        case 'br':
          lines.add(instr.line);
          if (instr.ifFalse === undefined) {
            blockTerm.set(b.label, { kind: 'br-uncond', target: instr.ifTrue });
          } else {
            const cond = resolveCond(instr.cond!);
            blockTerm.set(b.label, { kind: 'br-cond', cond, ifTrue: instr.ifTrue, ifFalse: instr.ifFalse });
          }
          break;
        case 'unsupported':
        case 'parse-error':
          // precheck() rejects these before buildCfg() is ever called.
          break;
      }
    }

    blockInstrs.set(b.label, instrs);
    blockEnv.set(b.label, { regExpr, regCond });
    blockPhis.set(b.label, phis);
    blockLines.set(b.label, lines);
  }

  // Parameters are inputs: known to exist, but with no known value —
  // havoc'd at the very start of the entry block, mirroring the C
  // provider's own parameter handling exactly.
  const entryLabel = fn.blocks[0]!.label;
  const paramHavocs: Instr[] = fn.params.map((p) => {
    declare(p.name, p.line);
    return { kind: 'havoc', target: p.name, span: spanOf(p.line), text: `parameter %${p.name}` };
  });
  blockInstrs.set(entryLabel, [...paramHavocs, ...blockInstrs.get(entryLabel)!]);

  // --- pass 2: resolve phi incoming values against each predecessor's own
  // environment, grouping the resulting assigns by the specific edge they
  // belong to ---------------------------------------------------------

  // Keyed by `${pred}->${target}` — every phi belonging to the same target
  // block, resolved against that specific predecessor, lands in one
  // intermediate block for that edge.
  const edgePhiInstrs = new Map<string, Instr[]>();
  for (const [target, phis] of blockPhis) {
    for (const phi of phis) {
      for (const { value, pred } of phi.incoming) {
        const env = blockEnv.get(pred);
        const expr: Expr =
          value.kind === 'imm'
            ? { kind: 'const', value: value.value }
            : (env?.regExpr.get(value.name) ?? { kind: 'var', name: value.name });
        const key = `${pred}->${target}`;
        const list = edgePhiInstrs.get(key) ?? [];
        list.push({
          kind: 'assign',
          target: phi.result,
          expr,
          span: spanOf(phi.line),
          text: `${phi.result} = phi ${exprToString(expr)}`,
        });
        edgePhiInstrs.set(key, list);
      }
    }
  }

  // --- graph assembly ------------------------------------------------------

  const mut = new Map<string, MutableBlock>();
  function ensureBlock(id: string, instrs: Instr[], label: string | undefined, lines: Set<number>): MutableBlock {
    const existing = mut.get(id);
    if (existing) return existing;
    const b: MutableBlock = { id, instrs, succs: [], preds: [], lines, ...(label ? { label } : {}) };
    mut.set(id, b);
    return b;
  }
  function addEdge(from: string, to: string, cond?: Cond, label?: string): void {
    const b = mut.get(from)!;
    b.succs.push({ target: to, ...(cond ? { cond } : {}), ...(label ? { label } : {}) });
    const t = mut.get(to)!;
    if (!t.preds.includes(from)) t.preds.push(from);
  }

  ensureBlock(EXIT_ID, [], 'exit', new Set());
  for (const b of fn.blocks) {
    ensureBlock(b.label, blockInstrs.get(b.label)!, b.label, blockLines.get(b.label)!);
  }

  let phiBlockCounter = 0;
  function wireEdge(from: string, to: string, cond?: Cond, label?: string): void {
    const phiInstrs = edgePhiInstrs.get(`${from}->${to}`);
    if (phiInstrs && phiInstrs.length > 0) {
      const mid = `$phi${phiBlockCounter++}`;
      const lines = new Set(phiInstrs.map((i) => i.span.startLine).filter((n) => n > 0));
      ensureBlock(mid, phiInstrs, undefined, lines);
      addEdge(from, mid, cond, label);
      addEdge(mid, to);
    } else {
      addEdge(from, to, cond, label);
    }
  }

  for (const b of fn.blocks) {
    const term = blockTerm.get(b.label);
    if (!term) continue; // malformed input; precheck should already have caught this
    if (term.kind === 'ret') {
      addEdge(b.label, EXIT_ID);
    } else if (term.kind === 'br-uncond') {
      wireEdge(b.label, term.target);
    } else {
      const label = condToString(term.cond);
      wireEdge(b.label, term.ifTrue, term.cond, label);
      wireEdge(b.label, term.ifFalse, negate(term.cond), `!(${label})`);
    }
  }

  // Renumber in traversal order from the entry, exactly like the C
  // provider's own `orderFrom` — the exit block (and any phi-resolution
  // blocks) are allocated independently of visit order, so without this the
  // ids would be arbitrary and unreadable.
  const order = orderFrom(mut, entryLabel);
  const rename = new Map(order.map((id, i) => [id, `b${i}`]));
  const keep = (id: string): boolean => rename.has(id);
  const renamed = (id: string): string => rename.get(id) ?? id;

  const blocks: CfgBlock[] = order.map((id) => {
    const b = mut.get(id)!;
    return {
      id: renamed(id),
      instrs: b.instrs,
      succs: b.succs.filter((e) => keep(e.target)).map((e) => ({ ...e, target: renamed(e.target) })),
      preds: b.preds.filter(keep).map(renamed),
      lines: compressLines(b.lines),
      ...(b.label ? { label: b.label } : {}),
      ...(id === entryLabel ? { isEntry: true } : {}),
      ...(id === EXIT_ID ? { isExit: true } : {}),
    };
  });

  return {
    entry: renamed(entryLabel),
    exit: renamed(EXIT_ID),
    blocks,
    variables,
  };
}

function orderFrom(mut: Map<string, MutableBlock>, entry: string): string[] {
  const seen = new Set<string>([entry]);
  const out: string[] = [];
  const stack = [entry];
  while (stack.length > 0) {
    const id = stack.pop()!;
    out.push(id);
    const succs = mut.get(id)!.succs;
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
