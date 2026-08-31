import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const watch = process.argv.includes('--watch');
const providers = JSON.parse(readFileSync('providers.json', 'utf8'));

// Provider output changed from a single C bundle to an id-keyed directory in
// v0.2.0. Clear only that generated directory so a stale provider can never be
// packaged by accident.
rmSync('dist/provider', { recursive: true, force: true });
rmSync('dist/providers', { recursive: true, force: true });
mkdirSync('dist/providers/c-source', { recursive: true });
mkdirSync('dist/providers/llvm-ir', { recursive: true });

// The reference trace ships inside the extension so the panel has something to
// render even if the provider cannot start.
mkdirSync('dist/fixtures', { recursive: true });
cpSync('../packages/trace-protocol/fixtures', 'dist/fixtures', { recursive: true });

/**
 * The grammar and the tree-sitter runtime are `.wasm`, so they cannot be
 * bundled into JavaScript — they are copied next to the provider bundle and
 * located at runtime via AIVIZ_WASM_DIR. Without this the packaged extension
 * would work in the dev host (where node_modules exists) and fail once
 * installed from a .vsix.
 */
// `web-tree-sitter` does not export ./package.json, so resolve its entry point
// instead and take the directory from there.
for (const [spec, name] of [
  ['tree-sitter-c/package.json', 'tree-sitter-c.wasm'],
  ['web-tree-sitter', 'web-tree-sitter.wasm'],
]) {
  const dir = dirname(require.resolve(spec));
  cpSync(join(dir, name), join('dist/providers/c-source', name));
}

const providerEntries = new Map([
  ['c-source', '../packages/provider-c-source/src/main.ts'],
  ['llvm-ir', '../packages/provider-llvm-ir/src/main.ts'],
]);
for (const provider of providers) {
  if (!providerEntries.has(provider.id)) {
    throw new Error(`providers.json declares ${provider.id}, but build.js has no entry point for it`);
  }
}
if (providerEntries.size !== providers.length) {
  throw new Error('build.js and providers.json disagree about the bundled provider count');
}

/**
 * Bundles with three different targets:
 *  - the extension host runs in Node and must be CommonJS with `vscode` external
 *  - each provider is a standalone Node process spawned by the extension
 *  - the webview runs in a browser sandbox with no module loader, so IIFE
 */
const builds = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.cjs',
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  },
  {
    entryPoints: ['../packages/provider-c-source/src/main.ts'],
    outfile: 'dist/providers/c-source/main.cjs',
    platform: 'node',
    format: 'cjs',
    // web-tree-sitter's Node glue calls `createRequire(import.meta.url)`, and
    // esbuild lowers `import.meta` to `{}` when emitting CommonJS — which makes
    // the bundled provider throw as soon as it loads a grammar. Supplying a real
    // file URL keeps that code path working.
    banner: {
      js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;",
    },
    define: { 'import.meta.url': '__importMetaUrl' },
  },
  {
    entryPoints: ['../packages/provider-llvm-ir/src/main.ts'],
    outfile: 'dist/providers/llvm-ir/main.cjs',
    platform: 'node',
    format: 'cjs',
  },
  {
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
  },
  {
    entryPoints: ['src/webview/compareMain.ts'],
    outfile: 'dist/compareWebview.js',
    platform: 'browser',
    format: 'iife',
  },
  {
    entryPoints: ['src/webview/webview.css'],
    outfile: 'dist/webview.css',
  },
];

const common = {
  bundle: true,
  target: 'es2022',
  sourcemap: true,
  logLevel: 'info',
  // Everything must be inlined: the webview CSP forbids remote loads.
  minify: process.env.NODE_ENV === 'production',
};

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context({ ...common, ...b })));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching…');
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...common, ...b })));
}
