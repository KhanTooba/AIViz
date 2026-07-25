/**
 * The instrumented worklist fixpoint engine.
 *
 * This is the part no existing analyzer exposes: every state transition is
 * recorded as a `Step`, so the whole computation can be replayed like a
 * debugger. The trace is materialised eagerly, which is what makes `prev` a
 * pure index decrement and lets the iteration count be reported before the user
 * takes a single step.
 *
 * Determinism matters: blocks are always processed in reverse post-order, so
 * the same program and domain always produce byte-identical traces, which is
 * what makes golden-trace tests meaningful.
 */

import {
  PROTOCOL_VERSION,
  type AnalysisTrace,
  type Block,
  type Diagnostic,
  type DisplayState,
  type LineMap,
  type LineRange,
  type Step,
  type Summary,
} from '@aiviz/trace-protocol';
import type { Domain } from './domain.js';
import { dominates, findLoopHeaders, immediateDominators, reversePostOrder } from './dominators.js';
import { blockMap, condToString, exprToString, type Cfg, type CfgBlock } from './ir.js';

export interface EngineConfig {
  wideningDelay: number;
  narrowing: boolean;
  maxIterations: number;
  timeoutMs: number;
}

export const DEFAULT_CONFIG: EngineConfig = {
  wideningDelay: 1,
  narrowing: true,
  maxIterations: 200,
  timeoutMs: 10_000,
};

export interface AnalyzeMeta {
  provider: { id: string; name: string; version: string };
  file: string;
  functionName: string;
  language: string;
  diagnostics?: Diagnostic[];
}

class Engine<T> {
  private readonly steps: Step[] = [];
  private readonly inState = new Map<string, T>();
  private readonly outState = new Map<string, T>();
  /** State on each edge, after its guard has been applied. */
  private readonly edgeState = new Map<string, T>();
  private readonly visits = new Map<string, number>();
  private readonly blocks: Map<string, CfgBlock>;
  private readonly rpo: string[];
  private readonly rpoIndex: Map<string, number>;
  private readonly loopHeaders: Set<string>;
  /** Edges `u -> v` where v dominates u. Not every edge into a header is one. */
  private readonly backEdges: Set<string>;
  private readonly wideningPoints = new Set<string>();
  private round = 0;
  private notConverged?: string;
  private readonly deadline: number;

  constructor(
    private readonly cfg: Cfg,
    private readonly domain: Domain<T>,
    private readonly config: EngineConfig
  ) {
    this.blocks = blockMap(cfg);
    this.rpo = reversePostOrder(cfg);
    this.rpoIndex = new Map(this.rpo.map((id, i) => [id, i]));
    this.loopHeaders = findLoopHeaders(cfg);
    const idom = immediateDominators(cfg);
    this.backEdges = new Set(
      cfg.blocks.flatMap((b) =>
        b.succs
          .filter((e) => dominates(idom, e.target, b.id))
          .map((e) => `${b.id}->${e.target}`)
      )
    );
    this.deadline = Date.now() + config.timeoutMs;
  }

  private get vars(): string[] {
    return this.cfg.variables.map((v) => v.name);
  }

  private fmt(s: T): DisplayState {
    return this.domain.format(s);
  }

  private emit(step: Omit<Step, 'index'>): void {
    this.steps.push({ ...step, index: this.steps.length });
  }

  private edgeKey(from: string, to: string): string {
    return `${from}->${to}`;
  }

  /** Incoming states for a block, one per reachable predecessor edge. */
  private incoming(id: string): { from: string; state: T }[] {
    const block = this.blocks.get(id);
    if (!block) return [];
    const out: { from: string; state: T }[] = [];
    for (const p of block.preds) {
      const s = this.edgeState.get(this.edgeKey(p, id));
      if (s !== undefined) out.push({ from: p, state: s });
    }
    return out;
  }

  private equal(a: T, b: T): boolean {
    return this.domain.leq(a, b) && this.domain.leq(b, a);
  }

  run(): { steps: Step[]; summary: Summary } {
    this.ascending();
    if (this.config.narrowing && !this.notConverged) {
      this.descending();
    }

    const wideningStepIndices = this.steps
      .filter((s) => s.kind === 'widen')
      .map((s) => s.index);
    const lastStabilize = [...this.steps].reverse().find((s) => s.kind === 'stabilize');

    const summary: Summary = {
      iterations: this.round,
      stepCount: this.steps.length,
      converged: this.notConverged === undefined,
      wideningPoints: [...this.wideningPoints],
      wideningStepIndices,
      ...(lastStabilize ? { stabilizedAtStep: lastStabilize.index } : {}),
      ...(this.notConverged ? { notConvergedReason: this.notConverged } : {}),
    };
    return { steps: this.steps, summary };
  }

  /** Worklist ordered by RPO index, so results are deterministic. */
  private drain(phase: 'ascending' | 'narrowing', seed: string[]): void {
    const pending = new Set(seed);
    let guard = 0;
    const cap = this.config.maxIterations * Math.max(4, this.cfg.blocks.length);

    while (pending.size > 0) {
      if (++guard > cap) {
        this.notConverged = `did not converge within ${this.config.maxIterations} iterations`;
        return;
      }
      if (Date.now() > this.deadline) {
        this.notConverged = `analysis exceeded ${this.config.timeoutMs} ms`;
        return;
      }

      let best: string | undefined;
      let bestIdx = Infinity;
      for (const id of pending) {
        const idx = this.rpoIndex.get(id) ?? Infinity;
        if (idx < bestIdx) {
          bestIdx = idx;
          best = id;
        }
      }
      if (best === undefined) return;
      pending.delete(best);

      for (const next of this.processBlock(best, phase)) pending.add(next);
    }
  }

  private ascending(): void {
    const entry = this.cfg.entry;
    // The entry block's incoming state is unconstrained: any input is possible.
    this.edgeState.set(this.edgeKey('__start__', entry), this.domain.top(this.vars));
    const entryBlock = this.blocks.get(entry);
    if (entryBlock && !entryBlock.preds.includes('__start__')) {
      entryBlock.preds = ['__start__', ...entryBlock.preds];
    }

    this.emit({
      kind: 'push',
      blockId: entry,
      iteration: 0,
      before: this.fmt(this.domain.top(this.vars)),
      after: this.fmt(this.domain.top(this.vars)),
      worklist: { size: 1, next: entry },
      explanation:
        'Analysis starts at the entry block with no assumptions at all: every ' +
        'variable could hold any value.',
    });

    this.drain('ascending', [entry]);
  }

  private descending(): void {
    // Seed with *every* block, not just the entry. The entry's state is already
    // stable after the ascending phase, so it would stabilise immediately and
    // wake nobody, and the narrowing phase would never reach the loop header
    // where the widened bounds actually need refining.
    this.drain('narrowing', this.rpo);
  }

  /** Processes one block, returning successors that need (re)processing. */
  private processBlock(id: string, phase: 'ascending' | 'narrowing'): string[] {
    const block = this.blocks.get(id);
    if (!block) return [];

    const isHeader = this.loopHeaders.has(id);
    if (isHeader) this.round++;

    const incoming = this.incoming(id);
    if (incoming.length === 0) return [];

    // --- join incoming edges -------------------------------------------------
    let newIn = incoming.reduce(
      (acc, cur) => this.domain.join(acc, cur.state),
      this.domain.bottom()
    );
    const oldIn = this.inState.get(id) ?? this.domain.bottom();

    if (incoming.length > 1) {
      this.emit({
        kind: 'join',
        blockId: id,
        iteration: this.round,
        before: this.fmt(oldIn),
        after: this.fmt(newIn),
        inputs: incoming.map((i) => this.fmt(i.state)),
        changed: this.domain.changed(oldIn, newIn),
        explanation: this.explainJoin(incoming, newIn),
      });
    }

    // --- widening / narrowing at loop headers --------------------------------
    if (isHeader) {
      const visits = (this.visits.get(id) ?? 0) + 1;
      this.visits.set(id, visits);

      if (phase === 'ascending' && visits > this.config.wideningDelay) {
        const widened = this.domain.widen(oldIn, newIn);
        const loss = this.domain.lossReport(oldIn, newIn, widened);
        this.wideningPoints.add(id);
        this.emit({
          kind: 'widen',
          blockId: id,
          iteration: this.round,
          before: this.fmt(oldIn),
          after: this.fmt(widened),
          inputs: [this.fmt(oldIn), this.fmt(newIn)],
          changed: this.domain.changed(oldIn, widened),
          loss,
          explanation: this.explainWiden(oldIn, newIn, widened, loss.length > 0),
        });
        newIn = widened;
      } else if (phase === 'narrowing') {
        const narrowed = this.domain.narrow(oldIn, newIn);
        this.emit({
          kind: 'narrow',
          blockId: id,
          iteration: this.round,
          before: this.fmt(oldIn),
          after: this.fmt(narrowed),
          inputs: [this.fmt(oldIn), this.fmt(newIn)],
          changed: this.domain.changed(oldIn, narrowed),
          explanation: this.explainNarrow(oldIn, newIn, narrowed),
        });
        newIn = narrowed;
      }
    }

    // --- has anything changed? ----------------------------------------------
    const stable =
      phase === 'ascending' ? this.domain.leq(newIn, oldIn) : this.equal(newIn, oldIn);
    if (stable && this.inState.has(id)) {
      this.emit({
        kind: 'stabilize',
        blockId: id,
        iteration: this.round,
        before: this.fmt(oldIn),
        after: this.fmt(oldIn),
        worklist: { size: 0 },
        explanation:
          `${id}'s state stopped changing, so it is not queued again. ` +
          (phase === 'ascending'
            ? 'The ascending phase has reached a fixed point here.'
            : 'Narrowing has converged here.'),
      });
      return [];
    }

    this.inState.set(id, newIn);

    // --- transfer through the block's instructions ---------------------------
    let cur = newIn;
    for (const instr of block.instrs) {
      const before = cur;
      switch (instr.kind) {
        case 'assign':
          cur = this.domain.assign(cur, instr.target, instr.expr);
          break;
        case 'assume':
          cur = this.domain.assume(cur, instr.cond);
          break;
        case 'havoc':
          cur = this.domain.assign(cur, instr.target, { kind: 'nondet' });
          break;
      }
      this.emit({
        kind: 'transfer',
        blockId: id,
        iteration: this.round,
        before: this.fmt(before),
        after: this.fmt(cur),
        changed: this.domain.changed(before, cur),
        sourceSpan: instr.span,
        explanation: this.explainInstr(instr, before, cur),
      });
    }
    this.outState.set(id, cur);

    // --- propagate along outgoing edges, applying their guards ---------------
    const wake: string[] = [];
    for (const edge of block.succs) {
      let guarded = cur;
      if (edge.cond) {
        guarded = this.domain.assume(cur, edge.cond);
        this.emit({
          kind: 'transfer',
          blockId: id,
          iteration: this.round,
          before: this.fmt(cur),
          after: this.fmt(guarded),
          changed: this.domain.changed(cur, guarded),
          explanation: this.explainGuard(edge.label ?? condToString(edge.cond), cur, guarded),
        });
      }

      const key = this.edgeKey(id, edge.target);
      const prev = this.edgeState.get(key);
      this.edgeState.set(key, guarded);

      if (this.domain.isBottom(guarded)) continue;
      // Nothing new flows along this edge, so there is no reason to re-queue the
      // target. This applies in both phases; without it the descending phase can
      // cycle forever between a loop header and its body.
      if (prev !== undefined && this.equal(prev, guarded)) continue;

      wake.push(edge.target);
      this.emit({
        kind: 'push',
        blockId: edge.target,
        iteration: this.round,
        before: this.fmt(guarded),
        after: this.fmt(guarded),
        worklist: { size: wake.length, next: edge.target },
        explanation:
          `${edge.target} is queued with the state flowing out of ${id}` +
          (this.backEdges.has(key)
            ? '. This is a back edge to a loop header — the re-queueing is what makes the analysis iterate.'
            : '.'),
      });
    }
    return wake;
  }

  // --- narration -----------------------------------------------------------
  // Deterministic templates. No model is involved, so this works offline.

  private reprOf(s: T): string {
    const d = this.fmt(s);
    if (d.kind === 'bottom') return '⊥';
    return d.vars.map((v) => `${v.name} ↦ ${v.repr}`).join(', ') || '(no variables)';
  }

  private explainJoin(incoming: { from: string; state: T }[], result: T): string {
    const parts = incoming.map((i) => `${this.reprOf(i.state)} from ${i.from}`);
    return (
      `${incoming.length} edges reach this block: ${parts.join('; ')}. ` +
      `The analysis must account for every path, so it takes the least upper bound ` +
      `of them all, giving ${this.reprOf(result)}.`
    );
  }

  private explainWiden(old: T, next: T, widened: T, lost: boolean): string {
    if (!lost) {
      return (
        `The block already holds ${this.reprOf(old)}, and the newly computed ` +
        `${this.reprOf(next)} is contained in it. Nothing grew, so widening changes ` +
        `nothing — the ascending phase has reached its fixed point here.`
      );
    }
    return (
      `Values grew between iterations (${this.reprOf(old)} → ${this.reprOf(next)}). ` +
      `Rather than climbing one step at a time forever, widening pushes the growing ` +
      `bounds straight out to infinity, giving ${this.reprOf(widened)}. This is what ` +
      `guarantees the analysis terminates, and the precision below is what it costs.`
    );
  }

  private explainNarrow(old: T, next: T, narrowed: T): string {
    if (this.equal(old, narrowed)) {
      return (
        `Re-running gives ${this.reprOf(next)}, which leaves the current value ` +
        `unchanged, so narrowing has converged here.`
      );
    }
    return (
      `Narrowing re-runs the loop from the widened result to win precision back. ` +
      `The incoming edges give ${this.reprOf(next)}, and because the current bounds ` +
      `are the infinities widening invented, narrowing may adopt the finite ones: ` +
      `${this.reprOf(narrowed)}.`
    );
  }

  private explainInstr(
    instr: CfgBlock['instrs'][number],
    before: T,
    after: T
  ): string {
    if (this.domain.isBottom(after) && !this.domain.isBottom(before)) {
      return `\`${instr.text}\` cannot hold here, so this path is unreachable (⊥).`;
    }
    switch (instr.kind) {
      case 'assign':
        return (
          `\`${instr.text}\` evaluates ${exprToString(instr.expr)} in the current ` +
          `state and stores the result, so ${instr.target} becomes ` +
          `${this.varRepr(after, instr.target)}.`
        );
      case 'assume':
        return (
          `Assuming \`${condToString(instr.cond)}\` holds narrows the state to ` +
          `${this.reprOf(after)}.`
        );
      case 'havoc':
        return (
          `\`${instr.text}\` gives ${instr.target} a value the analysis cannot ` +
          `predict, so everything known about it is discarded.`
        );
    }
  }

  private explainGuard(label: string, before: T, after: T): string {
    if (this.domain.isBottom(after)) {
      return `The guard \`${label}\` cannot hold given ${this.reprOf(before)}, so this branch is unreachable.`;
    }
    if (this.equal(before, after)) {
      return `Taking this branch assumes \`${label}\`, which the current state already satisfies, so nothing is narrowed.`;
    }
    return (
      `Taking this branch assumes \`${label}\`. That is real information: it narrows ` +
      `${this.reprOf(before)} to ${this.reprOf(after)}.`
    );
  }

  private varRepr(s: T, name: string): string {
    const d = this.fmt(s);
    return d.vars.find((v) => v.name === name)?.repr ?? '⊥';
  }
}

/** Converts the internal CFG into the protocol's block representation. */
export function toProtocolCfg(cfg: Cfg, loopHeaders: Set<string>): Block[] {
  return cfg.blocks.map((b) => ({
    blockId: b.id,
    preds: b.preds.filter((p) => p !== '__start__'),
    succs: b.succs.map((s) => s.target),
    lines: b.lines,
    ...(loopHeaders.has(b.id) ? { isLoopHeader: true } : {}),
    ...(b.isEntry ? { isEntry: true } : {}),
    ...(b.isExit ? { isExit: true } : {}),
    ...(b.label ? { label: b.label } : {}),
  }));
}

export function buildLineMap(cfg: Cfg): LineMap {
  const lineToBlocks: Record<string, string[]> = {};
  const blockToLines: Record<string, LineRange[]> = {};
  const span = new Map<string, number>();

  for (const b of cfg.blocks) {
    blockToLines[b.id] = b.lines;
    let total = 0;
    for (const r of b.lines) total += r.end - r.start + 1;
    span.set(b.id, total);

    for (const r of b.lines) {
      for (let line = r.start; line <= r.end; line++) {
        const key = String(line);
        (lineToBlocks[key] ??= []).push(b.id);
      }
    }
  }

  // Best match is the tightest block covering the line: for a `for` header,
  // that picks the condition block over the whole-loop block.
  const bestBlockForLine: Record<string, string> = {};
  for (const [line, ids] of Object.entries(lineToBlocks)) {
    let best = ids[0]!;
    for (const id of ids) {
      if ((span.get(id) ?? Infinity) < (span.get(best) ?? Infinity)) best = id;
    }
    bestBlockForLine[line] = best;
  }
  return { lineToBlocks, blockToLines, bestBlockForLine };
}

export function analyze<T>(
  cfg: Cfg,
  domain: Domain<T>,
  meta: AnalyzeMeta,
  config: Partial<EngineConfig> = {}
): AnalysisTrace {
  const cfgCopy: Cfg = {
    ...cfg,
    blocks: cfg.blocks.map((b) => ({ ...b, preds: [...b.preds] })),
  };
  const full = { ...DEFAULT_CONFIG, ...config };
  const loopHeaders = findLoopHeaders(cfgCopy);
  const engine = new Engine(cfgCopy, domain, full);
  const { steps, summary } = engine.run();
  const latticeGraph = domain.latticeGraph?.();

  return {
    version: PROTOCOL_VERSION,
    provider: meta.provider,
    program: { file: meta.file, function: meta.functionName, language: meta.language },
    domain: { id: domain.id, name: domain.name, ...(latticeGraph ? { latticeGraph } : {}) },
    cfg: {
      entry: cfgCopy.entry,
      ...(cfgCopy.exit ? { exit: cfgCopy.exit } : {}),
      blocks: toProtocolCfg(cfgCopy, loopHeaders),
    },
    lineMap: buildLineMap(cfgCopy),
    variables: cfgCopy.variables,
    steps,
    summary,
    diagnostics: meta.diagnostics ?? [],
  };
}
