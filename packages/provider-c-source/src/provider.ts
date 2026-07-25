/**
 * The v1 reference provider: source-level C via tree-sitter.
 *
 * Implements the AIViz provider contract. Nothing here is aware of the VS Code
 * client — it takes source text and returns a trace.
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
import { findFunctions, functionName, parseC } from './parser.js';

const PROVIDER = {
  id: 'c-source',
  name: 'C (source-level, tree-sitter)',
  version: '0.1.0',
} as const;

export class CSourceProvider implements AnalysisProvider {
  initialize(): ProviderInfo {
    return {
      ...PROVIDER,
      protocolVersion: PROTOCOL_VERSION,
      languages: ['c'],
      domains: DOMAINS.map((d) => ({
        id: d.id,
        name: d.name,
        finiteLattice: d.finiteLattice,
      })),
      capabilities: { narrowing: true, wideningLoss: true, latticeGraph: true },
      supportedSubset:
        'Integer scalars only: int/bool locals, + - * / %, if/else, while, for, ' +
        'do-while, break, continue, return and nested loops. No pointers, arrays, ' +
        'structs, floats, goto, function calls or recursion.',
    };
  }

  async listFunctions(req: DocumentRequest): Promise<ListFunctionsResult> {
    const tree = await parseC(req.source);
    const functions = findFunctions(tree).map((fn) => {
      const name = functionName(fn) ?? '<anonymous>';
      const diagnostics = precheckFunction(fn);
      const first = diagnostics[0];
      return {
        name,
        line: fn.startPosition.row + 1,
        supported: diagnostics.length === 0,
        ...(first ? { reason: `${first.message} (line ${first.line})` } : {}),
      };
    });
    return { functions };
  }

  async precheck(req: PrecheckRequest): Promise<PrecheckResult> {
    const tree = await parseC(req.source);
    const fn = findFunctions(tree).find((f) => functionName(f) === req.function);
    if (!fn) {
      return {
        supported: false,
        diagnostics: [
          {
            severity: 'error',
            code: 'function.notFound',
            message: `no function named \`${req.function}\` in this file`,
            line: 1,
          },
        ],
      };
    }
    const diagnostics = precheckFunction(fn);
    return { supported: diagnostics.length === 0, diagnostics };
  }

  async analyze(req: AnalyzeRequest): Promise<AnalysisTrace> {
    const tree = await parseC(req.source);
    const fn = findFunctions(tree).find((f) => functionName(f) === req.function);
    if (!fn) {
      return unsupportedTrace(req, [
        {
          severity: 'error',
          code: 'function.notFound',
          message: `no function named \`${req.function}\` in this file`,
          line: 1,
        },
      ]);
    }

    const diagnostics = precheckFunction(fn);
    if (diagnostics.length > 0) {
      return unsupportedTrace(req, diagnostics, fn.startPosition.row + 1);
    }

    const domain = domainById(req.domain);
    if (!domain) {
      return unsupportedTrace(req, [
        {
          severity: 'error',
          code: 'domain.unknown',
          message: `unknown domain \`${req.domain}\``,
          line: 1,
        },
      ]);
    }

    const cfg = buildCfg(fn);
    return analyze(
      cfg,
      domain,
      {
        provider: PROVIDER,
        file: req.file,
        functionName: req.function,
        language: 'c',
      },
      req.config ?? {}
    );
  }
}

/**
 * A protocol-valid trace carrying only diagnostics.
 *
 * The client renders the reasons instead of a graph, so an unsupported program
 * is a clear message rather than a blank panel or an exception.
 */
function unsupportedTrace(
  req: AnalyzeRequest,
  diagnostics: Diagnostic[],
  line = 1
): AnalysisTrace {
  return {
    version: PROTOCOL_VERSION,
    provider: PROVIDER,
    program: { file: req.file, function: req.function, language: 'c' },
    domain: { id: req.domain, name: req.domain },
    cfg: {
      entry: 'b0',
      blocks: [
        {
          blockId: 'b0',
          preds: [],
          succs: [],
          lines: [{ start: line, end: line }],
          isEntry: true,
          label: req.function,
        },
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
