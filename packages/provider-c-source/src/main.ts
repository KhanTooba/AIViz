#!/usr/bin/env node
/**
 * Provider process entry point.
 *
 * Runs out of process precisely so a crash or an infinite loop in an
 * analysis cannot take the editor down with it. The stdio JSON-RPC transport
 * itself is shared with every AIViz provider — see @aiviz/provider-sdk.
 */

import { domainDirectoriesFromEnvironment } from '@aiviz/domain-sdk';
import { serveOverStdio } from '@aiviz/provider-sdk';
import { CSourceProvider } from './provider.js';

serveOverStdio(new CSourceProvider({ domainDirectories: domainDirectoriesFromEnvironment() }));
