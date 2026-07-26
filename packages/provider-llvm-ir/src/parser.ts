/**
 * A hand-rolled parser for a scoped subset of LLVM textual IR (`.ll`).
 *
 * Not tree-sitter: LLVM's textual IR is a simple, fixed, machine-generated
 * grammar (no preprocessor, no ambiguity), so a line-oriented tokenizer plus
 * one parse function per supported opcode is more tractable than wiring up
 * an immature `tree-sitter-llvm` grammar — and this needs no native LLVM
 * bindings either way, since it only ever reads text clang has already
 * emitted, never linking against libLLVM.
 *
 * Deliberately permissive at the parse stage: an unrecognized but
 * syntactically well-formed opcode becomes an `{ kind: 'unsupported' }`
 * instruction (not a parse failure) so `precheck.ts` can report it with a
 * specific, actionable diagnostic — mirroring the tree-sitter C provider's
 * own "parse everything, then walk an allow/reject list" pipeline. Only
 * genuinely malformed syntax becomes `{ kind: 'parse-error' }`.
 */

export type LlvmValue = { readonly kind: 'reg'; readonly name: string } | { readonly kind: 'imm'; readonly value: number };

export type LlvmBinOp = '+' | '-' | '*' | '/' | '%';
export type LlvmCmpOp = '==' | '!=' | '<' | '<=' | '>' | '>=';

export type LlvmInstr =
  | { readonly kind: 'alloca'; readonly result: string; readonly line: number }
  | { readonly kind: 'load'; readonly result: string; readonly ptr: string; readonly line: number }
  | { readonly kind: 'store'; readonly value: LlvmValue; readonly ptr: string; readonly line: number }
  | {
      readonly kind: 'binop';
      readonly result: string;
      readonly op: LlvmBinOp;
      readonly lhs: LlvmValue;
      readonly rhs: LlvmValue;
      readonly line: number;
    }
  | {
      readonly kind: 'icmp';
      readonly result: string;
      readonly op: LlvmCmpOp;
      readonly lhs: LlvmValue;
      readonly rhs: LlvmValue;
      readonly line: number;
    }
  | {
      readonly kind: 'phi';
      readonly result: string;
      readonly incoming: readonly { readonly value: LlvmValue; readonly pred: string }[];
      readonly line: number;
    }
  | { readonly kind: 'br'; readonly cond?: LlvmValue; readonly ifTrue: string; readonly ifFalse?: string; readonly line: number }
  | { readonly kind: 'ret'; readonly value?: LlvmValue; readonly line: number }
  | { readonly kind: 'unsupported'; readonly opcode: string; readonly reason: string; readonly line: number; readonly result?: string }
  | { readonly kind: 'parse-error'; readonly message: string; readonly line: number };

export interface LlvmBlock {
  readonly label: string;
  readonly instrs: readonly LlvmInstr[];
}

export interface LlvmParam {
  readonly name: string;
  readonly line: number;
}

export interface LlvmFunction {
  readonly name: string;
  readonly params: readonly LlvmParam[];
  readonly blocks: readonly LlvmBlock[];
  readonly line: number;
}

export interface LlvmModule {
  readonly functions: readonly LlvmFunction[];
}

/** Opcodes recognized syntactically but explicitly not modeled, with a
 * specific, human-actionable reason each. */
const UNSUPPORTED_OPCODES: Record<string, string> = {
  call: 'function calls are not supported; analysis is intraprocedural',
  invoke: 'function calls are not supported; analysis is intraprocedural',
  getelementptr: 'pointer arithmetic beyond a plain local (`alloca`) is not supported',
  switch: '`switch` is not supported',
  indirectbr: 'indirect branches are not supported',
  select: '`select` is not supported',
  fadd: 'floating-point operations are not supported',
  fsub: 'floating-point operations are not supported',
  fmul: 'floating-point operations are not supported',
  fdiv: 'floating-point operations are not supported',
  frem: 'floating-point operations are not supported',
  fcmp: 'floating-point comparisons are not supported',
  udiv: 'unsigned division is not supported — no signed/unsigned distinction exists in this model',
  urem: 'unsigned remainder is not supported — no signed/unsigned distinction exists in this model',
  and: 'bitwise operators are not supported',
  or: 'bitwise operators are not supported',
  xor: 'bitwise operators are not supported',
  shl: 'shift operators are not supported',
  lshr: 'shift operators are not supported',
  ashr: 'shift operators are not supported',
  sext: 'type conversions are not supported',
  zext: 'type conversions are not supported',
  trunc: 'type conversions are not supported',
  bitcast: 'type conversions are not supported',
  ptrtoint: 'pointer/integer conversions are not supported',
  inttoptr: 'pointer/integer conversions are not supported',
  extractvalue: 'aggregate types are not supported',
  insertvalue: 'aggregate types are not supported',
  atomicrmw: 'atomics are not supported',
  cmpxchg: 'atomics are not supported',
  landingpad: 'exception handling is not supported',
  resume: 'exception handling is not supported',
  unreachable: '`unreachable` is not supported',
  freeze: '`freeze` is not supported',
  extractelement: 'vector types are not supported',
  insertelement: 'vector types are not supported',
  shufflevector: 'vector types are not supported',
};

const BINOPS: Record<string, LlvmBinOp> = { add: '+', sub: '-', mul: '*', sdiv: '/', srem: '%' };
const ICMP_PREDS: Record<string, LlvmCmpOp> = {
  eq: '==',
  ne: '!=',
  slt: '<',
  sle: '<=',
  sgt: '>',
  sge: '>=',
};
const UNSIGNED_ICMP_PREDS = new Set(['ult', 'ule', 'ugt', 'uge']);

function parseValue(tok: string): LlvmValue {
  const t = tok.trim();
  if (t.startsWith('%')) return { kind: 'reg', name: t.slice(1) };
  if (t === 'true') return { kind: 'imm', value: 1 };
  if (t === 'false') return { kind: 'imm', value: 0 };
  const n = Number(t);
  if (Number.isFinite(n)) return { kind: 'imm', value: n };
  return { kind: 'reg', name: t };
}

/** Strips trailing metadata attachments (`, !dbg !16`, `!llvm.loop !6`, ...)
 * that never affect the operands this parser needs. */
function stripMetadata(rest: string): string {
  const idx = rest.search(/,?\s*!\w/);
  return idx === -1 ? rest : rest.slice(0, idx);
}

/** Splits a comma-separated operand list at the top level only (not inside
 * `[ ... ]` phi brackets). */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0) out.push(cur);
  return out;
}

function parseInstrLine(rawLine: string, line: number): LlvmInstr | undefined {
  const trimmed = rawLine.trim();
  if (trimmed.length === 0 || trimmed.startsWith(';')) return undefined;
  if (trimmed.startsWith('#dbg_') || trimmed.startsWith('call void @llvm.dbg')) return undefined; // debug intrinsics carry no semantics we track

  const assignMatch = /^%([\w.$]+)\s*=\s*(\w[\w.]*)\s+(.*)$/.exec(trimmed);
  if (assignMatch) {
    const [, result, opcode, rawRest] = assignMatch as unknown as [string, string, string, string];
    const rest = stripMetadata(rawRest).trim();

    if (opcode === 'alloca') {
      return { kind: 'alloca', result, line };
    }
    if (opcode === 'load') {
      const m = /ptr\s+%([\w.$]+)/.exec(rest);
      if (!m) return { kind: 'parse-error', message: `could not parse pointer operand of \`load\`: ${trimmed}`, line };
      return { kind: 'load', result, ptr: m[1]!, line };
    }
    if (opcode in BINOPS) {
      const withoutFlags = rest.replace(/^(?:(?:nsw|nuw|exact)\s+)*/, '');
      const m = /^i(?:32|1)\s+(.+?),\s*(.+)$/.exec(withoutFlags);
      if (!m) return { kind: 'parse-error', message: `could not parse operands of \`${opcode}\`: ${trimmed}`, line };
      return {
        kind: 'binop',
        result,
        op: BINOPS[opcode]!,
        lhs: parseValue(m[1]!),
        rhs: parseValue(m[2]!),
        line,
      };
    }
    if (opcode === 'icmp') {
      const m = /^(\w+)\s+i(?:32|1)\s+(.+?),\s*(.+)$/.exec(rest);
      if (!m) return { kind: 'parse-error', message: `could not parse \`icmp\`: ${trimmed}`, line };
      const [, pred, lhsTok, rhsTok] = m as unknown as [string, string, string, string];
      if (UNSIGNED_ICMP_PREDS.has(pred)) {
        return {
          kind: 'unsupported',
          opcode: `icmp ${pred}`,
          reason: 'unsigned comparisons are not supported — no signed/unsigned distinction exists in this model',
          line,
          result,
        };
      }
      const op = ICMP_PREDS[pred];
      if (!op) return { kind: 'parse-error', message: `unknown icmp predicate \`${pred}\``, line };
      return { kind: 'icmp', result, op, lhs: parseValue(lhsTok), rhs: parseValue(rhsTok), line };
    }
    if (opcode === 'phi') {
      const m = /^i(?:32|1)\s+(.*)$/.exec(rest);
      if (!m) return { kind: 'parse-error', message: `could not parse \`phi\`: ${trimmed}`, line };
      const entries = splitTopLevel(m[1]!);
      const incoming: { value: LlvmValue; pred: string }[] = [];
      for (const entry of entries) {
        const em = /\[\s*(.+?)\s*,\s*%([\w.$]+)\s*\]/.exec(entry);
        if (!em) return { kind: 'parse-error', message: `could not parse phi entry: ${entry}`, line };
        incoming.push({ value: parseValue(em[1]!), pred: em[2]! });
      }
      return { kind: 'phi', result, incoming, line };
    }
    if (opcode in UNSUPPORTED_OPCODES) {
      return { kind: 'unsupported', opcode, reason: UNSUPPORTED_OPCODES[opcode]!, line, result };
    }
    return { kind: 'unsupported', opcode, reason: `\`${opcode}\` is not supported`, line, result };
  }

  // Non-assigning instructions: store, br, ret, or a bare unsupported opcode
  // (call to a void function, unreachable, ...).
  const withoutMeta = stripMetadata(trimmed).trim();

  if (withoutMeta.startsWith('store ')) {
    const m = /^store\s+i(?:32|1)\s+(.+?),\s*ptr\s+%([\w.$]+)/.exec(withoutMeta);
    if (!m) return { kind: 'parse-error', message: `could not parse \`store\`: ${trimmed}`, line };
    return { kind: 'store', value: parseValue(m[1]!), ptr: m[2]!, line };
  }

  if (withoutMeta.startsWith('br ')) {
    const condBr = /^br\s+i1\s+(.+?),\s*label\s+%([\w.$]+),\s*label\s+%([\w.$]+)/.exec(withoutMeta);
    if (condBr) {
      return { kind: 'br', cond: parseValue(condBr[1]!), ifTrue: condBr[2]!, ifFalse: condBr[3]!, line };
    }
    const uncondBr = /^br\s+label\s+%([\w.$]+)/.exec(withoutMeta);
    if (uncondBr) return { kind: 'br', ifTrue: uncondBr[1]!, line };
    return { kind: 'parse-error', message: `could not parse \`br\`: ${trimmed}`, line };
  }

  if (withoutMeta.startsWith('ret ')) {
    if (/^ret\s+void\s*$/.test(withoutMeta)) return { kind: 'ret', line };
    const m = /^ret\s+i(?:32|1)\s+(.+)$/.exec(withoutMeta);
    if (!m) return { kind: 'parse-error', message: `could not parse \`ret\`: ${trimmed}`, line };
    return { kind: 'ret', value: parseValue(m[1]!), line };
  }

  const bareOpcode = /^(\w[\w.]*)\b/.exec(withoutMeta);
  if (bareOpcode) {
    const opcode = bareOpcode[1]!;
    if (opcode in UNSUPPORTED_OPCODES) return { kind: 'unsupported', opcode, reason: UNSUPPORTED_OPCODES[opcode]!, line };
    return { kind: 'unsupported', opcode, reason: `\`${opcode}\` is not supported`, line };
  }

  return { kind: 'parse-error', message: `could not parse instruction: ${trimmed}`, line };
}

const DEFINE_RE = /^define\s+.*@([\w.$]+)\s*\(([^)]*)\)/;
const LABEL_RE = /^([\w.$]+):\s*(;.*)?$/;

function parseParams(paramList: string): LlvmParam[] {
  const chunks = splitTopLevel(paramList).map((c) => c.trim()).filter((c) => c.length > 0);
  return chunks.map((chunk, i) => {
    const m = /%([\w.$]+)\s*$/.exec(chunk);
    return { name: m ? m[1]! : `arg${i}`, line: 0 };
  });
}

export function parseModule(text: string): LlvmModule {
  const lines = text.split('\n');
  const functions: LlvmFunction[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const defineMatch = DEFINE_RE.exec(line.trim());
    if (!defineMatch) {
      i++;
      continue;
    }
    const defineLine = i + 1;
    const name = defineMatch[1]!;
    const params = parseParams(defineMatch[2]!).map((p) => ({ ...p, line: defineLine }));

    // Scan forward to the opening `{` (normally on the same line) and then to
    // the matching `}` that closes the function body.
    i++;
    const blocks: LlvmBlock[] = [];
    let currentLabel = 'entry';
    let currentInstrs: LlvmInstr[] = [];

    while (i < lines.length) {
      const raw = lines[i]!;
      const trimmed = raw.trim();
      i++;
      if (trimmed === '}') break;
      if (trimmed.length === 0) continue;

      const labelMatch = LABEL_RE.exec(trimmed);
      if (labelMatch) {
        // Only close out the block-in-progress if it actually is one — a
        // function whose first basic block has an *explicit* label (e.g.
        // `entry:`) would otherwise also get a spurious empty placeholder
        // block pushed here, using the same default "entry" name and
        // duplicating it.
        if (blocks.length > 0 || currentInstrs.length > 0) {
          blocks.push({ label: currentLabel, instrs: currentInstrs });
        }
        currentLabel = labelMatch[1]!;
        currentInstrs = [];
        continue;
      }

      const instr = parseInstrLine(raw, i);
      if (instr) currentInstrs.push(instr);
    }
    blocks.push({ label: currentLabel, instrs: currentInstrs });

    functions.push({ name, params, blocks, line: defineLine });
  }

  return { functions };
}
