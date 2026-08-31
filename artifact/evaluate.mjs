#!/usr/bin/env node
// Phase-6 engineering evaluation. It measures tool behavior, not learning outcomes.
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const example = (name) => readFile(join(root, 'examples', name), 'utf8');
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const sha256 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function providers() {
  const [{ CSourceProvider }, { LlvmIrProvider }] = await Promise.all([
    import('../packages/provider-c-source/dist/provider.js'),
    import('../packages/provider-llvm-ir/dist/provider.js'),
  ]);
  return { c: new CSourceProvider(), llvm: new LlvmIrProvider() };
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

async function determinism() {
  const source = await example('count.c');
  const { c } = await providers();
  const hashes = [];
  for (let run = 0; run < 10; run++) {
    hashes.push(sha256(await c.analyze({ file: 'count.c', source, function: 'count', domain: 'intervals' })));
  }
  const uniqueHashes = [...new Set(hashes)];
  if (uniqueHashes.length !== 1) throw new Error(`expected one trace hash, observed ${uniqueHashes.length}`);
  output({ check: 'determinism', fixture: 'count.c#count', runs: hashes.length, sha256: uniqueHashes[0] });
}

async function benchmark() {
  const { c, llvm } = await providers();
  const cases = [
    { id: 'c-count-intervals', provider: c, file: 'count.c', source: await example('count.c'), function: 'count', domain: 'intervals' },
    { id: 'c-branches-zones', provider: c, file: 'branches.c', source: await example('branches.c'), function: 'nested', domain: 'zones' },
    { id: 'c-lockstep-octagons', provider: c, file: 'lockstep.c', source: await example('lockstep.c'), function: 'f', domain: 'octagons' },
    { id: 'llvm-count-intervals', provider: llvm, file: 'count.ll', source: await example('count.ll'), function: 'count', domain: 'intervals' },
  ];
  const results = [];
  for (const testCase of cases) {
    await testCase.provider.analyze(testCase); // warm-up is excluded
    const samples = [];
    let trace;
    for (let run = 0; run < 15; run++) {
      const start = process.hrtime.bigint();
      trace = await testCase.provider.analyze(testCase);
      samples.push(Number(process.hrtime.bigint() - start) / 1_000_000);
    }
    if (!trace?.summary.converged) throw new Error(`${testCase.id} did not converge`);
    results.push({ id: testCase.id, repetitions: samples.length, medianMs: Number(percentile(samples, 0.5).toFixed(3)), p95Ms: Number(percentile(samples, 0.95).toFixed(3)), traceBytes: Buffer.byteLength(JSON.stringify(trace)), steps: trace.steps.length, iterations: trace.summary.iterations });
  }
  output({ check: 'benchmark', warmupRuns: 1, results });
}

const validManifest = (id) => ({ schemaVersion: 1, apiVersion: '0.2', id, name: id, kind: 'value-lattice', entry: './domain.mjs', languages: ['c'] });
async function writeDomain(rootDirectory, name, manifest, module) {
  const directory = join(rootDirectory, name);
  await cp(join(root, 'examples', 'zero-nonzero-domain'), directory, { recursive: true });
  await writeFile(join(directory, 'domain.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (module !== undefined) await writeFile(join(directory, 'domain.mjs'), module);
}

async function domainFailures() {
  const [{ loadWorkspaceDomains }, { DOMAINS }, { CSourceProvider }] = await Promise.all([
    import('../packages/domain-sdk/dist/index.js'), import('../packages/analysis-core/dist/index.js'), import('../packages/provider-c-source/dist/provider.js'),
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'aiviz-domain-failures-'));
  try {
    await writeDomain(directory, 'bad-manifest', { ...validManifest('bad-manifest'), apiVersion: '99.0' });
    await writeDomain(directory, 'builtin-collision', validManifest('intervals'));
    await writeDomain(directory, 'throws', validManifest('throws'), 'throw new Error("expected fixture failure");\n');
    const loaded = await loadWorkspaceDomains({ directories: [directory], language: 'c', builtInDomains: DOMAINS });
    const codes = loaded.diagnostics.map((diagnostic) => diagnostic.code).sort();
    for (const expected of ['domain.manifest.invalid', 'domain.id.collision', 'domain.entry.load']) {
      if (!codes.includes(expected)) throw new Error(`missing expected diagnostic ${expected}`);
    }
    if (loaded.domains.length !== DOMAINS.length) throw new Error('a faulty workspace domain changed the built-in catalog');
    const trace = await new CSourceProvider({ domainDirectories: [directory] }).analyze({ file: 'count.c', source: await example('count.c'), function: 'count', domain: 'intervals' });
    if (!trace.summary.converged) throw new Error('built-in analysis stopped working after domain failures');
    output({ check: 'domain-failures', diagnostics: codes, builtInAnalysisConverged: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const actions = { determinism, benchmark, 'domain-failures': domainFailures };
const action = actions[process.argv[2]];
if (!action) {
  process.stderr.write(`Usage: node artifact/evaluate.mjs <${Object.keys(actions).join('|')}>\n`);
  process.exitCode = 2;
} else {
  action().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
}
