import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { serveOverStdio } from '../stdioServer.js';
import type { AnalysisProvider } from '@aiviz/trace-protocol';

/** A minimal but fully-typed fake provider for driving the transport. */
function fakeProvider(overrides: Partial<AnalysisProvider> = {}): AnalysisProvider {
  return {
    initialize: () => ({
      id: 'fake',
      name: 'Fake Provider',
      version: '0.0.1',
      protocolVersion: '0.1.0',
      languages: ['fake'],
      domains: [{ id: 'd', name: 'D' }],
    }),
    listFunctions: () => ({ functions: [] }),
    precheck: () => ({ supported: true, diagnostics: [] }),
    analyze: () => {
      throw new Error('not implemented in this fake');
    },
    ...overrides,
  };
}

/** Collects response lines from `output` until at least `count` have arrived. */
function collectLines(output: PassThrough, count: number, timeoutMs = 2000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const lines: unknown[] = [];
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${count} line(s)`)), timeoutMs);
    output.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim().length === 0) continue;
        lines.push(JSON.parse(line));
        if (lines.length >= count) {
          clearTimeout(timer);
          resolve(lines);
          return;
        }
      }
    });
  });
}

function send(input: PassThrough, msg: unknown): void {
  input.write(`${JSON.stringify(msg)}\n`);
}

test('replies to a well-formed request with the method\'s result', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  serveOverStdio(fakeProvider(), { input, output, exit: () => {} });

  send(input, { jsonrpc: '2.0', id: 1, method: 'aiviz/initialize', params: {} });
  const [res] = (await collectLines(output, 1)) as [{ id: number; result: { name: string } }];
  assert.equal(res.id, 1);
  assert.equal(res.result.name, 'Fake Provider');
});

test('replies with a JSON-RPC error for an unknown method', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  serveOverStdio(fakeProvider(), { input, output, exit: () => {} });

  send(input, { jsonrpc: '2.0', id: 7, method: 'aiviz/notAThing', params: {} });
  const [res] = (await collectLines(output, 1)) as [{ id: number; error: { message: string } }];
  assert.equal(res.id, 7);
  assert.match(res.error.message, /unknown method/);
});

test('replies with a parse error for malformed JSON, keyed to a null id', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  serveOverStdio(fakeProvider(), { input, output, exit: () => {} });

  input.write('{ this is not json\n');
  const [res] = (await collectLines(output, 1)) as [{ id: null; error: { code: number } }];
  assert.equal(res.id, null);
  assert.equal(res.error.code, -32700);
});

test('a method that throws is reported as a JSON-RPC error, not a crash', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  serveOverStdio(fakeProvider(), { input, output, exit: () => {} });

  send(input, { jsonrpc: '2.0', id: 3, method: 'aiviz/analyze', params: {} });
  const [res] = (await collectLines(output, 1)) as [{ id: number; error: { message: string } }];
  assert.equal(res.id, 3);
  assert.match(res.error.message, /not implemented/);
});

test('does not exit while a request is still in flight after input closes', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let resolveSlow!: () => void;
  const slow = new Promise<void>((r) => {
    resolveSlow = r;
  });
  let exited = false;

  const provider = fakeProvider({
    analyze: async () => {
      await slow;
      return { fake: true } as never;
    },
  });
  serveOverStdio(provider, { input, output, exit: () => {
    exited = true;
  } });

  send(input, { jsonrpc: '2.0', id: 9, method: 'aiviz/analyze', params: {} });
  input.end(); // input closes while the slow request is still pending

  // Give the event loop a beat: exit must not have fired yet.
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(exited, false, 'must not exit while a request is still in flight');

  resolveSlow();
  const [res] = (await collectLines(output, 1)) as [{ id: number }];
  assert.equal(res.id, 9);
  // Exit is called synchronously right after the reply is written.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(exited, true, 'must exit once the in-flight request has replied');
});
