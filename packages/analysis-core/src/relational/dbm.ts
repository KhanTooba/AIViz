/**
 * A Difference Bound Matrix: `m[i][j]` is the tightest known upper bound on
 * `x_i − x_j`. Index `0` is reserved for the constant zero, which unifies
 * single-variable bounds (`x ≤ c` is `x − 0 ≤ c`) and two-variable bounds
 * into one matrix — the standard technique, not a simplification invented
 * for this project. `+Infinity` means "no known bound".
 *
 * Zones use this directly over `n + 1` dimensions (one per variable, plus
 * the zero node). Octagons reuse every operation here unchanged, over
 * `2n + 1` dimensions (two nodes per variable, for `+x` and `−x`) — see
 * `octagons.ts` for the extra *strong closure* pass that domain needs on
 * top of this.
 *
 * Every function here is pure: it returns a new matrix rather than mutating
 * its argument, matching the immutable style the rest of this package uses
 * (`Congruence`, `Env<V>`, ...).
 */

export type Matrix = number[][];

export function emptyMatrix(n: number): Matrix {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : Infinity))
  );
}

export function cloneMatrix(m: Matrix): Matrix {
  return m.map((row) => [...row]);
}

/**
 * Floyd–Warshall shortest-path closure. This is what makes the matrix
 * canonical — required for `leq` to be a simple cellwise comparison, for
 * `join`/`meet` to be correct, and for detecting inconsistency (`⊥`).
 */
export function closure(m: Matrix): Matrix {
  const n = m.length;
  const out = cloneMatrix(m);
  for (let k = 0; k < n; k++) {
    for (let i = 0; i < n; i++) {
      const ik = out[i]![k]!;
      if (ik === Infinity) continue;
      for (let j = 0; j < n; j++) {
        const kj = out[k]![j]!;
        if (kj === Infinity) continue;
        const through = ik + kj;
        if (through < out[i]![j]!) out[i]![j] = through;
      }
    }
  }
  return out;
}

/** A negative value on the diagonal after closure means the constraint
 * system has a negative cycle — it is unsatisfiable. */
export function isConsistent(closed: Matrix): boolean {
  for (let i = 0; i < closed.length; i++) {
    if (closed[i]![i]! < 0) return false;
  }
  return true;
}

/** Assumes both matrices are already closed. */
export function leqMatrix(a: Matrix, b: Matrix): boolean {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a.length; j++) {
      if (a[i]![j]! > b[i]![j]!) return false;
    }
  }
  return true;
}

/** Least upper bound: the loosest bound either side allows. Re-closes
 * defensively even though the join of two closed DBMs is already closed in
 * theory — the cost is negligible at these sizes and it removes any doubt. */
export function joinMatrix(a: Matrix, b: Matrix): Matrix {
  const n = a.length;
  const out = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => Math.max(a[i]![j]!, b[i]![j]!))
  );
  return closure(out);
}

/** Greatest lower bound. Tightening can create a negative cycle — callers
 * must check `isConsistent` on the result. */
export function meetMatrix(a: Matrix, b: Matrix): Matrix {
  const n = a.length;
  const out = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => Math.min(a[i]![j]!, b[i]![j]!))
  );
  return closure(out);
}

/**
 * Widening: the exact matrix analogue of interval widening, applied per
 * cell instead of per single bound. If the new (closed) bound at a cell is
 * looser than the old one, jump straight to `+Infinity`; otherwise keep the
 * old bound. Finitely many cells, each only ever grows once before going to
 * `+Infinity`, so this terminates for the same reason interval widening does.
 *
 * Re-closes afterward — required, not optional. Widening one cell to
 * `+Infinity` can leave the matrix non-canonical: a *different*, still-finite
 * path may exist that would have tightened that same cell (e.g. `total`'s
 * own direct bound widens away, but `total − i ≤ c` and `i`'s own bound both
 * stayed finite, and closure is what propagates that surviving path back
 * onto `total`'s direct cell). Closure only ever tightens, so re-closing
 * cannot undermine the termination guarantee widening provides.
 */
export function widenMatrix(oldM: Matrix, newM: Matrix): Matrix {
  const n = oldM.length;
  const out = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (newM[i]![j]! > oldM[i]![j]! ? Infinity : oldM[i]![j]!))
  );
  return closure(out);
}

/** Narrowing: adopt the new bound wherever widening had thrown the old one
 * away to `+Infinity`; otherwise keep the current bound. Re-closed for the
 * same reason as `widenMatrix`. */
export function narrowMatrix(oldM: Matrix, newM: Matrix): Matrix {
  const n = oldM.length;
  const out = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (oldM[i]![j]! === Infinity ? newM[i]![j]! : oldM[i]![j]!))
  );
  return closure(out);
}

export function equalMatrix(a: Matrix, b: Matrix): boolean {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a.length; j++) {
      if (a[i]![j]! !== b[i]![j]!) return false;
    }
  }
  return true;
}

/** Tightens a single cell to at most `c` (a meet-like update for one
 * constraint), then re-closes so the tightening propagates. */
export function tighten(m: Matrix, i: number, j: number, c: number): Matrix {
  if (c >= m[i]![j]!) return m; // already at least this tight
  const out = cloneMatrix(m);
  out[i]![j] = c;
  return closure(out);
}

/** Forgets everything known about one variable (the DBM equivalent of
 * `havoc`): its row and column go back to "no known bound", except the
 * diagonal. Every other variable's relations are untouched. */
export function forgetVar(m: Matrix, idx: number): Matrix {
  const n = m.length;
  const out = cloneMatrix(m);
  for (let k = 0; k < n; k++) {
    if (k === idx) continue;
    out[idx]![k] = Infinity;
    out[k]![idx] = Infinity;
  }
  out[idx]![idx] = 0;
  return out;
}
