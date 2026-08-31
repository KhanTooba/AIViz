#!/usr/bin/env node

// Runs the implemented, claim-specific artifact checks and leaves both a readable log and
// machine-readable provenance behind.  Results are intentionally untracked: release evidence
// is generated from the frozen v0.2.0 checkout, not copied from a developer machine.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const resultsDirectory = resolve(root, 'artifact', 'results');
const packageVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;

function gitRevision() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unavailable';
}

const checks = {
  smoke: {
    claimIds: ['AIVIZ-C1'],
    commands: [
      ['npm', ['run', 'build']],
      ['npm', ['test']],
    ],
  },
  providers: {
    claimIds: ['AIVIZ-C2'],
    commands: [
      ['npm', ['run', 'build']],
      ['node', ['--test', 'extension/test/bundledProviders.test.mjs']],
    ],
  },
  'external-domain': {
    claimIds: ['AIVIZ-C3'],
    commands: [
      ['npm', ['run', 'build']],
      ['node', ['packages/domain-sdk/dist/cli.js', 'check', 'examples/zero-nonzero-domain']],
      [
        'node',
        [
          '--test',
          '--test-name-pattern',
          'trusted workspace domain',
          'extension/test/bundledProviders.test.mjs',
        ],
      ],
    ],
  },
};

const name = process.argv[2];
const check = checks[name];
if (!check) {
  process.stderr.write(`Usage: node artifact/run.mjs <${Object.keys(checks).join('|')}>\n`);
  process.exitCode = 2;
} else {
  mkdirSync(resultsDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  const outputs = [];
  let ok = true;
  for (const [command, args] of check.commands) {
    const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
    outputs.push({ command: [command, ...args], exitCode: result.status, stdout: result.stdout, stderr: result.stderr });
    if (result.status !== 0) {
      ok = false;
      break;
    }
  }
  const record = {
    schemaVersion: 1,
    check: name,
    claimIds: check.claimIds,
    startedAt,
    finishedAt: new Date().toISOString(),
    result: ok ? 'passed' : 'failed',
    environment: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      gitRevision: gitRevision(),
      aivizVersion: packageVersion,
    },
    commands: outputs.map(({ command, exitCode }) => ({ command, exitCode })),
  };
  const base = resolve(resultsDirectory, name);
  writeFileSync(`${base}.json`, `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(
    `${base}.log`,
    outputs.map(({ command, exitCode, stdout, stderr }) => `$ ${command.join(' ')}\nexit ${exitCode}\n${stdout}${stderr}`).join('\n')
  );
  process.stdout.write(`artifact:${name} ${record.result}; evidence: artifact/results/${name}.{json,log}\n`);
  process.exitCode = ok ? 0 : 1;
}
