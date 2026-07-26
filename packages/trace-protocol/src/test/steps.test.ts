import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isBlockOwnState } from '../steps.js';
import type { AnalysisTrace } from '../trace.js';

const FIXTURE = new URL('../../fixtures/count-intervals.trace.json', import.meta.url);

function loadFixture(): AnalysisTrace {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as AnalysisTrace;
}

test('join, widen, narrow and stabilize are always the block\'s own state', () => {
  const trace = loadFixture();
  for (const kind of ['join', 'widen', 'narrow', 'stabilize'] as const) {
    const steps = trace.steps.filter((s) => s.kind === kind);
    assert.ok(steps.length > 0, `fixture has no ${kind} steps to check`);
    for (const s of steps) assert.equal(isBlockOwnState(s), true);
  }
});

test('push is never the block\'s own state', () => {
  const trace = loadFixture();
  const pushes = trace.steps.filter((s) => s.kind === 'push');
  assert.ok(pushes.length > 0, 'fixture has no push steps to check');
  for (const s of pushes) assert.equal(isBlockOwnState(s), false);
});

test('a transfer with a sourceSpan (an instruction) counts as own state', () => {
  const trace = loadFixture();
  const withSpan = trace.steps.filter((s) => s.kind === 'transfer' && s.sourceSpan);
  assert.ok(withSpan.length > 0, 'fixture has no instruction-transfer steps to check');
  for (const s of withSpan) assert.equal(isBlockOwnState(s), true);
});

test('a transfer without a sourceSpan (an edge guard) does not count as own state', () => {
  // This is the case that was previously wrongly included: applying the
  // loop's exit-branch guard at the header produces a transfer with no
  // sourceSpan, and it must not be read as part of the header's own value.
  const trace = loadFixture();
  const guardTransfers = trace.steps.filter((s) => s.kind === 'transfer' && !s.sourceSpan);
  assert.ok(guardTransfers.length > 0, 'fixture has no edge-guard transfer steps to check');
  for (const s of guardTransfers) assert.equal(isBlockOwnState(s), false);
});
