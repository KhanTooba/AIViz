/**
 * The LLVM IR reference provider: a second frontend proving the trace
 * protocol and `@aiviz/analysis-core`'s engine/domains are genuinely
 * provider-agnostic, not just written to look that way while secretly
 * assuming tree-sitter/C.
 *
 * Takes `.ll` textual IR directly — the user runs `clang -S -emit-llvm`
 * themselves and opens the result. This provider has no runtime dependency
 * on clang (or any external tool); it only ever parses text it's handed.
 */

import {
  PROTOCOL_VERSION,
  type AnalysisProvider,
  type AnalysisTrace,
  type AnalyzeRequest,
  type Diagnostic,
  type DocumentRequest,
  type ListFunctionsResult,
  type PrecheckRequest,
  type PrecheckResult,
  type ProviderInfo,
} from '@aiviz/trace-protocol';
import { analyze, domainById, DOMAINS } from '@aiviz/analysis-core';
import { buildCfg } from './cfgbuilder.js';
import { precheckFunction } from './precheck.js';
import { parseModule } from './parser.js';

const PROVIDER = {
  id: 'llvm-ir',
  name: 'LLVM IR',
  version: '0.1.0',
} as const;

export class LlvmIrProvider implements AnalysisProvider {
  initialize(): ProviderInfo {
    return {
      ...PROVIDER,
      protocolVersion: PROTOCOL_VERSION,
      languages: ['llvm-ir'],
      domains: DOMAINS.map((d) => ({ id: d.id, name: d.name, finiteLattice: d.finiteLattice })),
      capabilities: { narrowing: true, wideningLoss: true, latticeGraph: true },
      supportedSubset:
        'Scalar i32/i1 only: alloca/load/store locals, phi nodes, add/sub/mul/sdiv/srem, ' +
        'signed icmp, br, ret. No calls, getelementptr, switch, floats, bitwise/shift ops, ' +
        'unsigned arithmetic/comparisons, vectors, structs, or a plain SSA temporary used ' +
        'outside the block that defines it.',
    };
  }

  listFunctions(req: DocumentRequest): ListFunctionsResult {
    const mod = parseModule(req.source);
    const functions = mod.functions.map((fn) => {
      const diagnostics = precheckFunction(fn);
      const first = diagnostics[0];
      return {
        name: fn.name,
        line: fn.line,
        supported: diagnostics.length === 0,
        ...(first ? { reason: `${first.message} (line ${first.line})` } : {}),
      };
    });
    return { functions };
  }

  precheck(req: PrecheckRequest): PrecheckResult {
    const mod = parseModule(req.source);
    const fn = mod.functions.find((f) => f.name === req.function);
    if (!fn) {
      return {
        supported: false,
        diagnostics: [
          {
            severity: 'error',
            code: 'function.notFound',
            message: `no function named \`@${req.function}\` in this file`,
            line: 1,
          },
        ],
      };
    }
    const diagnostics = precheckFunction(fn);
    return { supported: diagnostics.length === 0, diagnostics };
  }

  analyze(req: AnalyzeRequest): AnalysisTrace {
    const mod = parseModule(req.source);
    const fn = mod.functions.find((f) => f.name === req.function);
    if (!fn) {
      return unsupportedTrace(req, [
        {
          severity: 'error',
          code: 'function.notFound',
          message: `no function named \`@${req.function}\` in this file`,
          line: 1,
        },
      ]);
    }

    const diagnostics = precheckFunction(fn);
    if (diagnostics.length > 0) {
      return unsupportedTrace(req, diagnostics, fn.line);
    }

    const domain = domainById(req.domain);
    if (!domain) {
      return unsupportedTrace(req, [
        { severity: 'error', code: 'domain.unknown', message: `unknown domain \`${req.domain}\``, line: 1 },
      ]);
    }

    const cfg = buildCfg(fn);
    if (domain.maxVariables !== undefined && cfg.variables.length > domain.maxVariables) {
      return unsupportedTrace(req, [
        {
          severity: 'error',
          code: 'domain.tooManyVariables',
          message:
            `${domain.name} is hand-rolled and scoped to at most ${domain.maxVariables} variables ` +
            `for this function (it declares ${cfg.variables.length}); pick a domain without a variable cap, ` +
            `or simplify the function`,
          line: fn.line,
        },
      ]);
    }

    return analyze(
      cfg,
      domain,
      { provider: PROVIDER, file: req.file, functionName: req.function, language: 'llvm-ir' },
      req.config ?? {}
    );
  }
}

/** A protocol-valid trace carrying only diagnostics — same shape the
 * tree-sitter C provider uses for "this function is not supported". */
function unsupportedTrace(req: AnalyzeRequest, diagnostics: Diagnostic[], line = 1): AnalysisTrace {
  return {
    version: PROTOCOL_VERSION,
    provider: PROVIDER,
    program: { file: req.file, function: req.function, language: 'llvm-ir' },
    domain: { id: req.domain, name: req.domain },
    cfg: {
      entry: 'b0',
      blocks: [
        { blockId: 'b0', preds: [], succs: [], lines: [{ start: line, end: line }], isEntry: true, label: req.function },
      ],
    },
    lineMap: {
      lineToBlocks: { [String(line)]: ['b0'] },
      blockToLines: { b0: [{ start: line, end: line }] },
      bestBlockForLine: { [String(line)]: 'b0' },
    },
    variables: [],
    steps: [],
    summary: {
      iterations: 0,
      stepCount: 0,
      converged: false,
      wideningPoints: [],
      wideningStepIndices: [],
      notConvergedReason: 'this program is not supported',
    },
    diagnostics,
  };
}
