/**
 * Regenerates the reference trace fixture by running the real provider over
 * real C source.
 *
 * The client is therefore always developed against output a provider actually
 * produces, rather than something hand-written that could drift from reality.
 *
 *   node scripts/gen-fixture.mjs [file.c] [function] [domain]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CSourceProvider } from '../packages/provider-c-source/dist/provider.js';
import { validateTrace } from '../packages/trace-protocol/dist/index.js';

const file = process.argv[2] ?? 'examples/count.c';
const fn = process.argv[3] ?? 'count';
const domain = process.argv[4] ?? 'intervals';

const source = readFileSync(file, 'utf8');
const provider = new CSourceProvider();

const { functions } = await provider.listFunctions({ file, source });
console.log(
  'functions:',
  functions.map((f) => `${f.name}${f.supported ? '' : ' (unsupported)'}`).join(', ')
);

const trace = await provider.analyze({ file, source, function: fn, domain });

const result = validateTrace(trace);
if (!result.valid) {
  console.error('generated trace is invalid:');
  for (const i of result.issues) console.error(`  ${i.path}: ${i.message}`);
  process.exit(1);
}

const out = 'packages/trace-protocol/fixtures/count-intervals.trace.json';
writeFileSync(out, `${JSON.stringify(trace, null, 2)}\n`);
console.log(
  `wrote ${out}: ${trace.summary.stepCount} steps, ` +
    `${trace.summary.iterations} iterations, ` +
    `${trace.summary.wideningStepIndices.length} widening step(s)`
);
