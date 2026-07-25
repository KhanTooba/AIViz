export * from './ir.js';
export * from './domain.js';
export * from './dominators.js';
export * from './engine.js';
export { intervalDomain, intervalLattice, type Interval } from './domains/intervals.js';
export { signDomain, signLattice, type Sign } from './domains/sign.js';
export { constDomain, constLattice, type Const } from './domains/constprop.js';

import { intervalDomain } from './domains/intervals.js';
import { signDomain } from './domains/sign.js';
import { constDomain } from './domains/constprop.js';
import type { Domain } from './domain.js';

/** Domains shipped in v1, in the order they should appear in the UI. */
export const DOMAINS: Domain<unknown>[] = [
  intervalDomain as Domain<unknown>,
  signDomain as Domain<unknown>,
  constDomain as Domain<unknown>,
];

export function domainById(id: string): Domain<unknown> | undefined {
  return DOMAINS.find((d) => d.id === id);
}
