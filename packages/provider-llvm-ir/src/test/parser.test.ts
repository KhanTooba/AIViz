import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseModule } from '../parser.js';

function oneFunction(body: string): ReturnType<typeof parseModule>['functions'][number] {
  const mod = parseModule(`define i32 @f() {\n${body}\n}\n`);
  assert.equal(mod.functions.length, 1);
  return mod.functions[0]!;
}

test('parses alloca/store/load/ret into the expected instruction kinds', () => {
  const fn = oneFunction(`
  %1 = alloca i32, align 4
  store i32 0, ptr %1, align 4
  %2 = load i32, ptr %1, align 4
  ret i32 %2
`);
  assert.equal(fn.blocks.length, 1);
  const kinds = fn.blocks[0]!.instrs.map((i) => i.kind);
  assert.deepEqual(kinds, ['alloca', 'store', 'load', 'ret']);
});

test('parses arithmetic ops with nsw/nuw flags stripped', () => {
  const fn = oneFunction(`
  %1 = add nsw i32 1, 2
  %2 = sub nuw i32 %1, 1
  %3 = mul i32 %2, 2
  %4 = sdiv i32 %3, 2
  %5 = srem i32 %4, 2
  ret i32 %5
`);
  const ops = fn.blocks[0]!.instrs.filter((i) => i.kind === 'binop').map((i) => (i.kind === 'binop' ? i.op : undefined));
  assert.deepEqual(ops, ['+', '-', '*', '/', '%']);
});

test('parses signed icmp predicates, and flags unsigned predicates as unsupported', () => {
  const fn = oneFunction(`
  %1 = icmp slt i32 1, 2
  %2 = icmp ult i32 1, 2
  ret void
`);
  const [a, b] = fn.blocks[0]!.instrs;
  assert.equal(a!.kind, 'icmp');
  assert.equal(b!.kind, 'unsupported');
});

test('parses a conditional br into ifTrue/ifFalse and a cond value', () => {
  const fn = oneFunction(`
  %1 = icmp slt i32 1, 2
  br i1 %1, label %yes, label %no
yes:
  ret i32 1
no:
  ret i32 0
`);
  const term = fn.blocks[0]!.instrs.find((i) => i.kind === 'br');
  assert.ok(term && term.kind === 'br');
  assert.equal(term.ifTrue, 'yes');
  assert.equal(term.ifFalse, 'no');
});

test('parses phi nodes with multiple incoming entries', () => {
  const fn = oneFunction(`
  br label %loop
loop:
  %i = phi i32 [ 0, %0 ], [ %i.next, %loop ]
  %i.next = add i32 %i, 1
  br label %loop
`);
  const loopBlock = fn.blocks.find((b) => b.label === 'loop')!;
  const phi = loopBlock.instrs.find((i) => i.kind === 'phi');
  assert.ok(phi && phi.kind === 'phi');
  assert.equal(phi.incoming.length, 2);
  assert.equal(phi.incoming[1]!.pred, 'loop');
});

test('an unrecognized but well-formed opcode becomes `unsupported`, not a parse error', () => {
  const fn = oneFunction(`
  %1 = call i32 @g()
  ret i32 %1
`);
  const instr = fn.blocks[0]!.instrs[0]!;
  assert.equal(instr.kind, 'unsupported');
  assert.equal(instr.kind === 'unsupported' ? instr.opcode : undefined, 'call');
});

test('genuinely malformed syntax becomes a parse error', () => {
  const fn = oneFunction(`
  %1 = add i32 this is not an operand list
  ret i32 %1
`);
  const instr = fn.blocks[0]!.instrs[0]!;
  assert.equal(instr.kind, 'parse-error');
});

test('a function whose first block has an explicit label does not get a spurious duplicate empty block', () => {
  const mod = parseModule(`
define i32 @f() {
entry:
  ret i32 0
}
`);
  const fn = mod.functions[0]!;
  assert.equal(fn.blocks.length, 1);
  assert.equal(fn.blocks[0]!.label, 'entry');
});

test('parses function parameters, including an unnamed one', () => {
  const mod = parseModule(`define i32 @f(i32 noundef %n, i32 %1) {\nret i32 0\n}\n`);
  const fn = mod.functions[0]!;
  assert.deepEqual(
    fn.params.map((p) => p.name),
    ['n', '1']
  );
});

test('debug intrinsics (#dbg_declare) are ignored, not parsed as instructions', () => {
  const fn = oneFunction(`
  %1 = alloca i32, align 4
    #dbg_declare(ptr %1, !15, !DIExpression(), !16)
  ret i32 0
`);
  assert.equal(fn.blocks[0]!.instrs.length, 2);
});

test('metadata attachments (!dbg, !llvm.loop) are stripped without affecting operand parsing', () => {
  const fn = oneFunction(`
  %1 = add nsw i32 1, 2, !dbg !16
  br label %2, !dbg !17, !llvm.loop !6
2:
  ret i32 %1
`);
  const add = fn.blocks[0]!.instrs[0]!;
  assert.equal(add.kind, 'binop');
});
