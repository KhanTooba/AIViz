import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runConformanceSuite, summarize } from '@aiviz/provider-sdk';
import { CSourceProvider } from '../provider.js';

/**
 * Runs the shared conformance kit against our own provider, in-process.
 *
 * This is the proof that `@aiviz/provider-sdk` actually works: it is not
 * documentation for a hypothetical third-party integration, it is the same
 * kit checking the provider this repo ships.
 */
test('the C source provider passes the AIViz conformance suite', async () => {
  const provider = new CSourceProvider();
  const checks = await runConformanceSuite(provider, {
    file: 'conformance.c',
    source: `
int f(void) {
  int i = 0;
  while (i < 10) {
    i = i + 1;
  }
  return i;
}
`,
    function: 'f',
    domain: 'intervals',
    unsupported: {
      file: 'conformance-bad.c',
      source: 'int g(int *p) { return *p; }',
      function: 'g',
    },
  });

  const failures = checks.filter((c) => !c.passed);
  assert.deepEqual(
    failures,
    [],
    `conformance failures:\n${failures.map((f) => `  ${f.name}: ${f.message}`).join('\n')}`
  );
  assert.equal(summarize(checks).ok, true);
});
