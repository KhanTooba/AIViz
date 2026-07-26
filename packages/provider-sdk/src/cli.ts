#!/usr/bin/env node
/**
 * aiviz-conformance — checks a provider process against the AIViz protocol
 * over the real stdio transport, the same one the VS Code client uses.
 *
 * Usage:
 *   aiviz-conformance --manifest provider.json --fixture fixture.json
 *   aiviz-conformance --fixture fixture.json -- node dist/main.js
 *
 * fixture.json shape:
 *   {
 *     "file": "test.c", "source": "int f(void){...}", "function": "f",
 *     "domain": "intervals",
 *     "unsupported": { "file": "bad.c", "source": "...", "function": "g" }
 *   }
 *
 * Without --fixture, only initialize() is checked — enough to confirm the
 * process starts and speaks the protocol, but not that its analysis is
 * correct.
 */

import { readFileSync } from 'node:fs';
import { loadProviderManifest, resolveProviderLaunch } from './manifest.js';
import { RpcProviderProxy } from './rpcClient.js';
import { runConformanceSuite, summarize, type ConformanceFixture } from './conformance.js';

function parseArgs(argv: string[]): {
  manifest?: string;
  fixture?: string;
  command?: string[];
} {
  const out: { manifest?: string; fixture?: string; command?: string[] } = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--manifest') {
      out.manifest = argv[++i];
    } else if (arg === '--fixture') {
      out.fixture = argv[++i];
    } else if (arg === '--') {
      out.command = argv.slice(i + 1);
      break;
    }
    i++;
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  let launch: { command: string; args: string[]; cwd?: string };
  if (args.manifest) {
    const manifest = loadProviderManifest(args.manifest);
    launch = resolveProviderLaunch(args.manifest, manifest);
  } else if (args.command && args.command.length > 0) {
    launch = { command: args.command[0]!, args: args.command.slice(1) };
  } else {
    process.stderr.write(
      'usage: aiviz-conformance --manifest provider.json [--fixture fixture.json]\n' +
        '       aiviz-conformance [--fixture fixture.json] -- <command> [args...]\n'
    );
    return 2;
  }

  const fixture: ConformanceFixture | undefined = args.fixture
    ? (JSON.parse(readFileSync(args.fixture, 'utf8')) as ConformanceFixture)
    : undefined;

  const proxy = new RpcProviderProxy(launch.command, launch.args, launch.cwd);
  try {
    if (!fixture) {
      const info = await proxy.initialize();
      process.stdout.write(
        `ok   initialize() — ${info.name} v${info.version}, languages: ${info.languages.join(', ')}\n` +
          `note no --fixture given, so only initialize() was checked\n`
      );
      return 0;
    }

    const checks = await runConformanceSuite(proxy, fixture);
    for (const c of checks) {
      process.stdout.write(`${c.passed ? 'ok  ' : 'FAIL'} ${c.name}\n`);
      if (!c.passed && c.message) process.stdout.write(`     ${c.message}\n`);
    }
    const { passed, failed } = summarize(checks);
    process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
    return failed === 0 ? 0 : 1;
  } finally {
    proxy.dispose();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`aiviz-conformance: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
