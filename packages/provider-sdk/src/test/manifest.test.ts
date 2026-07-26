import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProviderManifest, resolveProviderLaunch } from '../manifest.js';

function writeManifest(dir: string, content: unknown): string {
  const path = join(dir, 'provider.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}

test('loads a well-formed manifest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiviz-manifest-'));
  const path = writeManifest(dir, {
    id: 'demo',
    name: 'Demo Provider',
    version: '1.0.0',
    languages: ['demo'],
    command: 'node',
    args: ['./dist/main.js'],
  });
  const manifest = loadProviderManifest(path);
  assert.equal(manifest.id, 'demo');
  assert.deepEqual(manifest.args, ['./dist/main.js']);
});

test('rejects a manifest missing a required field', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiviz-manifest-'));
  const path = writeManifest(dir, { id: 'demo', name: 'Demo', version: '1.0.0' });
  assert.throws(() => loadProviderManifest(path), /languages/);
});

test('rejects a manifest whose languages field is empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiviz-manifest-'));
  const path = writeManifest(dir, {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    languages: [],
    command: 'node',
  });
  assert.throws(() => loadProviderManifest(path), /languages/);
});

test('rejects a manifest that is not valid JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiviz-manifest-'));
  const path = join(dir, 'provider.json');
  writeFileSync(path, 'not json at all');
  assert.throws(() => loadProviderManifest(path));
});

test('resolves the launch command relative to the manifest\'s own directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiviz-manifest-'));
  const path = writeManifest(dir, {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    languages: ['demo'],
    command: 'node',
    args: ['main.js'],
  });
  const manifest = loadProviderManifest(path);
  const launch = resolveProviderLaunch(path, manifest);
  assert.equal(launch.command, 'node');
  assert.equal(launch.cwd, dir);
});

test('honors an explicit cwd in the manifest, relative to the manifest file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aiviz-manifest-'));
  const path = writeManifest(dir, {
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    languages: ['demo'],
    command: 'node',
    cwd: './sub',
  });
  const manifest = loadProviderManifest(path);
  const launch = resolveProviderLaunch(path, manifest);
  assert.equal(launch.cwd, join(dir, 'sub'));
});
