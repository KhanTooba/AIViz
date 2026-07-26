export * from './ir.js';
export * from './domain.js';
export * from './dominators.js';
export * from './engine.js';
export { intervalDomain, intervalLattice, type Interval } from './domains/intervals.js';
export { signDomain, signLattice, type Sign } from './domains/sign.js';
export { constDomain, constLattice, type Const } from './domains/constprop.js';
export { parityDomain, parityLattice, type Parity } from './domains/parity.js';
export { congruenceDomain, congruenceLattice, type Congruence } from './domains/congruence.js';
export { zonesDomain, type ZoneEnv } from './domains/zones.js';
export { octagonsDomain, type OctEnv } from './domains/octagons.js';
export { zonotopesDomain, type ZonoEnv } from './domains/zonotopes.js';
export { polyhedraDomain, type PolyEnv } from './domains/polyhedra.js';

import { intervalDomain } from './domains/intervals.js';
import { signDomain } from './domains/sign.js';
import { constDomain } from './domains/constprop.js';
import { parityDomain } from './domains/parity.js';
import { congruenceDomain } from './domains/congruence.js';
import { zonesDomain } from './domains/zones.js';
import { octagonsDomain } from './domains/octagons.js';
import { zonotopesDomain } from './domains/zonotopes.js';
import { polyhedraDomain } from './domains/polyhedra.js';
import type { Domain } from './domain.js';

/** Domains shipped in v1, in the order they should appear in the UI. */
export const DOMAINS: Domain<unknown>[] = [
  intervalDomain as Domain<unknown>,
  signDomain as Domain<unknown>,
  constDomain as Domain<unknown>,
  parityDomain as Domain<unknown>,
  congruenceDomain as Domain<unknown>,
  zonesDomain as Domain<unknown>,
  octagonsDomain as Domain<unknown>,
  zonotopesDomain as Domain<unknown>,
  polyhedraDomain as Domain<unknown>,
];

export function domainById(id: string): Domain<unknown> | undefined {
  return DOMAINS.find((d) => d.id === id);
}
