import { readdir, readFile, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  NonRelationalDomain,
  type Domain,
  type HasseDiagram,
  type ValueLattice,
} from '@aiviz/analysis-core';

export const DOMAIN_MANIFEST_SCHEMA_VERSION = 1 as const;
export const DOMAIN_API_VERSION = '0.2' as const;

export interface WorkspaceDomainManifest {
  schemaVersion: typeof DOMAIN_MANIFEST_SCHEMA_VERSION;
  apiVersion: typeof DOMAIN_API_VERSION;
  id: string;
  name: string;
  description?: string;
  kind: 'value-lattice';
  entry: string;
  languages: string[];
}

export interface WorkspaceDomainDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  path?: string;
}

export interface LoadedWorkspaceDomain {
  domain: Domain<unknown>;
  manifest: WorkspaceDomainManifest;
  directory: string;
}

export interface DomainLoadResult {
  domains: Domain<unknown>[];
  workspaceDomains: LoadedWorkspaceDomain[];
  diagnostics: WorkspaceDomainDiagnostic[];
}

/** Result of checking one domain directory outside a running provider. */
export interface DomainValidationResult {
  manifest?: WorkspaceDomainManifest;
  domain?: Domain<unknown>;
  diagnostics: WorkspaceDomainDiagnostic[];
}

export interface WorkspaceDomainOptions {
  directories?: readonly string[];
  language: string;
  builtInDomains: readonly Domain<unknown>[];
}

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const REQUIRED_METHODS = [
  'isBottom',
  'isTop',
  'equal',
  'leq',
  'join',
  'meet',
  'widen',
  'narrow',
  'constant',
  'add',
  'sub',
  'mul',
  'div',
  'mod',
  'neg',
  'refine',
  'format',
  'describeLoss',
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function manifestError(value: unknown): string | undefined {
  if (!isObject(value)) return 'manifest must be a JSON object';
  const allowed = new Set([
    'schemaVersion',
    'apiVersion',
    'id',
    'name',
    'description',
    'kind',
    'entry',
    'languages',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return 'manifest contains an unsupported property';
  }
  if (value.schemaVersion !== DOMAIN_MANIFEST_SCHEMA_VERSION) {
    return `schemaVersion must be ${DOMAIN_MANIFEST_SCHEMA_VERSION}`;
  }
  if (value.apiVersion !== DOMAIN_API_VERSION) {
    return `apiVersion must be "${DOMAIN_API_VERSION}"`;
  }
  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) {
    return 'id must match ^[a-z][a-z0-9-]*$';
  }
  if (typeof value.name !== 'string' || value.name.trim().length === 0) {
    return 'name must be a non-empty string';
  }
  if (value.description !== undefined && typeof value.description !== 'string') {
    return 'description must be a string when present';
  }
  if (value.kind !== 'value-lattice') return 'kind must be "value-lattice"';
  if (
    typeof value.entry !== 'string' ||
    !value.entry.startsWith('./') ||
    !value.entry.endsWith('.mjs')
  ) {
    return 'entry must be a relative .mjs path beginning with "./"';
  }
  if (
    !Array.isArray(value.languages) ||
    value.languages.length === 0 ||
    value.languages.some((language) => typeof language !== 'string' || language.length === 0)
  ) {
    return 'languages must be a non-empty array of non-empty strings';
  }
  if (new Set(value.languages).size !== value.languages.length) {
    return 'languages must not contain duplicates';
  }
  return undefined;
}

function validateGraph(graph: unknown): graph is HasseDiagram {
  if (!isObject(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return false;
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (!isObject(node) || typeof node.id !== 'string' || typeof node.label !== 'string') {
      return false;
    }
    if (ids.has(node.id)) return false;
    ids.add(node.id);
  }
  return graph.edges.every(
    (edge) =>
      Array.isArray(edge) &&
      edge.length === 2 &&
      typeof edge[0] === 'string' &&
      typeof edge[1] === 'string' &&
      ids.has(edge[0]) &&
      ids.has(edge[1])
  );
}

function checkLattice(lattice: unknown, manifest: WorkspaceDomainManifest): string | undefined {
  if (!isObject(lattice)) return 'module must export a `lattice` object';
  if (lattice.id !== manifest.id) return `lattice.id must equal manifest id "${manifest.id}"`;
  if (lattice.name !== manifest.name) {
    return `lattice.name must equal manifest name "${manifest.name}"`;
  }
  if (typeof lattice.finiteLattice !== 'boolean') return 'finiteLattice must be boolean';
  if (!('bottom' in lattice) || !('top' in lattice)) return 'bottom and top values are required';
  for (const method of REQUIRED_METHODS) {
    if (typeof lattice[method] !== 'function') return `lattice.${method} must be a function`;
  }

  try {
    const L = lattice as unknown as ValueLattice<unknown>;
    const samples = [L.bottom, L.top, L.constant(-1), L.constant(0), L.constant(1)];
    if (!L.isBottom(L.bottom)) return 'isBottom(bottom) must be true';
    if (!L.isTop(L.top)) return 'isTop(top) must be true';
    for (const value of samples) {
      if (!L.equal(value, value)) return 'equal must be reflexive on validation samples';
      if (!L.leq(value, value)) return 'leq must be reflexive on validation samples';
      const formatted = L.format(value);
      if (
        !isObject(formatted) ||
        typeof formatted.repr !== 'string' ||
        !['top', 'bottom', 'value'].includes(String(formatted.kind))
      ) {
        return 'format(value) must return { repr, kind } with a valid kind';
      }
    }
    if (!L.equal(L.join(L.bottom, L.top), L.top)) return 'join(bottom, top) must equal top';
    if (!L.equal(L.meet(L.bottom, L.top), L.bottom)) {
      return 'meet(bottom, top) must equal bottom';
    }
    if (!L.equal(L.widen(L.top, L.top), L.top)) return 'widen(top, top) must equal top';
    if (!L.equal(L.narrow(L.top, L.top), L.top)) return 'narrow(top, top) must equal top';

    for (const a of samples) {
      for (const b of samples) {
        if (!L.equal(L.join(a, b), L.join(b, a))) return 'join must be commutative';
        if (!L.equal(L.meet(a, b), L.meet(b, a))) return 'meet must be commutative';
        if (!L.leq(a, L.join(a, b)) || !L.leq(b, L.join(a, b))) {
          return 'join must be an upper bound of both operands';
        }
        const meet = L.meet(a, b);
        if (!L.leq(meet, a) || !L.leq(meet, b)) {
          return 'meet must be a lower bound of both operands';
        }
      }
    }

    // Exercise the remaining operation surface once so an incomplete module
    // fails during discovery rather than during the first classroom demo.
    L.add(L.top, L.top);
    L.sub(L.top, L.top);
    L.mul(L.top, L.top);
    L.div(L.top, L.top);
    L.mod(L.top, L.top);
    L.neg(L.top);
    for (const op of ['<', '<=', '>', '>=', '==', '!='] as const) {
      L.refine(op, L.top, L.top);
    }
    L.describeLoss(L.bottom, L.top, L.top);

    if (L.finiteLattice) {
      if (typeof L.latticeGraph !== 'function') {
        return 'a finite lattice must provide latticeGraph()';
      }
      if (!validateGraph(L.latticeGraph())) return 'latticeGraph() is not a valid Hasse diagram';
    }
  } catch (error) {
    return `lattice validation threw: ${error instanceof Error ? error.message : String(error)}`;
  }
  return undefined;
}

async function loadOne(
  directory: string,
  language: string,
  occupiedIds: Set<string>
): Promise<{ loaded?: LoadedWorkspaceDomain; diagnostic?: WorkspaceDomainDiagnostic }> {
  const manifestPath = path.join(directory, 'domain.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    return {
      diagnostic: {
        severity: 'error',
        code: 'domain.manifest.read',
        message: `cannot read domain.json: ${error instanceof Error ? error.message : String(error)}`,
        path: manifestPath,
      },
    };
  }

  const invalidManifest = manifestError(parsed);
  if (invalidManifest) {
    return {
      diagnostic: {
        severity: 'error',
        code: 'domain.manifest.invalid',
        message: invalidManifest,
        path: manifestPath,
      },
    };
  }
  const manifest = parsed as WorkspaceDomainManifest;
  if (!manifest.languages.includes(language)) return {};
  if (occupiedIds.has(manifest.id)) {
    return {
      diagnostic: {
        severity: 'error',
        code: 'domain.id.collision',
        message: `domain id "${manifest.id}" is already in use; built-in and earlier workspace domains cannot be replaced`,
        path: manifestPath,
      },
    };
  }

  const entry = path.resolve(directory, manifest.entry);
  const relative = path.relative(directory, entry);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return {
      diagnostic: {
        severity: 'error',
        code: 'domain.entry.outside',
        message: 'entry must stay inside its domain directory',
        path: entry,
      },
    };
  }

  try {
    const [realDirectory, realEntry] = await Promise.all([realpath(directory), realpath(entry)]);
    const realRelative = path.relative(realDirectory, realEntry);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      return {
        diagnostic: {
          severity: 'error',
          code: 'domain.entry.symlinkOutside',
          message: 'entry resolves outside its domain directory',
          path: entry,
        },
      };
    }

    const module = (await import(pathToFileURL(realEntry).href)) as Record<string, unknown>;
    const latticeError = checkLattice(module.lattice, manifest);
    if (latticeError) {
      return {
        diagnostic: {
          severity: 'error',
          code: 'domain.lattice.invalid',
          message: latticeError,
          path: entry,
        },
      };
    }

    const domain = new NonRelationalDomain(
      module.lattice as ValueLattice<unknown>
    ) as Domain<unknown>;
    occupiedIds.add(manifest.id);
    return { loaded: { domain, manifest, directory } };
  } catch (error) {
    return {
      diagnostic: {
        severity: 'error',
        code: 'domain.entry.load',
        message: `cannot load entry module: ${error instanceof Error ? error.message : String(error)}`,
        path: entry,
      },
    };
  }
}

export async function loadWorkspaceDomains(options: WorkspaceDomainOptions): Promise<DomainLoadResult> {
  const builtIns = [...options.builtInDomains];
  const occupiedIds = new Set(builtIns.map((domain) => domain.id));
  const workspaceDomains: LoadedWorkspaceDomain[] = [];
  const diagnostics: WorkspaceDomainDiagnostic[] = [];

  for (const root of options.directories ?? []) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      diagnostics.push({
        severity: 'error',
        code: 'domain.directory.read',
        message: `cannot scan workspace domain directory: ${error instanceof Error ? error.message : String(error)}`,
        path: root,
      });
      continue;
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const result = await loadOne(path.join(root, entry.name), options.language, occupiedIds);
      if (result.loaded) workspaceDomains.push(result.loaded);
      if (result.diagnostic) diagnostics.push(result.diagnostic);
    }
  }

  return {
    domains: [...builtIns, ...workspaceDomains.map((loaded) => loaded.domain)],
    workspaceDomains,
    diagnostics,
  };
}

/** Validates a single domain directory using the same loader used by providers.
 * Callers may reserve IDs (for example, built-in domain IDs) before the check. */
export async function validateWorkspaceDomain(
  directory: string,
  occupiedIds: readonly string[] = []
): Promise<DomainValidationResult> {
  const manifestPath = path.join(directory, 'domain.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    return {
      diagnostics: [
        {
          severity: 'error',
          code: 'domain.manifest.read',
          message: `cannot read domain.json: ${error instanceof Error ? error.message : String(error)}`,
          path: manifestPath,
        },
      ],
    };
  }
  const invalidManifest = manifestError(parsed);
  if (invalidManifest) {
    return {
      diagnostics: [
        {
          severity: 'error',
          code: 'domain.manifest.invalid',
          message: invalidManifest,
          path: manifestPath,
        },
      ],
    };
  }
  const manifest = parsed as WorkspaceDomainManifest;
  const result = await loadOne(directory, manifest.languages[0]!, new Set(occupiedIds));
  return {
    manifest,
    ...(result.loaded ? { domain: result.loaded.domain } : {}),
    diagnostics: result.diagnostic ? [result.diagnostic] : [],
  };
}

/** Reads the extension-controlled environment variable. It is intentionally
 * ignored unless it is valid JSON containing only absolute directory paths. */
export function domainDirectoriesFromEnvironment(
  value = process.env.AIVIZ_DOMAIN_DIRECTORIES
): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) return [];
    return parsed.filter((item) => path.isAbsolute(item));
  } catch {
    return [];
  }
}
