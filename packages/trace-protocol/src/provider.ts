/**
 * AIViz Analysis Trace Protocol — provider (server) interface.
 *
 * Providers are separate processes speaking JSON-RPC 2.0 over stdio. They may
 * be written in any language; the client only requires the four methods below.
 * Nothing here is specific to abstract interpretation, C, or LLVM — a provider
 * for a different analysis or language implements the same surface.
 */

import type { AnalysisTrace, Diagnostic } from './trace.js';

export interface DomainInfo {
  id: string;
  name: string;
  description?: string;
  /** Whether the provider shipped this domain or discovered it in a trusted workspace. */
  origin?: 'built-in' | 'workspace';
  /** True if the domain's lattice is finite and can be drawn as a Hasse diagram. */
  finiteLattice?: boolean;
}

/** A problem found while discovering optional workspace domains. These are
 * provider-level diagnostics, not source-program diagnostics, so no source
 * line is required. */
export interface ProviderDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  path?: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  version: string;
  /** Protocol version the provider implements. */
  protocolVersion: string;
  /** Language ids, e.g. `['c']`. */
  languages: string[];
  domains: DomainInfo[];
  /** Discovery failures do not prevent built-in domains from being advertised. */
  domainDiagnostics?: ProviderDiagnostic[];
  capabilities?: {
    /** Provider can emit `narrow` steps. */
    narrowing?: boolean;
    /** Provider populates `LossItem` on widening steps. */
    wideningLoss?: boolean;
    /** Provider can describe finite lattices for the lattice view. */
    latticeGraph?: boolean;
  };
  /** Human-readable description of the accepted language subset. */
  supportedSubset?: string;
}

export interface FunctionInfo {
  name: string;
  line: number;
  supported: boolean;
  /** Why it is unsupported. Shown on hover in the function dropdown. */
  reason?: string;
}

export interface DocumentRequest {
  file: string;
  source: string;
}

export interface ListFunctionsResult {
  functions: FunctionInfo[];
}

export interface PrecheckRequest extends DocumentRequest {
  function: string;
}

export interface PrecheckResult {
  supported: boolean;
  diagnostics: Diagnostic[];
}

export interface AnalyzeRequest extends DocumentRequest {
  function: string;
  /** Domain id, as advertised in `ProviderInfo.domains`. */
  domain: string;
  config?: {
    /** Iterations at a loop header before widening kicks in. Default 1. */
    wideningDelay?: number;
    /** Run narrowing passes after the ascending phase. Default true. */
    narrowing?: boolean;
    /** Abort after this many iterations rather than hanging. Default 200. */
    maxIterations?: number;
    /** Abort after this many milliseconds. Default 10000. */
    timeoutMs?: number;
  };
}

/**
 * The provider contract. Implemented server-side; the client calls it over RPC.
 */
export interface AnalysisProvider {
  initialize(): Promise<ProviderInfo> | ProviderInfo;
  listFunctions(
    req: DocumentRequest
  ): Promise<ListFunctionsResult> | ListFunctionsResult;
  precheck(req: PrecheckRequest): Promise<PrecheckResult> | PrecheckResult;
  /**
   * Runs the analysis to completion and returns the whole trace.
   *
   * If the program is unsupported, return a trace with `diagnostics` populated,
   * empty `steps`, and `summary.converged === false` rather than throwing.
   */
  analyze(req: AnalyzeRequest): Promise<AnalysisTrace> | AnalysisTrace;
}

/** JSON-RPC method names, so client and server cannot drift apart. */
export const RPC_METHODS = {
  initialize: 'aiviz/initialize',
  listFunctions: 'aiviz/listFunctions',
  precheck: 'aiviz/precheck',
  analyze: 'aiviz/analyze',
} as const;

export type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

/** Manifest each provider ships as `provider.json`. */
export interface ProviderManifest {
  id: string;
  name: string;
  version: string;
  languages: string[];
  /** How to launch the provider process. */
  command: string;
  args?: string[];
  /** Path relative to the manifest, used for bundled providers. */
  cwd?: string;
}
