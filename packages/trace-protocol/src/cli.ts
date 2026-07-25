#!/usr/bin/env node
/**
 * `aiviz-validate <trace.json...>`
 *
 * Conformance check for provider authors. Exits non-zero if any trace is
 * invalid, so it drops straight into CI.
 */

import { readFileSync } from 'node:fs';
import { PROTOCOL_VERSION } from './trace.js';
import { validateTrace } from './validate.js';

function main(argv: string[]): number {
  const files = argv.filter((a) => !a.startsWith('-'));
  if (files.length === 0) {
    process.stderr.write(
      `aiviz-validate — AIViz trace protocol ${PROTOCOL_VERSION}\n\n` +
        `usage: aiviz-validate <trace.json> [more.json...]\n` +
        `       cat trace.json | aiviz-validate -\n`
    );
    return 2;
  }

  let failed = 0;
  for (const file of files) {
    let parsed: unknown;
    try {
      const raw = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
      parsed = JSON.parse(raw);
    } catch (err) {
      process.stdout.write(`FAIL ${file}\n  could not read or parse: ${String(err)}\n`);
      failed++;
      continue;
    }

    const result = validateTrace(parsed);
    if (result.valid) {
      process.stdout.write(`ok   ${file}\n`);
    } else {
      failed++;
      process.stdout.write(`FAIL ${file}  (${result.issues.length} issue(s))\n`);
      for (const issue of result.issues) {
        process.stdout.write(`  ${issue.path || '<root>'}: ${issue.message}\n`);
      }
    }
  }
  return failed === 0 ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
