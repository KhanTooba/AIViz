import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ProviderManifest } from '@aiviz/trace-protocol';

const REQUIRED_FIELDS = ['id', 'name', 'version', 'languages', 'command'] as const;

/** Reads and structurally checks a `provider.json`. */
export function loadProviderManifest(manifestPath: string): ProviderManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`could not read ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`${manifestPath} does not contain a JSON object`);
  }
  const manifest = raw as Partial<ProviderManifest>;
  for (const field of REQUIRED_FIELDS) {
    if (manifest[field] === undefined) {
      throw new Error(`${manifestPath} is missing required field "${field}"`);
    }
  }
  if (!Array.isArray(manifest.languages) || manifest.languages.length === 0) {
    throw new Error(`${manifestPath}: "languages" must be a non-empty array`);
  }
  return manifest as ProviderManifest;
}

export interface ResolvedLaunch {
  command: string;
  args: string[];
  cwd: string;
}

/** Resolves a manifest's launch command against the manifest's own location,
 * so `provider.json` can be shipped and referenced from anywhere. */
export function resolveProviderLaunch(manifestPath: string, manifest: ProviderManifest): ResolvedLaunch {
  const manifestDir = dirname(resolve(manifestPath));
  return {
    command: manifest.command,
    args: manifest.args ?? [],
    cwd: manifest.cwd ? resolve(manifestDir, manifest.cwd) : manifestDir,
  };
}
