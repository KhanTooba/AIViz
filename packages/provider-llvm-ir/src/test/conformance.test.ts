import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runConformanceSuite, summarize } from '@aiviz/provider-sdk';
import { LlvmIrProvider } from '../provider.js';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url)), 'utf8');
}

test('the LLVM IR provider passes the AIViz conformance suite', async () => {
  const checks = await runConformanceSuite(new LlvmIrProvider(), {
    file: 'count.ll',
    source: fixture('count.ll'),
    function: 'f',
    domain: 'intervals',
    unsupported: {
      file: 'unsupported-call.ll',
      source: fixture('unsupported-call.ll'),
      function: 'f',
    },
  });
  const result = summarize(checks);
  if (!result.ok) {
    for (const c of checks) if (!c.passed) console.error(c.name, c.message);
  }
  assert.equal(result.ok, true);
});
