/**
 * A minimal stdio JSON-RPC client that implements `AnalysisProvider` by
 * forwarding every call to a spawned process.
 *
 * This exists so `aiviz-conformance` can run the exact same conformance
 * checks against a real external process as against an in-process instance —
 * proving a provider works over the transport it will actually be driven
 * over, not just as a bare object. It is deliberately minimal (one-shot
 * request/response, no timeout bookkeeping, no reconnection): a short-lived
 * CLI check has different needs than a long-lived editor session, which is
 * why this is not the same client the VS Code extension uses.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  RPC_METHODS,
  type AnalysisProvider,
  type AnalysisTrace,
  type AnalyzeRequest,
  type DocumentRequest,
  type ListFunctionsResult,
  type PrecheckRequest,
  type PrecheckResult,
  type ProviderInfo,
} from '@aiviz/trace-protocol';

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export class RpcProviderProxy implements AnalysisProvider {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stderr = '';

  constructor(command: string, args: string[], cwd?: string) {
    this.child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', (line) =>
      this.onLine(line)
    );
    this.child.on('exit', (code, signal) => {
      const reason = `provider exited (${signal ? `signal ${signal}` : `code ${code}`})${this.stderr ? `:\n${this.stderr.trim()}` : ''}`;
      for (const p of this.pending.values()) p.reject(new Error(reason));
      this.pending.clear();
    });
  }

  private onLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let msg: { id?: number; result?: unknown; error?: { message: string } };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
  }

  private request<T>(method: string, params: unknown, timeoutMs = 20_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no response to ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  initialize(): Promise<ProviderInfo> {
    return this.request(RPC_METHODS.initialize, {});
  }
  listFunctions(req: DocumentRequest): Promise<ListFunctionsResult> {
    return this.request(RPC_METHODS.listFunctions, req);
  }
  precheck(req: PrecheckRequest): Promise<PrecheckResult> {
    return this.request(RPC_METHODS.precheck, req);
  }
  analyze(req: AnalyzeRequest): Promise<AnalysisTrace> {
    return this.request(RPC_METHODS.analyze, req);
  }

  dispose(): void {
    this.child.kill();
  }
}
