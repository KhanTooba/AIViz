import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTrace, type AnalysisTrace } from '@aiviz/trace-protocol';
import { CSourceProvider } from '../provider.js';
import { compressLines } from '../cfgbuilder.js';

const provider = new CSourceProvider();

async function analyze(
  source: string,
  fn = 'f',
  domain = 'intervals'
): Promise<AnalysisTrace> {
  return provider.analyze({ file: 'test.c', source, function: fn, domain });
}

/** Value of a variable in the state last pushed into the exit block. */
function exitValue(trace: AnalysisTrace, name: string): string | undefined {
  const step = [...trace.steps]
    .reverse()
    .find((s) => s.kind === 'push' && s.blockId === trace.cfg.exit);
  return step?.after.vars.find((v) => v.name === name)?.repr;
}

function blockByLabel(trace: AnalysisTrace, label: string): string | undefined {
  return trace.cfg.blocks.find((b) => b.label?.includes(label))?.blockId;
}

test('compressLines turns a line set into contiguous ranges', () => {
  assert.deepEqual(compressLines(new Set([7, 9, 10, 11])), [
    { start: 7, end: 7 },
    { start: 9, end: 11 },
  ]);
  assert.deepEqual(compressLines(new Set()), []);
});

test('lists functions with their supportability', async () => {
  const source = `
int good(void) { int i = 0; return i; }
int bad(int *p) { return *p; }
`;
  const { functions } = await provider.listFunctions({ file: 't.c', source });
  assert.deepEqual(
    functions.map((f) => f.name),
    ['good', 'bad']
  );
  assert.equal(functions[0]!.supported, true);
  assert.equal(functions[1]!.supported, false);
  assert.match(functions[1]!.reason ?? '', /pointer/);
});

test('analyses a while loop and recovers the exact exit value', async () => {
  const trace = await analyze(`
int f(void) {
  int i = 0;
  while (i < 10) {
    i = i + 1;
  }
  return i;
}
`);
  assert.deepEqual(validateTrace(trace).issues, []);
  assert.equal(trace.summary.converged, true);
  assert.equal(exitValue(trace, 'i'), '[10, 10]');
  assert.ok(trace.summary.wideningStepIndices.length > 0, 'expected widening');
});

test('the entry block is b0 and the loop header is detected', async () => {
  const trace = await analyze(`
int f(void) {
  int i = 0;
  while (i < 10) { i = i + 1; }
  return i;
}
`);
  const entry = trace.cfg.blocks.find((b) => b.isEntry);
  assert.equal(entry?.blockId, 'b0');
  const headers = trace.cfg.blocks.filter((b) => b.isLoopHeader);
  assert.equal(headers.length, 1);
  assert.match(headers[0]!.label ?? '', /while \(i < 10\)/);
});

test('a for loop maps one source line onto several program points', async () => {
  // The headline claim: `for (i = 0; i < n; i++)` is init, condition and latch.
  const trace = await analyze(`
int f(void) {
  int s = 0;
  for (int i = 0; i < 10; i++) {
    s = s + 1;
  }
  return s;
}
`);
  assert.deepEqual(validateTrace(trace).issues, []);
  const onLine4 = trace.lineMap.lineToBlocks['4'] ?? [];
  assert.ok(
    onLine4.length >= 2,
    `expected the for-header line to map to several blocks, got ${JSON.stringify(onLine4)}`
  );
  // And the best-match must be one of them.
  assert.ok(onLine4.includes(trace.lineMap.bestBlockForLine!['4']!));
});

test('for loops reach the same counter bound as the equivalent while loop', async () => {
  const trace = await analyze(`
int f(void) {
  int s = 0;
  for (int i = 0; i < 10; i = i + 1) {
    s = s + 1;
  }
  return s;
}
`);
  assert.equal(trace.summary.converged, true);
  // The guard bounds i, so narrowing recovers it exactly.
  assert.equal(exitValue(trace, 'i'), '[10, 10]');
});

test('intervals cannot bound a counter the loop guard does not mention', async () => {
  // Documents a real limitation rather than papering over it: the interval
  // domain is *non-relational*, so it tracks s and i independently and has no
  // way to learn "s equals i". The guard bounds i, nothing bounds s, and
  // narrowing has no finite value to recover. A relational domain (octagons)
  // would get [0, 10] here — which is exactly the v3 motivation.
  const trace = await analyze(`
int f(void) {
  int s = 0;
  for (int i = 0; i < 10; i = i + 1) {
    s = s + 1;
  }
  return s;
}
`);
  assert.equal(exitValue(trace, 's'), '[0, +∞)');
});

test('handles if/else, and both branches reach the join', async () => {
  const trace = await analyze(`
int f(int n) {
  int x = 0;
  if (n > 0) {
    x = 1;
  } else {
    x = 2;
  }
  return x;
}
`);
  assert.deepEqual(validateTrace(trace).issues, []);
  // Joining x = 1 and x = 2 gives the interval [1, 2].
  assert.equal(exitValue(trace, 'x'), '[1, 2]');
});

test('an if without else still joins with the fall-through path', async () => {
  const trace = await analyze(`
int f(int n) {
  int x = 0;
  if (n > 0) { x = 5; }
  return x;
}
`);
  assert.equal(exitValue(trace, 'x'), '[0, 5]');
});

test('handles do-while, whose body always runs once', async () => {
  const trace = await analyze(`
int f(void) {
  int i = 0;
  do {
    i = i + 1;
  } while (i < 5);
  return i;
}
`);
  assert.deepEqual(validateTrace(trace).issues, []);
  assert.equal(trace.summary.converged, true);
  assert.equal(exitValue(trace, 'i'), '[5, 5]');
});

test('handles break and continue', async () => {
  const trace = await analyze(`
int f(void) {
  int i = 0;
  while (i < 100) {
    i = i + 1;
    if (i > 10) { break; }
    continue;
  }
  return i;
}
`);
  assert.deepEqual(validateTrace(trace).issues, []);
  assert.equal(trace.summary.converged, true);
});

test('a block with several straight-line statements shows every statement', async () => {
  // Regression test: block labels used to be "first statement wins", so a
  // block with no branching between its statements silently dropped every
  // line after the first from the CFG display (the analysis itself was still
  // correct — only what the user could *see* was wrong).
  const trace = await analyze(`
int f(void) {
  int a = 0;
  int b = 1;
  a = a + b;
  b = a + b;
  return a;
}
`);
  const entry = trace.cfg.blocks.find((b) => b.isEntry);
  assert.ok(entry);
  const lines = (entry!.label ?? '').split('\n');
  // Nothing branches in this function, so entry, all four statements and the
  // final return all land in one block — every one of them must be visible.
  assert.deepEqual(lines, [
    'entry',
    'int a = 0;',
    'int b = 1;',
    'a = a + b;',
    'b = a + b;',
    'return a;',
  ]);
});

test('a multi-declarator declaration gets one label line per variable', async () => {
  // Regression test: each declarator used to be labelled with the *whole*
  // declaration's text, so `int i = 0, j = 1;` showed the same full line
  // twice instead of one line per variable.
  const trace = await analyze(`
int f(void) {
  int i = 0, j = 1;
  return i + j;
}
`);
  const entry = trace.cfg.blocks.find((b) => b.isEntry);
  const lines = (entry?.label ?? '').split('\n');
  assert.deepEqual(lines, ['entry', 'int i = 0;', 'int j = 1;', 'return i + j;']);
});

test('break and continue each appear as their own label line', async () => {
  const trace = await analyze(`
int f(void) {
  int i = 0;
  while (i < 100) {
    i = i + 1;
    if (i > 10) { break; }
    continue;
  }
  return i;
}
`);
  const breakBlock = blockByLabel(trace, 'break;');
  const continueBlock = blockByLabel(trace, 'continue;');
  assert.ok(breakBlock, 'expected a block labelled with break;');
  assert.ok(continueBlock, 'expected a block labelled with continue;');
});

test('handles nested loops with two widening points', async () => {
  const trace = await analyze(`
int f(void) {
  int i = 0;
  int total = 0;
  while (i < 10) {
    int j = 0;
    while (j < 5) {
      total = total + 1;
      j = j + 1;
    }
    i = i + 1;
  }
  return total;
}
`);
  assert.deepEqual(validateTrace(trace).issues, []);
  assert.equal(trace.summary.converged, true);
  assert.equal(
    trace.cfg.blocks.filter((b) => b.isLoopHeader).length,
    2,
    'expected two loop headers'
  );
});

test('compound assignment and ++ are desugared', async () => {
  const trace = await analyze(`
int f(void) {
  int i = 0;
  i += 3;
  i++;
  return i;
}
`);
  assert.equal(exitValue(trace, 'i'), '[4, 4]');
});

test('an uninitialised local is unknown, not assumed zero', async () => {
  const trace = await analyze(`
int f(void) {
  int x;
  return x;
}
`);
  assert.equal(exitValue(trace, 'x'), '⊤');
});

test('a parameter is unknown at entry', async () => {
  const trace = await analyze(`
int f(int n) {
  return n;
}
`);
  assert.equal(exitValue(trace, 'n'), '⊤');
});

test('a guard on a parameter narrows it', async () => {
  const trace = await analyze(`
int f(int n) {
  if (n > 5) { return n; }
  return 0;
}
`);
  // On the taken branch n is at least 6.
  const narrowed = trace.steps.find(
    (s) => s.kind === 'transfer' && s.after.vars.some((v) => v.name === 'n' && v.repr === '[6, +∞)')
  );
  assert.ok(narrowed, 'expected the guard n > 5 to narrow n to [6, +inf)');
});

test('every domain produces a valid trace for the same program', async () => {
  const source = `
int f(void) {
  int i = 0;
  while (i < 10) { i = i + 1; }
  return i;
}
`;
  for (const domain of ['intervals', 'sign', 'constprop']) {
    const trace = await analyze(source, 'f', domain);
    assert.deepEqual(validateTrace(trace).issues, [], `${domain} produced an invalid trace`);
    assert.equal(trace.summary.converged, true, `${domain} did not converge`);
  }
});

// ---------------------------------------------------------------- precheck

const REJECTED: [string, string, RegExp][] = [
  ['pointers', 'int f(int *p) { return 1; }', /pointer/],
  ['arrays', 'int f(void) { int a[10]; return a[0]; }', /array/],
  ['floats', 'int f(void) { float x = 1.5; return 0; }', /float/],
  ['function calls', 'int g(void); int f(void) { return g(); }', /function call/],
  ['goto', 'int f(void) { goto end; end: return 0; }', /goto|label/],
  ['structs', 'struct S { int a; }; int f(void) { struct S s; return s.a; }', /struct/],
  ['switch', 'int f(int n) { switch (n) { case 1: return 1; } return 0; }', /switch/],
  ['ternary', 'int f(int n) { return n > 0 ? 1 : 2; }', /ternary/],
  ['casts', 'int f(int n) { return (int)n; }', /cast/],
  ['strings', 'int f(void) { char *s = "hi"; return 0; }', /string|pointer/],
];

for (const [label, source, pattern] of REJECTED) {
  test(`rejects ${label} with an exact line and reason`, async () => {
    const { diagnostics, supported } = await provider.precheck({
      file: 't.c',
      source,
      function: 'f',
    });
    assert.equal(supported, false, `expected ${label} to be rejected`);
    assert.ok(diagnostics.length > 0);
    const joined = diagnostics.map((d) => d.message).join(' | ');
    assert.match(joined, pattern);
    for (const d of diagnostics) {
      assert.ok(d.line >= 1, 'every diagnostic needs a real line number');
      assert.ok(d.code.length > 0, 'every diagnostic needs a machine-readable code');
    }
  });
}

test('rejects unparseable source rather than analysing a mis-parse', async () => {
  // tree-sitter recovers from broken C silently, so this must be caught.
  const { supported, diagnostics } = await provider.precheck({
    file: 't.c',
    source: 'int f(void) { int i = ; while ( { } }',
    function: 'f',
  });
  assert.equal(supported, false);
  assert.ok(diagnostics.some((d) => d.code === 'parse.error'));
});

test('an unsupported program yields a valid trace carrying the reasons', async () => {
  // The client must get something renderable, not an exception or a blank panel.
  const trace = await analyze('int f(int *p) { return *p; }');
  assert.deepEqual(validateTrace(trace).issues, []);
  assert.equal(trace.summary.converged, false);
  assert.equal(trace.steps.length, 0);
  assert.ok(trace.diagnostics.length > 0);
  assert.match(trace.diagnostics[0]!.message, /pointer/);
});

test('reports a missing function clearly', async () => {
  const trace = await analyze('int f(void) { return 0; }', 'nope');
  assert.deepEqual(validateTrace(trace).issues, []);
  assert.match(trace.diagnostics[0]!.message, /no function named/);
});

test('block line sets never claim a line the block does not own', async () => {
  const trace = await analyze(`
int f(void) {
  int i = 0;
  while (i < 10) {
    i = i + 1;
  }
  return i;
}
`);
  const header = blockByLabel(trace, 'while');
  assert.ok(header);
  // The loop header owns the condition line (4), not the body line (5).
  assert.deepEqual(trace.lineMap.blockToLines[header], [{ start: 4, end: 4 }]);
});
