/**
 * AIViz Analysis Trace Protocol — trace types.
 *
 * This is the contract between an analysis provider (server) and the VS Code
 * client. The client renders traces; it never computes analysis and never needs
 * to understand a domain's internal representation.
 *
 * All line and column numbers are 1-based.
 */

/** Semantic version of the protocol itself. */
export const PROTOCOL_VERSION = '0.1.0';

/** An inclusive run of source lines. */
export interface LineRange {
  start: number;
  end: number;
}

/** A precise source region, used to point at the statement a step came from. */
export interface SourceSpan {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface HasseNode {
  id: string;
  /** Display label, e.g. `+`, `≤0`, `⊤`. Matches a `VarValue.repr`
   * for the domain, which is how the client finds "where a value sits". */
  label: string;
}

/**
 * A finite lattice's structure, wire-carried so a provider can supply the
 * shape for a domain the client has never seen (e.g. a v2 Parity domain from
 * a third-party provider). Only meaningful for finite lattices — an infinite
 * one (Intervals, Constant Propagation) has no finite Hasse diagram, and the
 * client instead plots the ascending chain a variable actually traversed.
 */
export interface HasseDiagram {
  nodes: HasseNode[];
  /** `[lower, upper]` covering pairs, drawn bottom-to-top. */
  edges: [string, string][];
}

export interface DomainRef {
  id: string;
  name: string;
  /** Present only for finite lattices. */
  latticeGraph?: HasseDiagram;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/**
 * Why a program (or one function) could not be analysed. Providers must give an
 * exact line and a human-readable reason — "unsupported" alone is not useful.
 */
export interface Diagnostic {
  severity: DiagnosticSeverity;
  /** Stable machine-readable code, e.g. `unsupported.pointer`. */
  code: string;
  message: string;
  line: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

/**
 * A single variable's abstract value, already rendered for display.
 *
 * Domains differ wildly in representation (a sign element, an interval, a
 * constant, a DBM row) so the protocol deliberately carries only a string plus
 * a coarse classification. This is what keeps the client domain-agnostic.
 */
export interface VarValue {
  name: string;
  /** Display form, e.g. `[0, 10]`, `+`, `3`, `⊤`. */
  repr: string;
  kind: 'top' | 'bottom' | 'value';
}

/** The abstract state at a program point. */
export interface DisplayState {
  /** `bottom` means unreachable; `vars` is empty in that case. */
  kind: 'bottom' | 'state';
  vars: VarValue[];
  /**
   * Cross-variable facts a relational domain wants to surface, e.g.
   * `i - total ≤ 5`. A non-relational domain (Intervals, Sign, ...) never
   * sets this — each variable's own value is already the whole story for
   * those. Absent means "nothing to show here", not "no constraints exist".
   */
  constraints?: string[];
}

export interface VarMeta {
  name: string;
  /** Source type as written, e.g. `int`. */
  type: string;
  declLine?: number;
}

export interface Block {
  blockId: string;
  preds: string[];
  succs: string[];
  /**
   * Source lines belonging to this block. Deliberately a *set* of ranges: an
   * LLVM-IR provider produces genuinely non-contiguous line sets, and even a
   * source-level provider does for loop latches.
   */
  lines: LineRange[];
  isLoopHeader?: boolean;
  isEntry?: boolean;
  isExit?: boolean;
  /** Short human label for the node, e.g. `while (i < n)`. */
  label?: string;
  meta?: Record<string, unknown>;
}

export interface Cfg {
  entry: string;
  exit?: string;
  blocks: Block[];
}

/**
 * Bidirectional source <-> CFG mapping.
 *
 * `lineToBlocks` is one-to-many by design: `for (i = 0; i < n; i++)` is three
 * distinct program points (init, condition, latch) sitting on one source line.
 * The client highlights the whole set and emphasises `bestBlockForLine`.
 */
export interface LineMap {
  /** Keys are line numbers as strings, because this crosses a JSON boundary. */
  lineToBlocks: Record<string, string[]>;
  blockToLines: Record<string, LineRange[]>;
  bestBlockForLine?: Record<string, string>;
}

export type StepKind =
  | 'transfer'
  | 'join'
  | 'widen'
  | 'narrow'
  | 'push'
  | 'stabilize';

/**
 * What a widening threw away.
 *
 * Widening is the step users least understand, so the protocol makes its cost
 * explicit rather than leaving it implicit in the resulting state: `joined` is
 * what the join alone would have produced, `widened` is what we settled for.
 */
export interface LossItem {
  name: string;
  before: string;
  /** What plain join would have given — the precision actually sacrificed. */
  joined: string;
  widened: string;
  lostBound: 'lower' | 'upper' | 'both' | 'relation';
  message: string;
}

export interface Step {
  /** Index into `AnalysisTrace.steps`; navigation is pure index arithmetic. */
  index: number;
  kind: StepKind;
  blockId: string;
  /** Which fixpoint iteration this step belongs to. */
  iteration: number;
  before: DisplayState;
  after: DisplayState;
  /** Operands for `join`, `widen` and `narrow`. */
  inputs?: DisplayState[];
  /** Deterministic plain-language narration. Never LLM-generated. */
  explanation: string;
  /** Names of variables whose value changed in this step. */
  changed?: string[];
  /** Present only on `widen` steps. */
  loss?: LossItem[];
  worklist?: { size: number; next?: string };
  /** The statement this step corresponds to, when one exists. */
  sourceSpan?: SourceSpan;
}

export interface Summary {
  /** Fixpoint iterations required. Known before stepping begins. */
  iterations: number;
  stepCount: number;
  converged: boolean;
  /** Index of the step at which the analysis stabilised. */
  stabilizedAtStep?: number;
  /** Blocks at which widening was applied. */
  wideningPoints: string[];
  /** Step indices where `kind === 'widen'`; powers "step over widening". */
  wideningStepIndices: number[];
  /** Set when `converged` is false, e.g. iteration cap or timeout hit. */
  notConvergedReason?: string;
}

/**
 * A complete, self-contained record of one analysis run.
 *
 * Materialised in full before the user steps through it, which is what makes
 * `prev` a pure index decrement and lets the iteration count be reported up
 * front. It is also plain JSON, so traces are shareable and replayable offline.
 */
export interface AnalysisTrace {
  version: string;
  provider: { id: string; name: string; version: string };
  program: { file: string; function: string; language: string };
  domain: DomainRef;
  cfg: Cfg;
  lineMap: LineMap;
  variables: VarMeta[];
  steps: Step[];
  summary: Summary;
  diagnostics: Diagnostic[];
}
