/**
 * The conformance test kit.
 *
 * Runs a fixed set of checks against any object implementing
 * `AnalysisProvider` — whether that is an in-process instance (fast, used by
 * the provider's own test suite) or a proxy that forwards calls over the real
 * stdio JSON-RPC transport to a spawned process (what `aiviz-conformance`
 * uses). The checks are the same either way, because a provider's
 * correctness should not depend on which side of the transport is testing it.
 */

import assert from 'node:assert/strict';
import { validateTrace, type AnalysisProvider } from '@aiviz/trace-protocol';

export interface ConformanceCheck {
  name: string;
  passed: boolean;
  message?: string;
}

export interface ConformanceFixture {
  /** A minimal program, in the provider's language, that must be supported. */
  file: string;
  source: string;
  function: string;
  /** A domain id the provider advertises. Defaults to the first one reported. */
  domain?: string;
  /** A program expected to be rejected, to check diagnostic reporting. */
  unsupported?: { file: string; source: string; function: string };
}

class Recorder {
  readonly checks: ConformanceCheck[] = [];

  async run(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
      await fn();
      this.checks.push({ name, passed: true });
    } catch (err) {
      this.checks.push({
        name,
        passed: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function runConformanceSuite(
  provider: AnalysisProvider,
  fixture: ConformanceFixture
): Promise<ConformanceCheck[]> {
  const r = new Recorder();
  let domainId = fixture.domain;

  await r.run('initialize() returns a well-formed ProviderInfo', async () => {
    const info = await provider.initialize();
    assert.ok(info.id, 'ProviderInfo.id must be non-empty');
    assert.ok(info.name, 'ProviderInfo.name must be non-empty');
    assert.ok(info.protocolVersion, 'ProviderInfo.protocolVersion must be non-empty');
    assert.ok(Array.isArray(info.languages) && info.languages.length > 0, 'languages must be non-empty');
    assert.ok(Array.isArray(info.domains) && info.domains.length > 0, 'domains must be non-empty');
    for (const d of info.domains) {
      assert.ok(d.id, 'every domain needs an id');
      assert.ok(d.name, 'every domain needs a name');
    }
    domainId ??= info.domains[0]?.id;
  });

  await r.run('listFunctions() reports the fixture function as supported', async () => {
    const { functions } = await provider.listFunctions({ file: fixture.file, source: fixture.source });
    const match = functions.find((f) => f.name === fixture.function);
    assert.ok(match, `expected to find "${fixture.function}" in listFunctions() output`);
    assert.equal(match.supported, true, `expected "${fixture.function}" to be supported`);
    assert.ok(match.line >= 1, 'function line must be 1-based and positive');
  });

  await r.run('precheck() agrees the fixture function is supported', async () => {
    const result = await provider.precheck({
      file: fixture.file,
      source: fixture.source,
      function: fixture.function,
    });
    assert.equal(result.supported, true);
    assert.deepEqual(result.diagnostics, []);
  });

  await r.run('analyze() on the fixture returns a protocol-valid, converged trace', async () => {
    assert.ok(domainId, 'no domain available to analyze with');
    const trace = await provider.analyze({
      file: fixture.file,
      source: fixture.source,
      function: fixture.function,
      domain: domainId!,
    });
    const result = validateTrace(trace);
    assert.deepEqual(result.issues, [], `trace failed schema validation: ${JSON.stringify(result.issues)}`);
    assert.equal(trace.program.function, fixture.function);
    assert.equal(trace.summary.converged, true, 'expected the fixture to converge');
    assert.ok(trace.steps.length > 0, 'a supported program must produce at least one step');
  });

  await r.run('every step carries a non-empty explanation', async () => {
    assert.ok(domainId, 'no domain available to analyze with');
    const trace = await provider.analyze({
      file: fixture.file,
      source: fixture.source,
      function: fixture.function,
      domain: domainId!,
    });
    for (const step of trace.steps) {
      assert.ok(
        step.explanation.trim().length > 0,
        `step ${step.index} (${step.kind}) has no explanation`
      );
    }
  });

  if (fixture.unsupported) {
    const bad = fixture.unsupported;
    await r.run('precheck() rejects the unsupported fixture with a real line number', async () => {
      const result = await provider.precheck(bad);
      assert.equal(result.supported, false);
      assert.ok(result.diagnostics.length > 0, 'expected at least one diagnostic');
      for (const d of result.diagnostics) {
        assert.ok(d.line >= 1, 'every diagnostic needs a 1-based line number');
        assert.ok(d.message.trim().length > 0, 'every diagnostic needs a message');
      }
    });

    await r.run('analyze() on the unsupported fixture still returns a protocol-valid trace', async () => {
      assert.ok(domainId, 'no domain available to analyze with');
      const trace = await provider.analyze({ ...bad, domain: domainId! });
      const result = validateTrace(trace);
      assert.deepEqual(result.issues, []);
      assert.equal(trace.steps.length, 0, 'an unsupported program should produce no steps');
      assert.equal(trace.summary.converged, false);
      assert.ok(trace.diagnostics.length > 0, 'expected diagnostics explaining the rejection');
    });
  }

  return r.checks;
}

export function summarize(checks: ConformanceCheck[]): { passed: number; failed: number; ok: boolean } {
  const failed = checks.filter((c) => !c.passed).length;
  return { passed: checks.length - failed, failed, ok: failed === 0 };
}
