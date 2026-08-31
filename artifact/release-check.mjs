#!/usr/bin/env node

// Version-consistency guard for the release freeze.  It never changes a version, packages a
// VSIX, creates a tag, or contacts an external service.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const release = JSON.parse(readFileSync(resolve(root, 'artifact/release.json'), 'utf8'));
const target = release.targetVersion;
const frozen = process.argv.includes('--frozen');
const packages = [
  'package.json',
  'extension/package.json',
  'packages/trace-protocol/package.json',
  'packages/analysis-core/package.json',
  'packages/domain-sdk/package.json',
  'packages/provider-sdk/package.json',
  'packages/provider-c-source/package.json',
  'packages/provider-llvm-ir/package.json',
];

const failures = [];
const versions = [];
for (const relative of packages) {
  const manifest = JSON.parse(readFileSync(resolve(root, relative), 'utf8'));
  versions.push({ file: relative, version: manifest.version });
  if (frozen && manifest.version !== target) {
    failures.push(`${relative} is ${manifest.version}, expected ${target}`);
  }
  for (const [name, range] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    if (name.startsWith('@aiviz/') && frozen && range !== target) {
      failures.push(`${relative} depends on ${name}@${range}, expected exact ${target}`);
    }
  }
}

const paperMetadata = 'paper/6a9583b5b0621b54ee3879d1/notes/release-metadata.tex';
if (!existsSync(resolve(root, paperMetadata))) failures.push(`missing ${paperMetadata}`);
const report = { check: frozen ? 'release-freeze' : 'release-preflight', targetVersion: target, versions, failures };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (frozen && failures.length > 0) process.exitCode = 1;
