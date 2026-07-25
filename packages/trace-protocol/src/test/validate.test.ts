import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateTrace, type ValidationResult } from '../validate.js';
import type { AnalysisTrace } from '../trace.js';

const FIXTURE = fileURLToPath(
  new URL('../../fixtures/count-intervals.trace.json', import.meta.url)
);

function loadFixture(): AnalysisTrace {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as AnalysisTrace;
}

/** Deep clone so each mutation test starts from a known-good trace. */
function mutate(fn: (t: AnalysisTrace) => void): ValidationResult {
  const t = loadFixture();
  fn(t);
  return validateTrace(t);
}

function assertRejects(result: ValidationResult, pathFragment: string): void {
  assert.equal(result.valid, false, 'expected the trace to be rejected');
  const matched = result.issues.some((i) => i.path.includes(pathFragment));
  assert.ok(
    matched,
    `expected an issue mentioning "${pathFragment}", got: ${result.issues
      .map((i) => `${i.path}: ${i.message}`)
      .join(' | ')}`
  );
}

test('the reference fixture is valid', () => {
  const result = validateTrace(loadFixture());
  assert.deepEqual(result.issues, []);
  assert.equal(result.valid, true);
});

test('rejects a non-object', () => {
  assert.equal(validateTrace(null).valid, false);
  assert.equal(validateTrace('trace').valid, false);
  assert.equal(validateTrace([]).valid, false);
});

test('rejects a protocol version this build does not speak', () => {
  assertRejects(
    mutate((t) => {
      t.version = '9.0.0';
    }),
    'version'
  );
});

test('rejects a successor edge pointing at a block that does not exist', () => {
  assertRejects(
    mutate((t) => {
      t.cfg.blocks[0]!.succs = ['does-not-exist'];
    }),
    'succs'
  );
});

test('rejects an edge that is not mirrored in the target preds', () => {
  assertRejects(
    mutate((t) => {
      // b1 keeps b0 as a successor, but b0 forgets b1 as a predecessor.
      const b1 = t.cfg.blocks.find((b) => b.blockId === 'b1')!;
      b1.preds = b1.preds.filter((p) => p !== 'b0');
    }),
    'succs'
  );
});

test('rejects an entry block that is not in the block list', () => {
  assertRejects(
    mutate((t) => {
      t.cfg.entry = 'nope';
    }),
    'cfg.entry'
  );
});

test('rejects duplicate block ids', () => {
  assertRejects(
    mutate((t) => {
      t.cfg.blocks[1]!.blockId = 'b0';
    }),
    'blockId'
  );
});

test('rejects a line range whose start is after its end', () => {
  assertRejects(
    mutate((t) => {
      t.cfg.blocks[0]!.lines = [{ start: 9, end: 2 }];
    }),
    'lines'
  );
});

test('rejects steps whose index does not match their position', () => {
  assertRejects(
    mutate((t) => {
      t.steps[3]!.index = 99;
    }),
    'steps[3].index'
  );
});

test('rejects a step referencing an unknown block', () => {
  assertRejects(
    mutate((t) => {
      t.steps[1]!.blockId = 'ghost';
    }),
    'steps[1].blockId'
  );
});

test('rejects a join step with fewer than two operands', () => {
  assertRejects(
    mutate((t) => {
      const join = t.steps.find((s) => s.kind === 'join')!;
      join.inputs = [join.inputs![0]!];
    }),
    'inputs'
  );
});

test('rejects loss reported on a step that is not a widening', () => {
  assertRejects(
    mutate((t) => {
      const transfer = t.steps.find((s) => s.kind === 'transfer')!;
      transfer.loss = [
        {
          name: 'i',
          before: '[0, 0]',
          joined: '[0, 1]',
          widened: '[0, +∞)',
          lostBound: 'upper',
          message: 'nonsense on a transfer',
        },
      ];
    }),
    'loss'
  );
});

test('rejects a bottom state that still carries variables', () => {
  assertRejects(
    mutate((t) => {
      t.steps[0]!.before = {
        kind: 'bottom',
        vars: [{ name: 'i', repr: '[0, 0]', kind: 'value' }],
      };
    }),
    'before.vars'
  );
});

test('rejects a step with no explanation', () => {
  assertRejects(
    mutate((t) => {
      t.steps[2]!.explanation = '';
    }),
    'explanation'
  );
});

test('rejects a summary stepCount that disagrees with the steps array', () => {
  assertRejects(
    mutate((t) => {
      t.summary.stepCount = 3;
    }),
    'summary.stepCount'
  );
});

test('rejects widening indices that disagree with the actual widen steps', () => {
  // This is the one that would silently break "step over widening" in the UI.
  assertRejects(
    mutate((t) => {
      t.summary.wideningStepIndices = [1, 2];
    }),
    'summary.wideningStepIndices'
  );
});

test('rejects converged:false without a reason', () => {
  assertRejects(
    mutate((t) => {
      t.summary.converged = false;
    }),
    'notConvergedReason'
  );
});

test('accepts converged:false when a reason is given', () => {
  const result = mutate((t) => {
    t.summary.converged = false;
    t.summary.notConvergedReason = 'did not converge within 200 iterations';
  });
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

test('accepts a trace with no latticeGraph — infinite lattices publish none', () => {
  const result = validateTrace(loadFixture());
  assert.equal(result.valid, true);
});

test('accepts a well-formed latticeGraph', () => {
  const result = mutate((t) => {
    t.domain.latticeGraph = {
      nodes: [
        { id: 'bot', label: '⊥' },
        { id: 'top', label: '⊤' },
      ],
      edges: [['bot', 'top']],
    };
  });
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});

test('rejects a latticeGraph edge referencing an unknown node', () => {
  assertRejects(
    mutate((t) => {
      t.domain.latticeGraph = {
        nodes: [{ id: 'bot', label: '⊥' }],
        edges: [['bot', 'ghost']],
      };
    }),
    'latticeGraph.edges'
  );
});

test('rejects duplicate node ids in a latticeGraph', () => {
  assertRejects(
    mutate((t) => {
      t.domain.latticeGraph = {
        nodes: [
          { id: 'x', label: '-' },
          { id: 'x', label: '+' },
        ],
        edges: [],
      };
    }),
    'latticeGraph.nodes'
  );
});

test('rejects a line map pointing at an unknown block', () => {
  assertRejects(
    mutate((t) => {
      t.lineMap.lineToBlocks['2'] = ['b0', 'phantom'];
    }),
    'lineToBlocks'
  );
});

test('rejects a best-match block that is not among that line’s blocks', () => {
  assertRejects(
    mutate((t) => {
      t.lineMap.bestBlockForLine!['2'] = 'b3';
    }),
    'bestBlockForLine'
  );
});

test('rejects stabilizedAtStep outside the steps array', () => {
  assertRejects(
    mutate((t) => {
      t.summary.stabilizedAtStep = 999;
    }),
    'stabilizedAtStep'
  );
});

test('a one-to-many line mapping is accepted, since one line is often several program points', () => {
  const result = mutate((t) => {
    // Exactly the `for (i = 0; i < n; i++)` case: init, condition and latch.
    t.lineMap.lineToBlocks['3'] = ['b1', 'b2'];
    t.lineMap.bestBlockForLine!['3'] = 'b1';
  });
  assert.equal(result.valid, true, JSON.stringify(result.issues));
});
