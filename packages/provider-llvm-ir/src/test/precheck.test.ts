import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModule } from '../parser.js';
import { precheckFunction } from '../precheck.js';

function precheck(body: string, params = ''): ReturnType<typeof precheckFunction> {
  const mod = parseModule(`define i32 @f(${params}) {\n${body}\n}\n`);
  return precheckFunction(mod.functions[0]!);
}

test('a supported alloca/load/store loop has no diagnostics', () => {
  const out = precheck(`
  %1 = alloca i32, align 4
  store i32 0, ptr %1, align 4
  %2 = load i32, ptr %1, align 4
  %3 = icmp slt i32 %2, 10
  br i1 %3, label %body, label %exitblock
body:
  %4 = load i32, ptr %1, align 4
  %5 = add nsw i32 %4, 1
  store i32 %5, ptr %1, align 4
  br label %exitblock
exitblock:
  ret i32 0
`);
  assert.deepEqual(out, []);
});

const REJECTED: [label: string, body: string, pattern: RegExp][] = [
  ['call', '  %1 = call i32 @g()\n  ret i32 %1', /function calls/],
  ['getelementptr', '  %1 = getelementptr i32, ptr null, i32 0\n  ret i32 0', /pointer arithmetic/],
  ['switch', '  switch i32 0, label %a [ i32 1, label %a ]\na:\n  ret i32 0', /switch/],
  ['fadd', '  %1 = fadd float 1.0, 2.0\n  ret i32 0', /floating-point/],
  ['and (bitwise)', '  %1 = and i32 1, 2\n  ret i32 %1', /bitwise/],
  ['shl', '  %1 = shl i32 1, 2\n  ret i32 %1', /shift/],
  ['udiv', '  %1 = udiv i32 1, 2\n  ret i32 %1', /unsigned/],
  ['icmp ult', '  %1 = icmp ult i32 1, 2\n  ret i32 0', /unsigned/],
];

for (const [label, body, pattern] of REJECTED) {
  test(`rejects ${label} with a real line and reason`, () => {
    const out = precheck(body);
    assert.ok(out.length > 0, `expected at least one diagnostic for ${label}`);
    assert.ok(out.every((d) => d.line >= 1));
    assert.ok(out.some((d) => pattern.test(d.message)));
  });
}

test('rejects a plain SSA temporary used outside the block that defines it', () => {
  const out = precheck(`
  %1 = add i32 1, 2
  br label %next
next:
  ret i32 %1
`);
  assert.ok(out.some((d) => d.code === 'unsupported.crossBlockValue'));
});

test('does not flag a phi result used across blocks — that is exactly what phi is for', () => {
  const out = precheck(`
  br label %loop
loop:
  %i = phi i32 [ 0, %0 ], [ %i.next, %loop ]
  %i.next = add i32 %i, 1
  %done = icmp slt i32 %i, 10
  br i1 %done, label %loop, label %exitblock
exitblock:
  ret i32 %i
`);
  assert.deepEqual(out, []);
});

test('does not flag a parameter used across blocks', () => {
  const out = precheck(
    `
  br label %next
next:
  ret i32 %n
`,
    'i32 %n'
  );
  assert.deepEqual(out, []);
});

test('a parse error is fatal and reported immediately, not mixed with other diagnostics', () => {
  const out = precheck(`
  %1 = add i32 nonsense operand list
  ret i32 %1
`);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.code, 'parse.error');
});

test('collects every diagnostic in a function, not just the first', () => {
  const out = precheck(`
  %1 = call i32 @g()
  %2 = fadd float 1.0, 2.0
  ret i32 %1
`);
  assert.ok(out.some((d) => d.code === 'unsupported.call'));
  assert.ok(out.some((d) => d.message.includes('floating-point')));
});
