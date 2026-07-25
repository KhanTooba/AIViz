/**
 * Dominator analysis, used only to find loop headers — the blocks where
 * widening must be applied for the fixpoint to terminate.
 */

import { blockMap, type Cfg } from './ir.js';

/**
 * Reverse post-order.
 *
 * Also the worklist priority order: processing blocks in RPO means a block is
 * usually visited after its predecessors, which both converges faster and makes
 * the emitted trace deterministic and therefore testable.
 */
export function reversePostOrder(cfg: Cfg): string[] {
  const blocks = blockMap(cfg);
  const seen = new Set<string>();
  const post: string[] = [];

  // Iterative DFS, so deeply nested loops cannot blow the JS stack.
  const stack: { id: string; next: number }[] = [{ id: cfg.entry, next: 0 }];
  seen.add(cfg.entry);

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const block = blocks.get(frame.id);
    const succs = block?.succs ?? [];
    if (frame.next < succs.length) {
      const target = succs[frame.next]!.target;
      frame.next++;
      if (!seen.has(target) && blocks.has(target)) {
        seen.add(target);
        stack.push({ id: target, next: 0 });
      }
    } else {
      post.push(frame.id);
      stack.pop();
    }
  }
  return post.reverse();
}

/**
 * Immediate dominators via the Cooper–Harvey–Kennedy iterative algorithm.
 * Returns a map from block to its immediate dominator (the entry maps to itself).
 */
export function immediateDominators(cfg: Cfg): Map<string, string> {
  const rpo = reversePostOrder(cfg);
  const order = new Map(rpo.map((id, i) => [id, i]));
  const blocks = blockMap(cfg);
  const idom = new Map<string, string>();
  idom.set(cfg.entry, cfg.entry);

  const intersect = (a: string, b: string): string => {
    let x = a;
    let y = b;
    while (x !== y) {
      // Walk the deeper (higher RPO number) one upward until they meet.
      while ((order.get(x) ?? 0) > (order.get(y) ?? 0)) x = idom.get(x)!;
      while ((order.get(y) ?? 0) > (order.get(x) ?? 0)) y = idom.get(y)!;
    }
    return x;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const id of rpo) {
      if (id === cfg.entry) continue;
      const preds = (blocks.get(id)?.preds ?? []).filter((p) => idom.has(p));
      if (preds.length === 0) continue;

      let newIdom = preds[0]!;
      for (const p of preds.slice(1)) newIdom = intersect(p, newIdom);
      if (idom.get(id) !== newIdom) {
        idom.set(id, newIdom);
        changed = true;
      }
    }
  }
  return idom;
}

export function dominates(idom: Map<string, string>, a: string, b: string): boolean {
  let cur = b;
  while (true) {
    if (cur === a) return true;
    const next = idom.get(cur);
    if (next === undefined || next === cur) return false;
    cur = next;
  }
}

/**
 * Loop headers: the targets of back edges.
 *
 * An edge u -> v is a back edge exactly when v dominates u, which is the
 * standard definition of a natural loop and is what tells the engine where
 * widening is required.
 */
export function findLoopHeaders(cfg: Cfg): Set<string> {
  const idom = immediateDominators(cfg);
  const headers = new Set<string>();
  for (const b of cfg.blocks) {
    for (const e of b.succs) {
      if (dominates(idom, e.target, b.id)) headers.add(e.target);
    }
  }
  return headers;
}
