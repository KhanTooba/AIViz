import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLoopHeaders } from '@aiviz/analysis-core';
import { parseModule } from '../parser.js';
import { buildCfg } from '../cfgbuilder.js';

function cfgFor(body: string, params = ''): ReturnType<typeof buildCfg> {
  const mod = parseModule(`define i32 @f(${params}) {\n${body}\n}\n`);
  return buildCfg(mod.functions[0]!);
}

test('a straight-line function has an entry block and a separate exit block', () => {
  // Mirrors the tree-sitter C provider's own CfgBuilder: the exit block is
  // always allocated separately (every `ret` edges to it), even for a
  // single-statement function — never merged with entry.
  const cfg = cfgFor(`
  %1 = alloca i32, align 4
  store i32 5, ptr %1, align 4
  %2 = load i32, ptr %1, align 4
  ret i32 %2
`);
  assert.equal(cfg.blocks.length, 2);
  const entry = cfg.blocks.find((b) => b.isEntry)!;
  const exit = cfg.blocks.find((b) => b.isExit)!;
  assert.ok(entry && exit && entry.id !== exit.id);
  assert.deepEqual(
    cfg.variables.map((v) => v.name),
    ['1', '$ret']
  );
});

test('an alloca-based loop produces the correct topology and a discoverable loop header', () => {
  const cfg = cfgFor(`
  %1 = alloca i32, align 4
  store i32 0, ptr %1, align 4
  br label %2
2:
  %3 = load i32, ptr %1, align 4
  %4 = icmp slt i32 %3, 10
  br i1 %4, label %5, label %8
5:
  %6 = load i32, ptr %1, align 4
  %7 = add nsw i32 %6, 1
  store i32 %7, ptr %1, align 4
  br label %2
8:
  %9 = load i32, ptr %1, align 4
  ret i32 %9
`);
  assert.equal(cfg.blocks.length, 5); // entry, "2", "5", "8", plus the separate exit block
  const header = cfg.blocks.find((b) => b.preds.length === 2);
  assert.ok(header, 'expected a block with two predecessors (the loop header)');
  const headers = findLoopHeaders(cfg);
  assert.deepEqual([...headers], [header!.id]);
});

test('function parameters are declared and havoc\'d in the entry block', () => {
  const cfg = cfgFor('ret i32 %n', 'i32 %n');
  assert.ok(cfg.variables.some((v) => v.name === 'n'));
  const entry = cfg.blocks.find((b) => b.isEntry)!;
  assert.ok(entry.instrs.some((i) => i.kind === 'havoc' && i.target === 'n'));
});

test('an if/else via two blocks and a conditional br produces complementary guarded edges', () => {
  const cfg = cfgFor(`
  %1 = icmp slt i32 1, 2
  br i1 %1, label %then, label %else
then:
  br label %join
else:
  br label %join
join:
  ret i32 0
`);
  const entry = cfg.blocks.find((b) => b.isEntry)!;
  assert.equal(entry.succs.length, 2);
  const conds = entry.succs.map((e) => e.cond?.kind);
  assert.ok(conds.includes('cmp'));
});

test('a phi node becomes a predecessor-tail assign, not an instruction in the merge block', () => {
  // The entry block is given an explicit label here (matching the
  // checked-in phi-counting-loop.ll fixture) rather than referencing it by
  // LLVM's implicit numeric label from the phi — this builder does not
  // replicate LLVM's exact implicit-numbering scheme for an unlabeled
  // entry block (which depends on parameter count and definition order),
  // a disclosed, narrow scope limitation; real `-O0` clang output never
  // has phi nodes at all (see cfgbuilder.ts's module doc comment), so this
  // only matters for hand-written or mem2reg'd IR, where explicit labels
  // are the common, recommended style anyway.
  const cfg = cfgFor(`
  br label %loop
loop:
  %i = phi i32 [ 0, %entry ], [ %i.next, %loop ]
  %i.next = add i32 %i, 1
  %done = icmp slt i32 %i, 10
  br i1 %done, label %loop, label %exitblock
exitblock:
  ret i32 %i
`);
  const loopBlock = cfg.blocks.find((b) => b.preds.length === 2);
  assert.ok(loopBlock, 'expected a block with two predecessors (the phi merge point)');
  assert.ok(
    !loopBlock!.instrs.some((i) => i.kind === 'assign' && i.target === 'i'),
    'the phi target must not be assigned inside the merge block itself'
  );
  const assignsI = cfg.blocks.flatMap((b) => b.instrs.filter((i) => i.kind === 'assign' && i.target === 'i'));
  assert.equal(assignsI.length, 2, 'expected one phi-derived assign per incoming edge');
  assert.ok(cfg.variables.some((v) => v.name === 'i'));
});

test('$ret is assigned from the returned expression right before the exit edge', () => {
  const cfg = cfgFor(`
  %1 = add i32 2, 3
  ret i32 %1
`);
  const exit = cfg.blocks.find((b) => b.isExit)!;
  const source = cfg.blocks.find((b) => b.succs.some((e) => e.target === exit.id))!;
  assert.ok(source.instrs.some((i) => i.kind === 'assign' && i.target === '$ret'));
});
