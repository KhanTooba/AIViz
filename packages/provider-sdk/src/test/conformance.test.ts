import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, type AnalysisProvider, type AnalysisTrace } from '@aiviz/trace-protocol';
import { runConformanceSuite, summarize } from '../conformance.js';

const FIXTURE = {
  file: 'test.c',
  source: 'int f(void) { int i = 0; return i; }',
  function: 'f',
  domain: 'intervals',
  unsupported: {
    file: 'bad.c',
    source: 'int g(int *p) { return *p; }',
    function: 'g',
  },
};

/** A minimal protocol-valid trace for a supported one-block program. */
function supportedTrace(fnName: string): AnalysisTrace {
  return {
    version: PROTOCOL_VERSION,
    provider: { id: 'test', name: 'Test', version: '0.0.1' },
    program: { file: FIXTURE.file, function: fnName, language: 'fake' },
    domain: { id: 'intervals', name: 'Intervals' },
    cfg: {
      entry: 'b0',
      blocks: [{ blockId: 'b0', preds: [], succs: [], lines: [{ start: 1, end: 1 }] }],
    },
    lineMap: {
      lineToBlocks: { '1': ['b0'] },
      blockToLines: { b0: [{ start: 1, end: 1 }] },
    },
    variables: [{ name: 'i', type: 'int' }],
    steps: [
      {
        index: 0,
        kind: 'transfer',
        blockId: 'b0',
        iteration: 0,
        before: { kind: 'state', vars: [{ name: 'i', repr: '⊤', kind: 'top' }] },
        after: { kind: 'state', vars: [{ name: 'i', repr: '[0, 0]', kind: 'value' }] },
        explanation: 'i becomes [0, 0].',
      },
    ],
    summary: {
      iterations: 1,
      stepCount: 1,
      converged: true,
      wideningPoints: [],
      wideningStepIndices: [],
    },
    diagnostics: [],
  };
}

function unsupportedTrace(fnName: string): AnalysisTrace {
  return {
    ...supportedTrace(fnName),
    steps: [],
    summary: {
      iterations: 0,
      stepCount: 0,
      converged: false,
      wideningPoints: [],
      wideningStepIndices: [],
      notConvergedReason: 'not supported',
    },
    diagnostics: [{ severity: 'error', code: 'unsupported.pointer', message: 'pointers are not supported', line: 1 }],
  };
}

/** A provider that does everything right — the conformance kit's happy path. */
function goodProvider(): AnalysisProvider {
  return {
    initialize: () => ({
      id: 'good',
      name: 'Good Provider',
      version: '1.0.0',
      protocolVersion: PROTOCOL_VERSION,
      languages: ['fake'],
      domains: [{ id: 'intervals', name: 'Intervals' }],
    }),
    listFunctions: () => ({ functions: [{ name: FIXTURE.function, line: 1, supported: true }] }),
    precheck: (req) =>
      req.function === FIXTURE.unsupported.function
        ? {
            supported: false,
            diagnostics: [{ severity: 'error', code: 'unsupported.pointer', message: 'no pointers', line: 1 }],
          }
        : { supported: true, diagnostics: [] },
    analyze: (req) =>
      req.function === FIXTURE.unsupported.function
        ? unsupportedTrace(req.function)
        : supportedTrace(req.function),
  };
}

test('a correct provider passes the entire conformance suite', async () => {
  const checks = await runConformanceSuite(goodProvider(), FIXTURE);
  const failed = checks.filter((c) => !c.passed);
  assert.deepEqual(failed, [], JSON.stringify(failed));
  assert.equal(summarize(checks).ok, true);
});

test('flags a provider whose listFunctions omits the fixture function', async () => {
  const provider = { ...goodProvider(), listFunctions: () => ({ functions: [] }) };
  const checks = await runConformanceSuite(provider, FIXTURE);
  const check = checks.find((c) => c.name.includes('listFunctions'));
  assert.equal(check?.passed, false);
});

test('flags a provider that reports the fixture function as unsupported', async () => {
  const provider = {
    ...goodProvider(),
    listFunctions: () => ({ functions: [{ name: FIXTURE.function, line: 1, supported: false }] }),
  };
  const checks = await runConformanceSuite(provider, FIXTURE);
  const check = checks.find((c) => c.name.includes('listFunctions'));
  assert.equal(check?.passed, false);
});

test('flags a provider whose analyze() output fails schema validation', async () => {
  const provider: AnalysisProvider = {
    ...goodProvider(),
    analyze: () => ({ ...supportedTrace(FIXTURE.function), cfg: { entry: 'ghost', blocks: [] } }),
  };
  const checks = await runConformanceSuite(provider, FIXTURE);
  const check = checks.find((c) => c.name.includes('protocol-valid, converged trace'));
  assert.equal(check?.passed, false);
  assert.match(check?.message ?? '', /schema validation/);
});

test('flags a provider that does not converge on the supported fixture', async () => {
  const provider: AnalysisProvider = {
    ...goodProvider(),
    analyze: () => ({
      ...supportedTrace(FIXTURE.function),
      summary: { ...supportedTrace(FIXTURE.function).summary, converged: false, notConvergedReason: 'stuck' },
    }),
  };
  const checks = await runConformanceSuite(provider, FIXTURE);
  const check = checks.find((c) => c.name.includes('protocol-valid, converged trace'));
  assert.equal(check?.passed, false);
  assert.match(check?.message ?? '', /converge/);
});

test('flags a provider whose precheck wrongly accepts the unsupported fixture', async () => {
  const provider: AnalysisProvider = {
    ...goodProvider(),
    precheck: () => ({ supported: true, diagnostics: [] }),
  };
  const checks = await runConformanceSuite(provider, FIXTURE);
  const check = checks.find((c) => c.name.includes('rejects the unsupported fixture'));
  assert.equal(check?.passed, false);
});

test('flags a diagnostic with no line number', async () => {
  const provider: AnalysisProvider = {
    ...goodProvider(),
    precheck: () => ({
      supported: false,
      diagnostics: [{ severity: 'error', code: 'x', message: 'bad', line: 0 }],
    }),
  };
  const checks = await runConformanceSuite(provider, FIXTURE);
  const check = checks.find((c) => c.name.includes('rejects the unsupported fixture'));
  assert.equal(check?.passed, false);
});

test('summarize reports pass/fail counts correctly', async () => {
  const checks = await runConformanceSuite(goodProvider(), FIXTURE);
  const summary = summarize(checks);
  assert.equal(summary.failed, 0);
  assert.equal(summary.passed, checks.length);
});
