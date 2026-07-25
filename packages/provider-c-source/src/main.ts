#!/usr/bin/env node
/**
 * Provider process entry point.
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdio. Providers run out of
 * process precisely so a crash or an infinite loop in an analysis cannot take
 * the editor down with it.
 */

import { createInterface } from 'node:readline';
import { RPC_METHODS } from '@aiviz/trace-protocol';
import { CSourceProvider } from './provider.js';

interface Request {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

const provider = new CSourceProvider();

function reply(id: number | string, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function replyError(id: number | string, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

async function dispatch(method: string, params: never): Promise<unknown> {
  switch (method) {
    case RPC_METHODS.initialize:
      return provider.initialize();
    case RPC_METHODS.listFunctions:
      return provider.listFunctions(params);
    case RPC_METHODS.precheck:
      return provider.precheck(params);
    case RPC_METHODS.analyze:
      return provider.analyze(params);
    default:
      throw new Error(`unknown method ${method}`);
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

/**
 * Requests still being served.
 *
 * stdin reaching EOF must not kill work already in flight: parsing is async
 * (the grammar is loaded from wasm on first use), so exiting on `close` would
 * silently drop the reply to any request that had not finished yet.
 */
let inFlight = 0;
let inputClosed = false;

function maybeExit(): void {
  if (inputClosed && inFlight === 0) process.exit(0);
}

rl.on('line', (line) => {
  const text = line.trim();
  if (text.length === 0) return;

  let req: Request;
  try {
    req = JSON.parse(text) as Request;
  } catch {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`
    );
    return;
  }

  inFlight++;
  void (async () => {
    try {
      reply(req.id, await dispatch(req.method, req.params as never));
    } catch (err) {
      replyError(req.id, -32603, err instanceof Error ? err.message : String(err));
    } finally {
      inFlight--;
      maybeExit();
    }
  })();
});

rl.on('close', () => {
  inputClosed = true;
  maybeExit();
});
