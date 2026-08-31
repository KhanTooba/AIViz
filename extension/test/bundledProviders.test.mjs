import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { runConformanceSuite, summarize } from '../../packages/provider-sdk/dist/index.js';
import { RpcProviderProxy } from '../../packages/provider-sdk/dist/rpcClient.js';

const extensionDirectory = fileURLToPath(new URL('..', import.meta.url));
const repositoryDirectory = join(extensionDirectory, '..');
const providers = JSON.parse(
  readFileSync(join(extensionDirectory, 'providers.json'), 'utf8')
);
const extensionManifest = JSON.parse(
  readFileSync(join(extensionDirectory, 'package.json'), 'utf8')
);

const cases = {
  'c-source': {
    language: 'c',
    fixture: {
      file: 'count.c',
      source: readFileSync(join(repositoryDirectory, 'examples', 'count.c'), 'utf8'),
      function: 'count',
      domain: 'intervals',
    },
  },
  'llvm-ir': {
    language: 'llvm-ir',
    fixture: {
      file: 'count.ll',
      source: readFileSync(join(repositoryDirectory, 'examples', 'count.ll'), 'utf8'),
      function: 'count',
      domain: 'intervals',
    },
  },
};

test('the extension registry contains one unambiguous provider for .c and .ll', () => {
  assert.deepEqual(
    providers.map((provider) => provider.id),
    ['c-source', 'llvm-ir']
  );
  for (const extension of ['.c', '.ll']) {
    assert.equal(
      providers.filter((provider) => provider.fileExtensions.includes(extension)).length,
      1,
      `${extension} must map to exactly one bundled provider`
    );
  }
});

test('the VS Code manifest activates and offers commands for both languages', () => {
  assert.ok(extensionManifest.activationEvents.includes('onLanguage:c'));
  assert.ok(extensionManifest.activationEvents.includes('onLanguage:llvm-ir'));
  assert.ok(extensionManifest.activationEvents.includes('onLanguage:llvm'));
  assert.ok(extensionManifest.activationEvents.includes('onCommand:aiviz.analyze'));
  assert.ok(extensionManifest.activationEvents.includes('onCommand:aiviz.compare'));
  assert.ok(extensionManifest.activationEvents.includes('onCommand:aiviz.createDomain'));
  assert.ok(extensionManifest.activationEvents.includes('onCommand:aiviz.reloadDomains'));
  assert.ok(
    extensionManifest.contributes.languages.some(
      (language) => language.id === 'llvm-ir' && language.extensions.includes('.ll')
    )
  );
  assert.equal(extensionManifest.capabilities.untrustedWorkspaces.supported, 'limited');
});

test('the bundled C provider discovers a trusted workspace domain from its environment', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'aiviz-extension-domain-'));
  const domainDirectory = join(temporary, '.aiviz', 'domains', 'zero-nonzero');
  const cProvider = providers.find((provider) => provider.id === 'c-source');
  assert.ok(cProvider);
  const entry = join(extensionDirectory, cProvider.bundlePath);
  const priorWasmDirectory = process.env.AIVIZ_WASM_DIR;
  const priorDomainDirectories = process.env.AIVIZ_DOMAIN_DIRECTORIES;

  try {
    await mkdir(domainDirectory, { recursive: true });
    await copyFile(
      join(repositoryDirectory, 'examples', 'zero-nonzero-domain', 'domain.json'),
      join(domainDirectory, 'domain.json')
    );
    await copyFile(
      join(repositoryDirectory, 'examples', 'zero-nonzero-domain', 'domain.mjs'),
      join(domainDirectory, 'domain.mjs')
    );

    process.env.AIVIZ_WASM_DIR = dirname(entry);
    process.env.AIVIZ_DOMAIN_DIRECTORIES = JSON.stringify([join(temporary, '.aiviz', 'domains')]);
    const proxy = new RpcProviderProxy(process.execPath, [entry]);
    try {
      const info = await proxy.initialize();
      assert.deepEqual(
        info.domains.find((domain) => domain.id === 'zero-nonzero'),
        {
          id: 'zero-nonzero',
          name: 'Zero / Nonzero',
          finiteLattice: true,
          origin: 'workspace',
        }
      );
      const trace = await proxy.analyze({
        file: 'count.c',
        source: cases['c-source'].fixture.source,
        function: 'count',
        domain: 'zero-nonzero',
      });
      assert.equal(trace.domain.id, 'zero-nonzero');
      assert.ok(trace.steps.length > 0);
    } finally {
      proxy.dispose();
    }
  } finally {
    if (priorWasmDirectory === undefined) delete process.env.AIVIZ_WASM_DIR;
    else process.env.AIVIZ_WASM_DIR = priorWasmDirectory;
    if (priorDomainDirectories === undefined) delete process.env.AIVIZ_DOMAIN_DIRECTORIES;
    else process.env.AIVIZ_DOMAIN_DIRECTORIES = priorDomainDirectories;
    await rm(temporary, { recursive: true, force: true });
  }
});

test('both provider bundles pass the real stdio transport checks', async () => {
  for (const provider of providers) {
    const providerCase = cases[provider.id];
    assert.ok(providerCase, `no smoke fixture for ${provider.id}`);

    const entry = join(extensionDirectory, provider.bundlePath);
    assert.equal(existsSync(entry), true, `missing extension bundle ${provider.bundlePath}`);

    const priorWasmDirectory = process.env.AIVIZ_WASM_DIR;
    if (provider.needsWasmDirectory) {
      const wasmDirectory = dirname(entry);
      assert.equal(existsSync(join(wasmDirectory, 'tree-sitter-c.wasm')), true);
      assert.equal(existsSync(join(wasmDirectory, 'web-tree-sitter.wasm')), true);
      process.env.AIVIZ_WASM_DIR = wasmDirectory;
    } else {
      delete process.env.AIVIZ_WASM_DIR;
    }

    const proxy = new RpcProviderProxy(process.execPath, [entry]);
    try {
      const info = await proxy.initialize();
      assert.equal(info.id, provider.id);
      assert.ok(
        info.languages.includes(providerCase.language),
        `${provider.id} did not advertise ${providerCase.language}`
      );

      const checks = await runConformanceSuite(proxy, providerCase.fixture);
      assert.equal(
        summarize(checks).ok,
        true,
        `${provider.id} failed:\n${checks
          .filter((check) => !check.passed)
          .map((check) => `${check.name}: ${check.message}`)
          .join('\n')}`
      );

      const trace = await proxy.analyze({
        ...providerCase.fixture,
        domain: providerCase.fixture.domain,
      });
      assert.equal(trace.provider.id, provider.id);
      assert.equal(trace.program.language, providerCase.language);
      assert.ok(trace.steps.length > 0);
    } finally {
      proxy.dispose();
      if (priorWasmDirectory === undefined) delete process.env.AIVIZ_WASM_DIR;
      else process.env.AIVIZ_WASM_DIR = priorWasmDirectory;
    }
  }
});
