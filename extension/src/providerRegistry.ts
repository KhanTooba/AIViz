import { existsSync } from 'node:fs';
import * as path from 'node:path';
import providerData from '../providers.json';

export interface BundledProvider {
  id: string;
  name: string;
  languageIds: string[];
  fileExtensions: string[];
  bundlePath: string;
  developmentPackage: string;
  needsWasmDirectory: boolean;
}

export interface ProviderDocument {
  languageId: string;
  fileName: string;
}

export interface ResolvedProviderLaunch {
  entry: string;
  env?: Record<string, string>;
}

export const BUNDLED_PROVIDERS: readonly BundledProvider[] = providerData;

/** Selects a provider using VS Code's language id, with the filename as a
 * fallback for installations whose syntax extension assigns a different id. */
export function providerForDocument(doc: ProviderDocument): BundledProvider | undefined {
  const byLanguage = BUNDLED_PROVIDERS.find((provider) =>
    provider.languageIds.includes(doc.languageId)
  );
  if (byLanguage) return byLanguage;

  const extension = path.extname(doc.fileName).toLowerCase();
  return BUNDLED_PROVIDERS.find((provider) => provider.fileExtensions.includes(extension));
}

/** Locates the same provider in an installed VSIX or a monorepo development
 * host. Every candidate is local; this registry never downloads executables. */
export function resolveProviderLaunch(
  extensionPath: string,
  provider: BundledProvider,
  workspaceDomainDirectories: readonly string[] = []
): ResolvedProviderLaunch | undefined {
  const packageName = provider.developmentPackage;
  const candidates = [
    path.join(extensionPath, ...provider.bundlePath.split('/')),
    path.join(extensionPath, '..', 'packages', packageName, 'dist', 'main.js'),
    path.join(extensionPath, 'node_modules', '@aiviz', packageName, 'dist', 'main.js'),
    path.join(extensionPath, '..', 'node_modules', '@aiviz', packageName, 'dist', 'main.js'),
  ];
  const entry = candidates.find((candidate) => existsSync(candidate));
  if (!entry) return undefined;

  const env: Record<string, string> = {};
  if (provider.needsWasmDirectory) env.AIVIZ_WASM_DIR = path.dirname(entry);
  if (workspaceDomainDirectories.length > 0) {
    // JSON preserves paths containing the platform delimiter and is parsed by
    // @aiviz/domain-sdk inside the provider subprocess.
    env.AIVIZ_DOMAIN_DIRECTORIES = JSON.stringify(workspaceDomainDirectories);
  }
  return { entry, ...(Object.keys(env).length > 0 ? { env } : {}) };
}

export function supportedDocumentDescription(): string {
  const names = BUNDLED_PROVIDERS.map((provider) => provider.name.replace(/ \(.+\)$/, ''));
  const extensions = BUNDLED_PROVIDERS.flatMap((provider) => provider.fileExtensions);
  return `${names.join(' or ')} file (${extensions.join(' or ')})`;
}
