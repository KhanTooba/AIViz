import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { signDomain } from '@aiviz/analysis-core';
import { domainDirectoriesFromEnvironment, loadWorkspaceDomains } from '../workspaceDomains.js';

const validLattice = `
const BOT = 0, ZERO = 1, NONZERO = 2, TOP = 3;
export const lattice = {
  id: 'zero-nonzero', name: 'Zero / Nonzero', finiteLattice: true,
  bottom: BOT, top: TOP,
  isBottom: (v) => v === BOT, isTop: (v) => v === TOP,
  equal: (a, b) => a === b, leq: (a, b) => (a & ~b) === 0,
  join: (a, b) => a | b, meet: (a, b) => a & b,
  widen: (a, b) => a | b, narrow: (a, b) => a & b,
  constant: (n) => n === 0 ? ZERO : NONZERO,
  add: (a, b) => a === BOT || b === BOT ? BOT : a === ZERO ? b : b === ZERO ? a : TOP,
  sub: (a, b) => a === BOT || b === BOT ? BOT : a === ZERO ? b : b === ZERO ? a : TOP,
  mul: (a, b) => a === BOT || b === BOT ? BOT : a === ZERO || b === ZERO ? ZERO : TOP,
  div: (a, b) => a === BOT || b === BOT ? BOT : a === ZERO ? ZERO : TOP,
  mod: (a, b) => a === BOT || b === BOT ? BOT : TOP,
  neg: (a) => a,
  refine: (_op, a, _b) => a,
  format: (v) => v === BOT ? { repr: '⊥', kind: 'bottom' } : v === TOP ? { repr: '⊤', kind: 'top' } : { repr: v === ZERO ? '0' : '≠0', kind: 'value' },
  describeLoss: () => undefined,
  latticeGraph: () => ({
    nodes: [{ id: 'bot', label: '⊥' }, { id: 'zero', label: '0' }, { id: 'nonzero', label: '≠0' }, { id: 'top', label: '⊤' }],
    edges: [['bot', 'zero'], ['bot', 'nonzero'], ['zero', 'top'], ['nonzero', 'top']]
  })
};
`;

async function createDomain(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  module = validLattice
): Promise<void> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'domain.json'), JSON.stringify(manifest), 'utf8');
  await writeFile(path.join(directory, 'domain.mjs'), module, 'utf8');
}

const validManifest = {
  schemaVersion: 1,
  apiVersion: '0.2',
  id: 'zero-nonzero',
  name: 'Zero / Nonzero',
  kind: 'value-lattice',
  entry: './domain.mjs',
  languages: ['c', 'llvm-ir'],
};

test('loads a compatible workspace lattice while preserving built-ins', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'aiviz-domain-sdk-'));
  try {
    await createDomain(temporary, 'zero-nonzero', validManifest);
    const result = await loadWorkspaceDomains({
      directories: [temporary],
      language: 'c',
      builtInDomains: [signDomain],
    });
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(
      result.domains.map((domain) => domain.id),
      ['sign', 'zero-nonzero']
    );
    assert.equal(result.workspaceDomains[0]?.manifest.name, 'Zero / Nonzero');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('rejects invalid and colliding domains without removing built-ins', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'aiviz-domain-sdk-'));
  try {
    await createDomain(temporary, 'collides', { ...validManifest, id: 'sign', name: 'Sign' });
    await createDomain(temporary, 'bad-manifest', { ...validManifest, extra: true });
    const result = await loadWorkspaceDomains({
      directories: [temporary],
      language: 'c',
      builtInDomains: [signDomain],
    });
    assert.deepEqual(result.domains.map((domain) => domain.id), ['sign']);
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.code).sort(),
      ['domain.id.collision', 'domain.manifest.invalid']
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('filters a workspace domain by its declared provider language', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'aiviz-domain-sdk-'));
  try {
    await createDomain(temporary, 'zero-nonzero', { ...validManifest, languages: ['llvm-ir'] });
    const result = await loadWorkspaceDomains({
      directories: [temporary],
      language: 'c',
      builtInDomains: [signDomain],
    });
    assert.deepEqual(result.domains.map((domain) => domain.id), ['sign']);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('accepts only absolute JSON-encoded directories from the extension environment', () => {
  assert.deepEqual(domainDirectoriesFromEnvironment(JSON.stringify(['/tmp/a', '/tmp/b'])), [
    '/tmp/a',
    '/tmp/b',
  ]);
  assert.deepEqual(domainDirectoriesFromEnvironment(JSON.stringify(['relative'])), []);
  assert.deepEqual(domainDirectoriesFromEnvironment('not json'), []);
});

test('the authoring CLI scaffolds and validates a domain without overwriting its target', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'aiviz-domain-cli-'));
  const target = path.join(temporary, '.aiviz', 'domains', 'demo-domain');
  const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
  try {
    const create = spawnSync(
      process.execPath,
      [cli, 'create', target, '--id', 'demo-domain', '--name', 'Demo Domain', '--languages', 'c,llvm-ir'],
      { encoding: 'utf8' }
    );
    assert.equal(create.status, 0, create.stderr);

    const check = spawnSync(process.execPath, [cli, 'check', target], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /ok demo-domain/);

    const duplicate = spawnSync(
      process.execPath,
      [cli, 'create', target, '--id', 'demo-domain', '--name', 'Demo Domain'],
      { encoding: 'utf8' }
    );
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /already exists/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
