/**
 * Runs an {@link AnalysisProvider} as a JSON-RPC 2.0 server over stdio.
 *
 * This is the one piece of transport code every provider process needs, so
 * it lives here rather than being reimplemented per provider. A provider
 * author only has to implement the four `AnalysisProvider` methods; framing,
 * request dispatch and shutdown timing are handled by this call.
 */

import { createInterface } from 'node:readline';
import { RPC_METHODS, type AnalysisProvider } from '@aiviz/trace-protocol';

interface RpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

export interface ServeOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** Called once every in-flight request has replied after the input stream
   * closed. Defaults to `process.exit`; overridable so this transport can be
   * unit tested without ending the test process. */
  exit?: (code: number) => void;
}

async function dispatch(provider: AnalysisProvider, method: string, params: never): Promise<unknown> {
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

/**
 * Serves `provider` over stdio until the input stream closes.
 *
 * Exit is deferred until every in-flight request has replied. Parsing a
 * grammar or running a fixpoint is asynchronous, so exiting the instant
 * stdin reaches EOF — which happens as soon as the client disconnects —
 * would silently drop the reply to whatever request was still in flight.
 */
export function serveOverStdio(provider: AnalysisProvider, options: ServeOptions = {}): void {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const reply = (id: number | string, result: unknown): void => {
    output.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  };
  const replyError = (id: number | string, code: number, message: string): void => {
    output.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
  };

  let inFlight = 0;
  let inputClosed = false;
  const maybeExit = (): void => {
    if (inputClosed && inFlight === 0) exit(0);
  };

  const rl = createInterface({ input, crlfDelay: Infinity });

  rl.on('line', (line) => {
    const text = line.trim();
    if (text.length === 0) return;

    let req: RpcRequest;
    try {
      req = JSON.parse(text) as RpcRequest;
    } catch {
      output.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`
      );
      return;
    }

    inFlight++;
    void (async () => {
      try {
        reply(req.id, await dispatch(provider, req.method, req.params as never));
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
}
