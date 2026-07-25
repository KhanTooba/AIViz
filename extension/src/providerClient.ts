/**
 * JSON-RPC client for analysis providers.
 *
 * Providers run out of process, so a hung or crashing analysis cannot take the
 * editor with it. The transport is newline-delimited JSON-RPC 2.0 over stdio,
 * which any language can implement.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import {
  RPC_METHODS,
  type AnalysisTrace,
  type AnalyzeRequest,
  type ListFunctionsResult,
  type PrecheckResult,
  type ProviderInfo,
} from '@aiviz/trace-protocol';

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface ProviderLaunch {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export class ProviderClient {
  private child?: ChildProcessWithoutNullStreams;
  private reader?: Interface;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stderr = '';

  constructor(
    private readonly launch: ProviderLaunch,
    private readonly requestTimeoutMs = 30_000
  ) {}

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;

    const child = spawn(this.launch.command, this.launch.args, {
      cwd: this.launch.cwd,
      env: { ...process.env, ...this.launch.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stderr = '';

    // Keep stderr: when a provider dies during startup it is the only clue.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });

    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on('line', (line) => this.onLine(line));

    child.on('exit', (code, signal) => {
      const detail = this.stderr.trim();
      const reason =
        `provider exited (${signal ? `signal ${signal}` : `code ${code}`})` +
        (detail ? `:\n${detail}` : '');
      this.failAll(new Error(reason));
      this.child = undefined;
    });
    child.on('error', (err) => this.failAll(err));

    return child;
  }

  private onLine(line: string): void {
    const text = line.trim();
    if (text.length === 0) return;

    let msg: { id?: number; result?: unknown; error?: { message: string } };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return; // Not a protocol message; ignore rather than crash the client.
    }
    if (typeof msg.id !== 'number') return;

    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);

    if (msg.error) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
  }

  private failAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  private request<T>(method: string, params: unknown): Promise<T> {
    const child = this.ensureStarted();
    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`provider did not answer ${method} within ${this.requestTimeoutMs} ms`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  initialize(): Promise<ProviderInfo> {
    return this.request(RPC_METHODS.initialize, {});
  }

  listFunctions(file: string, source: string): Promise<ListFunctionsResult> {
    return this.request(RPC_METHODS.listFunctions, { file, source });
  }

  precheck(file: string, source: string, fn: string): Promise<PrecheckResult> {
    return this.request(RPC_METHODS.precheck, { file, source, function: fn });
  }

  analyze(req: AnalyzeRequest): Promise<AnalysisTrace> {
    return this.request(RPC_METHODS.analyze, req);
  }

  dispose(): void {
    this.failAll(new Error('provider client disposed'));
    this.reader?.close();
    this.child?.kill();
    this.child = undefined;
  }
}
