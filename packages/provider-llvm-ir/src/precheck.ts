/**
 * Supportability precheck for parsed LLVM IR functions.
 *
 * Same allow-list discipline as the tree-sitter C provider's `precheck.ts`:
 * anything the parser flagged as `unsupported` gets a specific,
 * human-actionable diagnostic; a genuine parse failure is fatal and returned
 * immediately (analyzing a mis-parsed function is worse than refusing).
 *
 * One rule beyond individual opcodes: a plain SSA temporary (the result of
 * `load`/a binary op/`icmp`) may only be referenced from the block that
 * defines it. `alloca` and `phi` results are exempt — they're the two
 * mechanisms in this subset that legitimately carry a value across a block
 * boundary (see `cfgbuilder.ts`'s doc comment for why). This keeps the CFG
 * builder's per-block value environment simple without silently mishandling
 * a value that actually crosses blocks.
 */

import type { Diagnostic } from '@aiviz/trace-protocol';
import type { LlvmFunction, LlvmValue } from './parser.js';

function opcodeCode(opcode: string): string {
  return `unsupported.${opcode.replace(/\s+/g, '_')}`;
}

function checkCrossBlockTemporaries(fn: LlvmFunction): Diagnostic[] {
  const out: Diagnostic[] = [];
  // Parameters are defined by the function signature itself, not by any
  // in-block instruction — like alloca/phi results, they're valid to
  // reference from any block, so they get the same exemption.
  const globalVars = new Set<string>(fn.params.map((p) => p.name));
  for (const b of fn.blocks) {
    for (const instr of b.instrs) {
      if (instr.kind === 'alloca' || instr.kind === 'phi') globalVars.add(instr.result);
    }
  }

  const blockLocalDefs = new Map<string, Set<string>>();
  for (const b of fn.blocks) {
    const defs = new Set<string>();
    for (const instr of b.instrs) {
      if (instr.kind === 'load' || instr.kind === 'binop' || instr.kind === 'icmp') defs.add(instr.result);
      // An `unsupported` instruction with a result register is already
      // reported on its own; treating its result as block-local here avoids
      // also reporting every use of it as a redundant, less-specific
      // "crosses a block boundary" diagnostic for the same root cause.
      if (instr.kind === 'unsupported' && instr.result !== undefined) defs.add(instr.result);
    }
    blockLocalDefs.set(b.label, defs);
  }

  function checkValueInBlock(v: LlvmValue, blockLabel: string, line: number): void {
    if (v.kind !== 'reg') return;
    if (globalVars.has(v.name)) return;
    if (blockLocalDefs.get(blockLabel)?.has(v.name)) return;
    out.push({
      severity: 'error',
      code: 'unsupported.crossBlockValue',
      message:
        `\`%${v.name}\` is used outside the block that defines it, and is not a phi/alloca ` +
        'variable — a plain SSA temporary may only be used within its own block',
      line,
    });
  }

  for (const b of fn.blocks) {
    for (const instr of b.instrs) {
      switch (instr.kind) {
        case 'store':
          checkValueInBlock(instr.value, b.label, instr.line);
          break;
        case 'binop':
          checkValueInBlock(instr.lhs, b.label, instr.line);
          checkValueInBlock(instr.rhs, b.label, instr.line);
          break;
        case 'icmp':
          checkValueInBlock(instr.lhs, b.label, instr.line);
          checkValueInBlock(instr.rhs, b.label, instr.line);
          break;
        case 'br':
          if (instr.cond) checkValueInBlock(instr.cond, b.label, instr.line);
          break;
        case 'ret':
          if (instr.value) checkValueInBlock(instr.value, b.label, instr.line);
          break;
        case 'phi':
          for (const inc of instr.incoming) checkValueInBlock(inc.value, inc.pred, instr.line);
          break;
        default:
          break;
      }
    }
  }
  return out;
}

/** Checks one function. Returns every reason it cannot be analyzed, so the
 * user sees the whole picture rather than fixing one thing at a time. */
export function precheckFunction(fn: LlvmFunction): Diagnostic[] {
  const parseErrors: Diagnostic[] = [];
  for (const b of fn.blocks) {
    for (const instr of b.instrs) {
      if (instr.kind === 'parse-error') {
        parseErrors.push({ severity: 'error', code: 'parse.error', message: instr.message, line: instr.line });
      }
    }
  }
  if (parseErrors.length > 0) return dedupe(parseErrors);

  const out: Diagnostic[] = [];
  for (const b of fn.blocks) {
    for (const instr of b.instrs) {
      if (instr.kind === 'unsupported') {
        out.push({ severity: 'error', code: opcodeCode(instr.opcode), message: instr.reason, line: instr.line });
      }
    }
  }
  out.push(...checkCrossBlockTemporaries(fn));
  return dedupe(out);
}

/** One diagnostic per (line, code) keeps the message list readable. */
function dedupe(items: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of items) {
    const key = `${d.line}:${d.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out.sort((a, b) => a.line - b.line);
}
