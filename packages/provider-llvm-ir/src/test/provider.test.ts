import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateTrace, type AnalysisTrace } from '@aiviz/trace-protocol';
import { LlvmIrProvider } from '../provider.js';

const provider = new LlvmIrProvider();

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)), 'utf8');
}

function exitValue(trace: AnalysisTrace, name: string): string | undefined {
  const step = [...trace.steps].reverse().find((s) => s.kind === 'push' && s.blockId === trace.cfg.exit);
  return step?.after.vars.find((v) => v.name === name)?.repr;
}

test('the real checked-in counting-loop fixture (clang -O0 output) converges to the exact exit value', async () => {
  const source = fixture('count.ll');
  const trace = await provider.analyze({ file: 'count.ll', source, function: 'f', domain: 'intervals' });
  assert.deepEqual(validateTrace(trace).issues, []);
  assert.equal(trace.summary.converged, true);
  assert.ok(trace.summary.wideningStepIndices.length > 0);
  assert.equal(exitValue(trace, '$ret'), '[10, 10]');
});

test('the hand-written phi-based counting loop converges to the same exact exit value', async () => {
  const source = fixture('phi-counting-loop.ll');
  const trace = await provider.analyze({ file: 'phi-counting-loop.ll', source, function: 'f', domain: 'intervals' });
  assert.deepEqual(validateTrace(trace).issues, []);
  assert.equal(trace.summary.converged, true);
  assert.equal(exitValue(trace, '$ret'), '[10, 10]');
});

test('flagship: the lockstep fixture, analyzed with Zones, keeps j - i = 1 even though neither counter is bounded', async () => {
  const source = fixture('lockstep.ll');
  const trace = await provider.analyze({ file: 'lockstep.ll', source, function: 'f', domain: 'zones' });
  assert.deepEqual(validateTrace(trace).issues, []);
  assert.equal(trace.summary.converged, true);
  const step = [...trace.steps].reverse().find((s) => s.kind === 'push' && s.blockId === trace.cfg.exit);
  const constraints = (step?.after.constraints ?? []).map((c) => c.replace(/\s/g, ''));
  assert.ok(
    constraints.some((c) => c.includes('4-3≤1') || c.includes('3-4≤-1')),
    `expected the j-i=1 relation to survive, got ${JSON.stringify(step?.after.constraints)}`
  );
});

test('every domain produces a valid trace for the same program', async () => {
  const source = fixture('count.ll');
  for (const domainId of ['intervals', 'sign', 'constprop', 'parity', 'congruence', 'zones', 'octagons']) {
    const trace = await provider.analyze({ file: 'count.ll', source, function: 'f', domain: domainId });
    assert.deepEqual(validateTrace(trace).issues, [], `domain ${domainId} produced an invalid trace`);
    assert.equal(trace.summary.converged, true, `domain ${domainId} did not converge`);
  }
});

test('a function with more variables than Polyhedra supports gets a clear "unsupported" trace', async () => {
  const source = `
define i32 @f() {
  %1 = alloca i32, align 4
  %2 = alloca i32, align 4
  %3 = alloca i32, align 4
  %4 = alloca i32, align 4
  %5 = alloca i32, align 4
  %6 = alloca i32, align 4
  %7 = alloca i32, align 4
  ret i32 0
}
`;
  const trace = await provider.analyze({ file: 'many-vars.ll', source, function: 'f', domain: 'polyhedra' });
  assert.deepEqual(validateTrace(trace).issues, []);
  assert.equal(trace.summary.converged, false);
  assert.equal(trace.steps.length, 0);
  assert.match(trace.diagnostics[0]!.message, /Polyhedra/);
  assert.match(trace.diagnostics[0]!.message, /variables/);
});

test('an unsupported construct (a call) yields a protocol-valid trace with a real line, not a thrown error', async () => {
  const source = fixture('unsupported-call.ll');
  const trace = await provider.analyze({ file: 'unsupported-call.ll', source, function: 'f', domain: 'intervals' });
  assert.deepEqual(validateTrace(trace).issues, []);
  assert.equal(trace.summary.converged, false);
  assert.equal(trace.steps.length, 0);
  assert.ok(trace.diagnostics.length > 0);
  assert.ok(trace.diagnostics.every((d) => d.line >= 1));
});

test('reports a missing function clearly', async () => {
  const trace = await provider.analyze({ file: 'count.ll', source: fixture('count.ll'), function: 'nope', domain: 'intervals' });
  assert.deepEqual(validateTrace(trace).issues, []);
  assert.match(trace.diagnostics[0]!.message, /no function named/);
});

test('listFunctions reports supportability for every function in the file', () => {
  const source = fixture('unsupported-call.ll');
  const { functions } = provider.listFunctions({ file: 'x.ll', source });
  assert.equal(functions.length, 1);
  assert.equal(functions[0]!.supported, false);
  assert.match(functions[0]!.reason ?? '', /function calls/);
});
