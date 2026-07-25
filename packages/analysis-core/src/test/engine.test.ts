import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTrace } from '@aiviz/trace-protocol';
import type { AnalysisTrace, Step } from '@aiviz/trace-protocol';
import { analyze, type AnalyzeMeta } from '../engine.js';
import { findLoopHeaders } from '../dominators.js';
import type { Cfg, Cond, Expr, SourceSpan } from '../ir.js';
import { intervalDomain } from '../domains/intervals.js';
import { signDomain } from '../domains/sign.js';
import { constDomain } from '../domains/constprop.js';
import type { Domain } from '../domain.js';

const span = (line: number): SourceSpan => ({
  startLine: line,
  startColumn: 1,
  endLine: line,
  endColumn: 20,
});

const v = (name: string): Expr => ({ kind: 'var', name });
const n = (value: number): Expr => ({ kind: 'const', value });
const lt = (a: Expr, b: Expr): Cond => ({ kind: 'cmp', op: '<', left: a, right: b });
const ge = (a: Expr, b: Expr): Cond => ({ kind: 'cmp', op: '>=', left: a, right: b });

/**
 * The canonical teaching program:
 *
 *   1 int count(void) {
 *   2   int i = 0;
 *   3   while (i < 10) {
 *   4     i = i + 1;
 *   5   }
 *   6   return i;
 *   7 }
 */
function countLoop(): Cfg {
  return {
    entry: 'b0',
    exit: 'b3',
    variables: [{ name: 'i', type: 'int', declLine: 2 }],
    blocks: [
      {
        id: 'b0',
        isEntry: true,
        preds: [],
        succs: [{ target: 'b1' }],
        lines: [{ start: 2, end: 2 }],
        label: 'int i = 0;',
        instrs: [
          { kind: 'assign', target: 'i', expr: n(0), span: span(2), text: 'int i = 0;' },
        ],
      },
      {
        id: 'b1',
        preds: ['b0', 'b2'],
        succs: [
          { target: 'b2', cond: lt(v('i'), n(10)), label: 'i < 10' },
          { target: 'b3', cond: ge(v('i'), n(10)), label: '!(i < 10)' },
        ],
        lines: [{ start: 3, end: 3 }],
        label: 'while (i < 10)',
        instrs: [],
      },
      {
        id: 'b2',
        preds: ['b1'],
        succs: [{ target: 'b1' }],
        lines: [{ start: 4, end: 4 }],
        label: 'i = i + 1;',
        instrs: [
          {
            kind: 'assign',
            target: 'i',
            expr: { kind: 'binary', op: '+', left: v('i'), right: n(1) },
            span: span(4),
            text: 'i = i + 1;',
          },
        ],
      },
      {
        id: 'b3',
        isExit: true,
        preds: ['b1'],
        succs: [],
        lines: [{ start: 6, end: 6 }],
        label: 'return i;',
        instrs: [],
      },
    ],
  };
}

const META: AnalyzeMeta = {
  provider: { id: 'test', name: 'test', version: '0.1.0' },
  file: 'examples/count.c',
  functionName: 'count',
  language: 'c',
};

function run(domain: Domain<never>): AnalysisTrace {
  return analyze(countLoop(), domain as never, META);
}

/** The state pushed into a block by the last push step targeting it. */
function lastPushInto(trace: AnalysisTrace, blockId: string): Step | undefined {
  return [...trace.steps].reverse().find((s) => s.kind === 'push' && s.blockId === blockId);
}

function reprOf(step: Step | undefined, name: string): string | undefined {
  return step?.after.vars.find((x) => x.name === name)?.repr;
}

test('finds the loop header via dominators', () => {
  const headers = findLoopHeaders(countLoop());
  assert.deepEqual([...headers], ['b1']);
});

test('interval analysis converges and produces a protocol-valid trace', () => {
  const trace = run(intervalDomain as never);
  const result = validateTrace(trace);
  assert.deepEqual(result.issues, []);
  assert.equal(trace.summary.converged, true);
});

test('widening happens at the loop header and reports the discarded bound', () => {
  const trace = run(intervalDomain as never);
  assert.deepEqual(trace.summary.wideningPoints, ['b1']);

  const widenSteps = trace.steps.filter((s) => s.kind === 'widen');
  assert.ok(widenSteps.length > 0, 'expected at least one widening step');

  const withLoss = widenSteps.find((s) => (s.loss ?? []).length > 0);
  assert.ok(withLoss, 'expected a widening that actually discarded precision');

  const loss = withLoss.loss![0]!;
  assert.equal(loss.name, 'i');
  assert.equal(loss.lostBound, 'upper');
  // The whole point: join alone would have been finite, widening was not.
  assert.equal(loss.joined, '[0, 1]');
  assert.equal(loss.widened, '[0, +∞)');
});

test('narrowing recovers the exact exit value i = [10, 10]', () => {
  const trace = run(intervalDomain as never);
  // Leaving the loop assumes i >= 10; combined with the invariant [0, 10] that
  // pins i exactly. Recovering this is precisely what narrowing buys.
  assert.equal(reprOf(lastPushInto(trace, 'b3'), 'i'), '[10, 10]');
});

test('without narrowing the exit value stays imprecise', () => {
  const trace = analyze(countLoop(), intervalDomain as never, META, { narrowing: false });
  assert.equal(reprOf(lastPushInto(trace, 'b3'), 'i'), '[10, +∞)');
});

test('step-over-widening indices agree with the actual widen steps', () => {
  const trace = run(intervalDomain as never);
  const actual = trace.steps.filter((s) => s.kind === 'widen').map((s) => s.index);
  assert.deepEqual(trace.summary.wideningStepIndices, actual);
  assert.ok(actual.length > 0);
});

test('every step carries a non-empty narration', () => {
  for (const domain of [intervalDomain, signDomain, constDomain]) {
    const trace = run(domain as never);
    for (const step of trace.steps) {
      assert.ok(
        step.explanation.trim().length > 0,
        `${domain.id} step ${step.index} (${step.kind}) has no explanation`
      );
    }
  }
});

test('all three v1 domains converge on the same program', () => {
  for (const domain of [intervalDomain, signDomain, constDomain]) {
    const trace = run(domain as never);
    assert.equal(trace.summary.converged, true, `${domain.id} failed to converge`);
    assert.deepEqual(validateTrace(trace).issues, [], `${domain.id} produced an invalid trace`);
  }
});

test('Sign converges in no more iterations than Intervals', () => {
  // The comparison-mode headline: a coarser lattice stabilises sooner. Sign has
  // finite height, so it cannot climb as long as Intervals does.
  const intervals = run(intervalDomain as never);
  const sign = run(signDomain as never);
  assert.ok(
    sign.summary.iterations <= intervals.summary.iterations,
    `expected Sign (${sign.summary.iterations}) <= Intervals (${intervals.summary.iterations})`
  );
});

test('Sign proves i is non-negative at the exit', () => {
  const trace = run(signDomain as never);
  const repr = reprOf(lastPushInto(trace, 'b3'), 'i');
  // i starts at 0 and only increments, so Sign should see + (or >=0).
  assert.ok(repr === '+' || repr === '≥0', `expected + or >=0, got ${String(repr)}`);
});

test('constant propagation collapses to top when the loop merges values', () => {
  const trace = run(constDomain as never);
  const repr = reprOf(lastPushInto(trace, 'b3'), 'i');
  // 0 and 1 have no common constant, so the join goes straight to top.
  assert.equal(repr, '⊤');
});

test('a program that would diverge without widening still terminates', () => {
  // `while (i >= 0) i = i + 1;` has no finite invariant without widening.
  const cfg = countLoop();
  const header = cfg.blocks.find((b) => b.id === 'b1')!;
  header.succs = [
    { target: 'b2', cond: ge(v('i'), n(0)), label: 'i >= 0' },
    { target: 'b3', cond: lt(v('i'), n(0)), label: '!(i >= 0)' },
  ];
  const trace = analyze(cfg, intervalDomain as never, META);
  assert.equal(trace.summary.converged, true);
  assert.ok(trace.steps.length < 500, 'trace should stay small, not blow up');
});

test('the line map is one-to-many and every entry points at a real block', () => {
  const trace = run(intervalDomain as never);
  const ids = new Set(trace.cfg.blocks.map((b) => b.blockId));
  for (const [, blocks] of Object.entries(trace.lineMap.lineToBlocks)) {
    for (const b of blocks) assert.ok(ids.has(b), `line map references unknown block ${b}`);
  }
  assert.deepEqual(trace.lineMap.lineToBlocks['3'], ['b1']);
  assert.deepEqual(trace.lineMap.blockToLines['b2'], [{ start: 4, end: 4 }]);
});

test('traces are deterministic across runs', () => {
  // Golden-trace tests are only meaningful if the engine is reproducible.
  const a = run(intervalDomain as never);
  const b = run(intervalDomain as never);
  assert.equal(JSON.stringify(a.steps), JSON.stringify(b.steps));
});
