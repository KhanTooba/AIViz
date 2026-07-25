/**
 * Structural validator for analysis traces.
 *
 * Third-party providers run this (via the `aiviz-validate` CLI) to check their
 * output before the client ever sees it. It deliberately checks *internal
 * consistency* — dangling block references, broken line maps, mislabelled
 * widening indices — not just field presence, because those are the failures
 * that actually break the UI.
 */

import {
  PROTOCOL_VERSION,
  type AnalysisTrace,
  type Block,
  type DisplayState,
  type Step,
} from './trace.js';

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

class Checker {
  readonly issues: ValidationIssue[] = [];

  fail(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  require(cond: boolean, path: string, message: string): boolean {
    if (!cond) this.fail(path, message);
    return cond;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function majorOf(version: string): string | undefined {
  return /^(\d+)\./.exec(version)?.[1];
}

function checkState(c: Checker, state: unknown, path: string): void {
  if (!isObject(state)) {
    c.fail(path, 'expected a DisplayState object');
    return;
  }
  const kind = state.kind;
  if (kind !== 'bottom' && kind !== 'state') {
    c.fail(`${path}.kind`, `expected "bottom" or "state", got ${String(kind)}`);
  }
  if (!Array.isArray(state.vars)) {
    c.fail(`${path}.vars`, 'expected an array');
    return;
  }
  if (kind === 'bottom' && state.vars.length > 0) {
    c.fail(`${path}.vars`, 'a bottom state must carry no variables');
  }
  state.vars.forEach((v, i) => {
    if (!isObject(v)) {
      c.fail(`${path}.vars[${i}]`, 'expected a VarValue object');
      return;
    }
    if (typeof v.name !== 'string') {
      c.fail(`${path}.vars[${i}].name`, 'expected a string');
    }
    if (typeof v.repr !== 'string') {
      c.fail(`${path}.vars[${i}].repr`, 'expected a string');
    }
    if (v.kind !== 'top' && v.kind !== 'bottom' && v.kind !== 'value') {
      c.fail(`${path}.vars[${i}].kind`, 'expected "top" | "bottom" | "value"');
    }
  });
}

function checkBlocks(c: Checker, blocks: Block[], entry: string): Set<string> {
  const ids = new Set<string>();
  blocks.forEach((b, i) => {
    const path = `cfg.blocks[${i}]`;
    if (typeof b.blockId !== 'string' || b.blockId.length === 0) {
      c.fail(`${path}.blockId`, 'expected a non-empty string');
      return;
    }
    if (ids.has(b.blockId)) {
      c.fail(`${path}.blockId`, `duplicate block id "${b.blockId}"`);
    }
    ids.add(b.blockId);

    if (!Array.isArray(b.lines)) {
      c.fail(`${path}.lines`, 'expected an array of LineRange');
    } else {
      b.lines.forEach((r, j) => {
        if (!isObject(r) || typeof r.start !== 'number' || typeof r.end !== 'number') {
          c.fail(`${path}.lines[${j}]`, 'expected {start, end} numbers');
        } else if (r.start > r.end) {
          c.fail(`${path}.lines[${j}]`, `start ${r.start} is after end ${r.end}`);
        } else if (r.start < 1) {
          c.fail(`${path}.lines[${j}]`, 'lines are 1-based; start must be >= 1');
        }
      });
    }
  });

  // Edges must reference blocks that exist, and must agree with each other.
  const byId = new Map(blocks.map((b) => [b.blockId, b]));
  for (const b of blocks) {
    for (const s of b.succs ?? []) {
      if (!ids.has(s)) {
        c.fail(`cfg.blocks[${b.blockId}].succs`, `unknown block "${s}"`);
        continue;
      }
      if (!(byId.get(s)?.preds ?? []).includes(b.blockId)) {
        c.fail(
          `cfg.blocks[${b.blockId}].succs`,
          `edge ${b.blockId} -> ${s} is not mirrored in ${s}.preds`
        );
      }
    }
    for (const p of b.preds ?? []) {
      if (!ids.has(p)) {
        c.fail(`cfg.blocks[${b.blockId}].preds`, `unknown block "${p}"`);
      }
    }
  }

  if (!ids.has(entry)) {
    c.fail('cfg.entry', `entry block "${entry}" is not in cfg.blocks`);
  }
  return ids;
}

function checkLatticeGraph(c: Checker, graph: unknown): void {
  if (graph === undefined) return; // absent means "infinite lattice", not an error
  if (!isObject(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    c.fail('domain.latticeGraph', 'expected { nodes, edges }');
    return;
  }
  const ids = new Set<string>();
  graph.nodes.forEach((n, i) => {
    if (!isObject(n) || typeof n.id !== 'string' || typeof n.label !== 'string') {
      c.fail(`domain.latticeGraph.nodes[${i}]`, 'expected { id, label } strings');
      return;
    }
    if (ids.has(n.id)) c.fail(`domain.latticeGraph.nodes[${i}].id`, `duplicate id "${n.id}"`);
    ids.add(n.id);
  });
  (graph.edges as unknown[]).forEach((e, i) => {
    if (!Array.isArray(e) || e.length !== 2) {
      c.fail(`domain.latticeGraph.edges[${i}]`, 'expected a [lower, upper] pair');
      return;
    }
    const [lower, upper] = e as [unknown, unknown];
    if (typeof lower !== 'string' || !ids.has(lower)) {
      c.fail(`domain.latticeGraph.edges[${i}]`, `unknown node "${String(lower)}"`);
    }
    if (typeof upper !== 'string' || !ids.has(upper)) {
      c.fail(`domain.latticeGraph.edges[${i}]`, `unknown node "${String(upper)}"`);
    }
  });
}

function checkSteps(c: Checker, steps: Step[], blockIds: Set<string>): void {
  steps.forEach((s, i) => {
    const path = `steps[${i}]`;
    if (s.index !== i) {
      c.fail(`${path}.index`, `expected ${i}, got ${String(s.index)}`);
    }
    const kinds = ['transfer', 'join', 'widen', 'narrow', 'push', 'stabilize'];
    if (!kinds.includes(s.kind)) {
      c.fail(`${path}.kind`, `unknown step kind "${String(s.kind)}"`);
    }
    if (!blockIds.has(s.blockId)) {
      c.fail(`${path}.blockId`, `unknown block "${s.blockId}"`);
    }
    if (typeof s.iteration !== 'number' || s.iteration < 0) {
      c.fail(`${path}.iteration`, 'expected a non-negative number');
    }
    if (typeof s.explanation !== 'string' || s.explanation.length === 0) {
      c.fail(`${path}.explanation`, 'every step must carry a narration');
    }
    checkState(c, s.before, `${path}.before`);
    checkState(c, s.after, `${path}.after`);

    if (s.kind === 'join' || s.kind === 'widen' || s.kind === 'narrow') {
      if (!Array.isArray(s.inputs) || s.inputs.length < 2) {
        c.fail(`${path}.inputs`, `a ${s.kind} step needs at least two operands`);
      } else {
        (s.inputs as DisplayState[]).forEach((i2, j) =>
          checkState(c, i2, `${path}.inputs[${j}]`)
        );
      }
    }
    if (s.kind === 'widen' && s.loss !== undefined && !Array.isArray(s.loss)) {
      c.fail(`${path}.loss`, 'expected an array of LossItem');
    }
    if (s.kind !== 'widen' && s.loss !== undefined) {
      c.fail(`${path}.loss`, 'loss is only meaningful on widen steps');
    }
  });
}

export function validateTrace(input: unknown): ValidationResult {
  const c = new Checker();

  if (!isObject(input)) {
    return { valid: false, issues: [{ path: '', message: 'trace must be an object' }] };
  }
  const t = input as unknown as AnalysisTrace;

  if (typeof t.version !== 'string') {
    c.fail('version', 'expected a protocol version string');
  } else if (majorOf(t.version) !== majorOf(PROTOCOL_VERSION)) {
    // 0.x is pre-stable, so compare the whole minor too.
    if (t.version !== PROTOCOL_VERSION) {
      c.fail(
        'version',
        `trace targets protocol ${t.version}, this build speaks ${PROTOCOL_VERSION}`
      );
    }
  }

  for (const field of ['provider', 'program', 'domain', 'cfg', 'lineMap', 'summary'] as const) {
    if (!isObject(t[field])) c.fail(field, 'missing or not an object');
  }
  for (const field of ['variables', 'steps', 'diagnostics'] as const) {
    if (!Array.isArray(t[field])) c.fail(field, 'missing or not an array');
  }
  if (c.issues.length > 0) {
    return { valid: false, issues: c.issues };
  }

  const blockIds = checkBlocks(c, t.cfg.blocks ?? [], t.cfg.entry);
  checkSteps(c, t.steps, blockIds);
  checkLatticeGraph(c, t.domain.latticeGraph);

  // Line map must point only at real blocks, and must round-trip.
  for (const [line, ids] of Object.entries(t.lineMap.lineToBlocks ?? {})) {
    if (!/^\d+$/.test(line)) {
      c.fail(`lineMap.lineToBlocks["${line}"]`, 'key must be a line number');
    }
    for (const id of ids) {
      if (!blockIds.has(id)) {
        c.fail(`lineMap.lineToBlocks["${line}"]`, `unknown block "${id}"`);
      }
    }
  }
  for (const id of Object.keys(t.lineMap.blockToLines ?? {})) {
    if (!blockIds.has(id)) {
      c.fail(`lineMap.blockToLines["${id}"]`, `unknown block "${id}"`);
    }
  }
  for (const [line, id] of Object.entries(t.lineMap.bestBlockForLine ?? {})) {
    const candidates = t.lineMap.lineToBlocks?.[line] ?? [];
    if (!candidates.includes(id)) {
      c.fail(
        `lineMap.bestBlockForLine["${line}"]`,
        `"${id}" is not among that line's blocks`
      );
    }
  }

  // The summary drives the UI's counters and the step-over button, so it has to
  // agree with the steps array rather than being independently authored.
  const s = t.summary;
  if (s.stepCount !== t.steps.length) {
    c.fail('summary.stepCount', `says ${s.stepCount}, but there are ${t.steps.length} steps`);
  }
  const actualWidenIdx = t.steps.filter((x) => x.kind === 'widen').map((x) => x.index);
  const declared = s.wideningStepIndices ?? [];
  if (declared.join(',') !== actualWidenIdx.join(',')) {
    c.fail(
      'summary.wideningStepIndices',
      `declares [${declared.join(', ')}] but widen steps are at [${actualWidenIdx.join(', ')}]`
    );
  }
  for (const b of s.wideningPoints ?? []) {
    if (!blockIds.has(b)) {
      c.fail('summary.wideningPoints', `unknown block "${b}"`);
    }
  }
  if (s.converged === false && !s.notConvergedReason) {
    c.fail('summary.notConvergedReason', 'required when converged is false');
  }
  if (s.stabilizedAtStep !== undefined) {
    if (s.stabilizedAtStep < 0 || s.stabilizedAtStep >= t.steps.length) {
      c.fail('summary.stabilizedAtStep', 'out of range of the steps array');
    }
  }

  return { valid: c.issues.length === 0, issues: c.issues };
}
