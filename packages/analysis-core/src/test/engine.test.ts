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
import { parityDomain } from '../domains/parity.js';
import { congruenceDomain } from '../domains/congruence.js';
import { zonesDomain } from '../domains/zones.js';
import { octagonsDomain } from '../domains/octagons.js';
import { zonotopesDomain } from '../domains/zonotopes.js';
import { polyhedraDomain } from '../domains/polyhedra.js';
import type { Domain } from '../domain.js';

const ALL_DOMAINS = [intervalDomain, signDomain, constDomain, parityDomain, congruenceDomain];

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
const add = (a: Expr, b: Expr): Expr => ({ kind: 'binary', op: '+', left: a, right: b });

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

test('all five domains converge on the same program', () => {
  for (const domain of ALL_DOMAINS) {
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

test('the trace carries a Hasse diagram for a finite lattice (Sign)', () => {
  const trace = run(signDomain as never);
  const graph = trace.domain.latticeGraph;
  assert.ok(graph, 'expected Sign to publish a latticeGraph over the wire');
  assert.equal(graph!.nodes.length, 8);
  assert.equal(validateTrace(trace).issues.length, 0);

  // Every VarValue.repr the domain ever emits must be a real node label —
  // that agreement is what lets the client find "where a value sits" in the
  // diagram with nothing more than a string match.
  const nodeLabels = new Set(graph!.nodes.map((n) => n.label));
  for (const step of trace.steps) {
    for (const v of [...step.before.vars, ...step.after.vars]) {
      assert.ok(nodeLabels.has(v.repr), `"${v.repr}" is not a node in Sign's latticeGraph`);
    }
  }
});

test('infinite lattices publish no latticeGraph', () => {
  // Intervals, Constant Propagation and Congruence are infinite lattices; the
  // client falls back to plotting the ascending chain actually traversed.
  assert.equal(run(intervalDomain as never).domain.latticeGraph, undefined);
  assert.equal(run(constDomain as never).domain.latticeGraph, undefined);
  assert.equal(run(congruenceDomain as never).domain.latticeGraph, undefined);
});

test('Parity converges in no more iterations than Intervals', () => {
  // Parity has finite height 2, same reasoning as Sign: it cannot climb as
  // long as an unbounded interval can.
  const intervals = run(intervalDomain as never);
  const parity = run(parityDomain as never);
  assert.ok(
    parity.summary.iterations <= intervals.summary.iterations,
    `expected Parity (${parity.summary.iterations}) <= Intervals (${intervals.summary.iterations})`
  );
});

test('Parity proves i is even after a step-by-2 loop', () => {
  // Unlike Congruence, Parity's height-2 lattice means widen is plain join —
  // there is nothing for narrowing to recover, because nothing was thrown
  // away in the first place.
  const trace = analyze(stepByTwoLoop(), parityDomain as never, META);
  assert.equal(trace.summary.converged, true);
  const repr = reprOf(lastPushInto(trace, 'b3'), 'i');
  assert.equal(repr, 'even');
});

test('the trace carries a Hasse diagram for a finite lattice (Parity)', () => {
  const trace = run(parityDomain as never);
  const graph = trace.domain.latticeGraph;
  assert.ok(graph, 'expected Parity to publish a latticeGraph over the wire');
  assert.equal(graph!.nodes.length, 4);
  assert.deepEqual(validateTrace(trace).issues, []);
});

function stepByTwoLoop(): Cfg {
  const cfg = countLoop();
  const body = cfg.blocks.find((b) => b.id === 'b2')!;
  body.instrs = [
    {
      kind: 'assign',
      target: 'i',
      expr: { kind: 'binary', op: '+', left: v('i'), right: n(2) },
      span: span(4),
      text: 'i = i + 2;',
    },
  ];
  return cfg;
}

test('Congruence discovers the modulus at a join, before widening discards it', () => {
  // i starts at 0 and climbs by 2, so joining the first two values it takes
  // (0 and 2) already reveals "≡ 0 (mod 2)" — before widening ever runs.
  const trace = analyze(stepByTwoLoop(), congruenceDomain as never, META);
  const join = trace.steps.find((s) => s.kind === 'join' && s.blockId === 'b1');
  assert.ok(join, 'expected a join step at the loop header');
  const repr = join!.after.vars.find((x) => x.name === 'i')?.repr;
  assert.match(repr ?? '', /\+ 2ℤ$/);
});

test('Congruence widening jumps straight to ⊤, and cannot recover via a plain comparison guard', () => {
  // The whole point of adding this domain: its widening strategy is
  // qualitatively different from intervals'. Confirm the widen step that
  // discards "≡ 0 (mod 2)" lands on ⊤, not a narrower class — and confirm the
  // honest limitation that follows from it: because `i < 20`-style guards
  // don't refine congruence classes in this domain (only `==` does), there is
  // no channel for narrowing to recover the periodicity intervals would have
  // recovered via the very same guard. The final answer stays ⊤.
  const trace = analyze(stepByTwoLoop(), congruenceDomain as never, META);
  const widenWithLoss = trace.steps.find((s) => s.kind === 'widen' && (s.loss ?? []).length > 0);
  assert.ok(widenWithLoss, 'expected at least one widening step with reported loss');
  const afterRepr = widenWithLoss!.after.vars.find((x) => x.name === 'i')?.repr;
  assert.equal(afterRepr, '⊤');
  assert.match(widenWithLoss!.loss![0]!.message, /jumps to ⊤/);

  const exitRepr = reprOf(lastPushInto(trace, 'b3'), 'i');
  assert.equal(exitRepr, '⊤', 'unlike Intervals, this guard cannot recover the modulus');
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

/**
 * The flagship relational example — two counters incrementing in lockstep,
 * with an *unbounded* loop (the guard is on a parameter `n` the analysis
 * knows nothing about, so both `i` and `j` individually widen to `[0, +∞)`
 * for every domain, Zones included):
 *
 *   int f(int n) {
 *     int i = 0;
 *     int j = i + 1;
 *     while (i < n) {
 *       i = i + 1;
 *       j = j + 1;
 *     }
 *     return j;
 *   }
 *
 * `j` and `i` move together, so `j − i = 1` is a genuine linear invariant
 * that survives every iteration untouched — it is never the cell that
 * widens, because it never changes. Zones/Octagons keep it even though
 * neither variable's own range is bounded; Intervals has no way to express
 * it at all, since it never looks at more than one variable at a time.
 *
 * `j` is deliberately initialized as `i + 1`, not the equal-valued literal
 * `1`: two variables pinned to independent constants with no expression
 * ever relating them give Zones a relation "for free" as a side effect of
 * its explicit zero-reference node (both pins are secretly expressed
 * relative to the same anchor, so closure bridges them) — but Octagons'
 * classical doubled-variable encoding has no such anchor, so it only ever
 * discovers a relation that a real expression actually establishes. Writing
 * `j = i + 1` makes the invariant genuine and derivable by both domains via
 * the same mechanism, rather than one domain finding it only by an
 * encoding-specific accident. This was caught by writing the Octagons
 * version of this test against the real engine and finding it failed,
 * then tracing *why* — the earlier version of this example only worked
 * for Zones by that accident, and this is the honest fix, not a workaround.
 */
function lockstepLoop(): Cfg {
  return {
    entry: 'b0',
    exit: 'b3',
    variables: [
      { name: 'i', type: 'int', declLine: 2 },
      { name: 'j', type: 'int', declLine: 3 },
      { name: 'n', type: 'int', declLine: 1 },
    ],
    blocks: [
      {
        id: 'b0',
        isEntry: true,
        preds: [],
        succs: [{ target: 'b1' }],
        lines: [{ start: 1, end: 3 }],
        label: 'int i = 0; int j = i + 1;',
        instrs: [
          { kind: 'havoc', target: 'n', span: span(1), text: 'int f(int n)' },
          { kind: 'assign', target: 'i', expr: n(0), span: span(2), text: 'int i = 0;' },
          { kind: 'assign', target: 'j', expr: add(v('i'), n(1)), span: span(3), text: 'int j = i + 1;' },
        ],
      },
      {
        id: 'b1',
        preds: ['b0', 'b2'],
        succs: [
          { target: 'b2', cond: lt(v('i'), v('n')), label: 'i < n' },
          { target: 'b3', cond: ge(v('i'), v('n')), label: '!(i < n)' },
        ],
        lines: [{ start: 4, end: 4 }],
        label: 'while (i < n)',
        instrs: [],
      },
      {
        id: 'b2',
        preds: ['b1'],
        succs: [{ target: 'b1' }],
        lines: [{ start: 5, end: 6 }],
        label: 'i = i + 1; j = j + 1;',
        instrs: [
          { kind: 'assign', target: 'i', expr: add(v('i'), n(1)), span: span(5), text: 'i = i + 1;' },
          { kind: 'assign', target: 'j', expr: add(v('j'), n(1)), span: span(6), text: 'j = j + 1;' },
        ],
      },
      {
        id: 'b3',
        isExit: true,
        preds: ['b1'],
        succs: [],
        lines: [{ start: 8, end: 8 }],
        label: 'return j;',
        instrs: [],
      },
    ],
  };
}

const LOCKSTEP_META: AnalyzeMeta = {
  provider: { id: 'test', name: 'test', version: '0.1.0' },
  file: 'test.c',
  functionName: 'f',
  language: 'c',
};

test('flagship: Intervals cannot relate i and j; Zones keeps j - i = 1 even though neither var is bounded', () => {
  const intervalsTrace = analyze(lockstepLoop(), intervalDomain as never, LOCKSTEP_META);
  const zonesTrace = analyze(lockstepLoop(), zonesDomain as never, LOCKSTEP_META);

  assert.equal(intervalsTrace.summary.converged, true);
  assert.equal(zonesTrace.summary.converged, true);

  // Neither domain can bound j on its own — n is an unconstrained parameter,
  // so the loop's trip count is unknown to the analysis. This is expected,
  // not a failure: the interesting fact is relational, not a range.
  const intervalsJ = reprOf(lastPushInto(intervalsTrace, 'b3'), 'j');
  assert.equal(intervalsJ, '[1, +∞)');

  const zonesExit = lastPushInto(zonesTrace, 'b3');
  const zonesJ = zonesExit?.after.vars.find((x) => x.name === 'j')?.repr;
  assert.equal(zonesJ, '[1, +∞)', "Zones' own projection for j is exactly as unbounded as Intervals'");

  // The payoff Intervals structurally cannot have: a stable relation between
  // j and i, surviving widening because it never actually changed.
  const constraints = zonesExit?.after.constraints ?? [];
  assert.ok(
    constraints.some((c) => c.includes('j - i ≤ 1') || c.includes('i - j ≤ -1')),
    `expected Zones to retain j - i = 1, got ${JSON.stringify(constraints)}`
  );
});

test('flagship trace is protocol-valid and carries constraints only from the relational domain', () => {
  const zonesTrace = analyze(lockstepLoop(), zonesDomain as never, LOCKSTEP_META);
  assert.deepEqual(validateTrace(zonesTrace).issues, []);

  const intervalsTrace = analyze(lockstepLoop(), intervalDomain as never, LOCKSTEP_META);
  const anyIntervalsConstraints = intervalsTrace.steps.some(
    (s) => (s.after.constraints ?? []).length > 0
  );
  assert.equal(anyIntervalsConstraints, false, 'Intervals must never populate constraints');
});

test('flagship, Octagons: also keeps j - i = 1 through the real engine, matching Zones', () => {
  const octagonsTrace = analyze(lockstepLoop(), octagonsDomain as never, LOCKSTEP_META);
  assert.equal(octagonsTrace.summary.converged, true);
  assert.deepEqual(validateTrace(octagonsTrace).issues, []);

  const octagonsExit = lastPushInto(octagonsTrace, 'b3');
  const octagonsJ = octagonsExit?.after.vars.find((x) => x.name === 'j')?.repr;
  assert.equal(octagonsJ, '[1, +∞)', "Octagons' own projection for j is exactly as unbounded as Intervals'");

  const constraints = octagonsExit?.after.constraints ?? [];
  assert.ok(
    constraints.some((c) => c.includes('j - i ≤ 1') || c.includes('i - j ≤ -1')),
    `expected Octagons to retain j - i = 1, got ${JSON.stringify(constraints)}`
  );
});

test('Zonotopes converges and terminates on a real bounded loop, not just in isolated unit tests', () => {
  // countLoop() drives the loop header through several join+widen+narrow
  // cycles for real — exactly the scenario the domain's own doc comment
  // argues must reach an exact bit-for-bit fixpoint (via `leq`'s structural
  // equality) for the engine to ever stop. This is the empirical check for
  // that argument, not just a hand-verified single-transfer unit test.
  const trace = run(zonotopesDomain as never);
  assert.equal(trace.summary.converged, true);
  assert.deepEqual(validateTrace(trace).issues, []);
  const exit = lastPushInto(trace, 'b3');
  assert.equal(reprOf(exit, 'i'), '[10, 10]');
});

test('Polyhedra converges and terminates on a real bounded loop, and keeps j - i = 1 through widening', () => {
  // Unlike Zonotopes, Polyhedra's widen filters the *actual* constraint
  // list by entailment rather than snapping any grown variable to a plain
  // interval — so a relation that never changes (j - i = 1) survives
  // widening here, matching Zones/Octagons rather than Zonotopes.
  const countTrace = run(polyhedraDomain as never);
  assert.equal(countTrace.summary.converged, true);
  assert.deepEqual(validateTrace(countTrace).issues, []);
  const countExit = lastPushInto(countTrace, 'b3');
  assert.equal(reprOf(countExit, 'i'), '[10, 10]');

  const lockstepTrace = analyze(lockstepLoop(), polyhedraDomain as never, LOCKSTEP_META);
  assert.equal(lockstepTrace.summary.converged, true);
  assert.deepEqual(validateTrace(lockstepTrace).issues, []);
  const lockstepExit = lastPushInto(lockstepTrace, 'b3');
  assert.equal(reprOf(lockstepExit, 'j'), '[1, +∞)');
  const constraints = lockstepExit?.after.constraints ?? [];
  assert.ok(
    constraints.some((c) => c.replace(/\s/g, '').includes('j-i≤1') || c.replace(/\s/g, '').includes('i-j≤-1')),
    `expected Polyhedra to retain j - i = 1, got ${JSON.stringify(constraints)}`
  );
});

test('honest limitation: Zonotopes discovers j - i = 1 at the loop header, but widening collapses it back to a plain interval', () => {
  // The correlation genuinely is found: the first time i and j's states
  // join at the back edge, they land on the same fresh shared symbol with
  // matching coefficients, exactly like the flagship join test above. But
  // `widen` (see zonotopes.ts's doc comment) collapses any variable whose
  // *concrete bound* grew back to a plain interval, unconditionally — it
  // has no way to recognize "the symbolic structure is what's actually
  // stable here" versus "the bound is still moving". In an *unbounded*
  // loop, i and j's bounds keep growing every iteration, so this collapse
  // happens almost immediately, and the correlation Zones/Octagons keep
  // through widening (see the Zones/Octagons flagship tests above) does not
  // survive here. This is a deliberate tradeoff for guaranteed termination
  // (see zonotopes.ts's module doc comment on why `leq` needs a
  // deterministic, structurally-stabilizing `widen`), not a bug — the same
  // kind of honest, real boundary as the quadratic-accumulator limitation
  // documented below for Zones/Octagons.
  const trace = analyze(lockstepLoop(), zonotopesDomain as never, LOCKSTEP_META);
  assert.equal(trace.summary.converged, true);
  assert.deepEqual(validateTrace(trace).issues, []);
  const exit = lastPushInto(trace, 'b3');
  assert.equal(reprOf(exit, 'j'), '[1, +∞)');
  assert.deepEqual(exit?.after.constraints ?? [], []);
});

test('honest limitation: a quadratic accumulator (sum of 0..i) is not a fixed linear relation, so Zones cannot bound it either', () => {
  // total = total + i, i = i + 1, guarded by i < 10: total ends up as
  // i(i-1)/2, which is quadratic in i. Zones and Octagons only express
  // "x - y ≤ c" / "±x ± y ≤ c" for a *fixed* constant c — there is no such c
  // here, so widening must (correctly) discard the relation entirely. This
  // documents a real boundary of what these domains can express, matching
  // `examples/sum.c`'s own callout about Intervals — Zones does not change
  // that story for this particular program.
  const cfg: Cfg = {
    entry: 'b0',
    exit: 'b3',
    variables: [
      { name: 'total', type: 'int', declLine: 2 },
      { name: 'i', type: 'int', declLine: 3 },
    ],
    blocks: [
      {
        id: 'b0',
        isEntry: true,
        preds: [],
        succs: [{ target: 'b1' }],
        lines: [{ start: 2, end: 3 }],
        label: 'int total = 0; int i = 0;',
        instrs: [
          { kind: 'assign', target: 'total', expr: n(0), span: span(2), text: 'int total = 0;' },
          { kind: 'assign', target: 'i', expr: n(0), span: span(3), text: 'int i = 0;' },
        ],
      },
      {
        id: 'b1',
        preds: ['b0', 'b2'],
        succs: [
          { target: 'b2', cond: lt(v('i'), n(10)), label: 'i < 10' },
          { target: 'b3', cond: ge(v('i'), n(10)), label: '!(i < 10)' },
        ],
        lines: [{ start: 4, end: 4 }],
        label: 'while (i < 10)',
        instrs: [],
      },
      {
        id: 'b2',
        preds: ['b1'],
        succs: [{ target: 'b1' }],
        lines: [{ start: 5, end: 6 }],
        label: 'total = total + i; i = i + 1;',
        instrs: [
          {
            kind: 'assign',
            target: 'total',
            expr: add(v('total'), v('i')),
            span: span(5),
            text: 'total = total + i;',
          },
          { kind: 'assign', target: 'i', expr: add(v('i'), n(1)), span: span(6), text: 'i = i + 1;' },
        ],
      },
      {
        id: 'b3',
        isExit: true,
        preds: ['b1'],
        succs: [],
        lines: [{ start: 8, end: 8 }],
        label: 'return total;',
        instrs: [],
      },
    ],
  };
  const meta: AnalyzeMeta = {
    provider: { id: 'test', name: 'test', version: '0.1.0' },
    file: 'examples/sum.c',
    functionName: 'sum',
    language: 'c',
  };
  const zonesTrace = analyze(cfg, zonesDomain as never, meta);
  assert.equal(zonesTrace.summary.converged, true);
  const total = reprOf(lastPushInto(zonesTrace, 'b3'), 'total');
  assert.equal(total, '[0, +∞)', 'a quadratic relation is genuinely outside what Zones can express');
});
