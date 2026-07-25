/**
 * tree-sitter C parsing.
 *
 * The grammar ships as a prebuilt `.wasm`, so this frontend needs no compiler,
 * no native module and no user-side install — it works identically on macOS,
 * Linux and Windows.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Language, Parser, type Node, type Tree } from 'web-tree-sitter';
import type { SourceSpan } from '@aiviz/trace-protocol';

let parserPromise: Promise<Parser> | undefined;

/**
 * Where the `.wasm` files live.
 *
 * When the provider is bundled into the VS Code extension there is no
 * `node_modules` to resolve against, so the host passes an explicit directory.
 * Falling back to package resolution keeps `npm test` and the CLI working.
 */
function wasmDir(): string | undefined {
  return process.env.AIVIZ_WASM_DIR;
}

/**
 * Grammar path when running from a normal install (tests, CLI).
 *
 * Deliberately lazy: bundling this module to CommonJS turns `import.meta.url`
 * into `undefined`, so evaluating it at module scope crashes the bundled
 * provider on load. Inside a function it is simply never reached, because the
 * bundled build always supplies AIVIZ_WASM_DIR.
 */
function grammarFromNodeModules(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('tree-sitter-c/package.json')), 'tree-sitter-c.wasm');
}

async function createParser(): Promise<Parser> {
  const dir = wasmDir();

  // Emscripten resolves its own runtime wasm through `locateFile`.
  await Parser.init(dir ? { locateFile: (name: string) => join(dir, name) } : {});

  const grammar = dir ? join(dir, 'tree-sitter-c.wasm') : grammarFromNodeModules();

  const language = await Language.load(await readFile(grammar));
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

/** The parser is expensive to build, so it is created once per process. */
export function getParser(): Promise<Parser> {
  parserPromise ??= createParser();
  return parserPromise;
}

export async function parseC(source: string): Promise<Tree> {
  const parser = await getParser();
  const tree = parser.parse(source);
  if (!tree) throw new Error('tree-sitter returned no parse tree');
  return tree;
}

/** tree-sitter positions are 0-based; the protocol is 1-based throughout. */
export function spanOf(node: Node): SourceSpan {
  return {
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column + 1,
    endLine: node.endPosition.row + 1,
    endColumn: node.endPosition.column + 1,
  };
}

export function firstLine(node: Node): number {
  return node.startPosition.row + 1;
}

/** Collapses a node's text to one line, for use as a CFG block label. */
export function labelOf(node: Node, max = 32): string {
  const text = node.text.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function namedDescendants(node: Node): Node[] {
  const out: Node[] = [];
  const stack: Node[] = [node];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (let i = cur.namedChildCount - 1; i >= 0; i--) {
      const child = cur.namedChild(i);
      if (child) {
        out.push(child);
        stack.push(child);
      }
    }
  }
  return out;
}

export function findFunctions(tree: Tree): Node[] {
  const out: Node[] = [];
  const root = tree.rootNode;
  for (let i = 0; i < root.namedChildCount; i++) {
    const child = root.namedChild(i);
    if (child?.type === 'function_definition') out.push(child);
  }
  return out;
}

/** The declared name of a function definition, digging through declarators. */
export function functionName(fn: Node): string | undefined {
  let declarator = fn.childForFieldName('declarator');
  // Walk down through any wrapping declarators to the bare identifier.
  while (declarator) {
    if (declarator.type === 'identifier') return declarator.text;
    const inner = declarator.childForFieldName('declarator');
    if (!inner) break;
    declarator = inner;
  }
  return undefined;
}
