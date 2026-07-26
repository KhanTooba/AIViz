import type { Step } from './trace.js';

/**
 * True if a step reflects the block's *own* abstract state evolving, as
 * opposed to something happening on the way to a successor.
 *
 * `join`, `widen`, `narrow` and `stabilize` always describe the block's own
 * incoming state. `transfer` is ambiguous by construction: the engine emits
 * it both for a transfer through one of the block's own instructions (which
 * carries a `sourceSpan`) and for applying an outgoing edge's guard for one
 * specific successor (which does not). The latter is a property of that
 * edge — e.g. the loop-exit branch's narrowing — not of the block, and
 * treating it as part of the block's own timeline would interleave two
 * unrelated branch outcomes as if they were sequential updates to the same
 * value. `push` is always about a successor's incoming edge, never this
 * block's own state.
 *
 * Any client building a per-block timeline (a lattice ascending-chain view,
 * a compare-mode alignment) needs this distinction, so it lives in the
 * protocol package rather than being reimplemented per consumer.
 */
export function isBlockOwnState(step: Step): boolean {
  if (step.kind === 'push') return false;
  if (step.kind === 'transfer') return step.sourceSpan !== undefined;
  return true; // join | widen | narrow | stabilize
}
