# Changelog

## 0.1.0

Initial release.

- Nine abstract domains: Intervals, Sign, Constant Propagation, Parity, and Congruence
  (non-relational); Zones, Octagons, Zonotopes, and Polyhedra (relational, tracking
  cross-variable facts a per-variable domain cannot express).
- Instrumented worklist fixpoint engine: every join, widen, narrow, and transfer is a distinct,
  narrated step you can walk forward and backward through.
- CFG panel with click-a-line-highlight-a-block navigation, including one-to-many line-to-block
  mapping (a `for` loop's initializer/condition/update are three separate program points on one
  source line).
- Widening-loss reporting: every widening step shows what a plain join would have kept next to
  what widening actually kept.
- Narrowing, toggleable, so the precision difference it makes is directly observable.
- A **Relations** section for the four relational domains, showing cross-variable constraints
  (e.g. `j - i ≤ 1`) alongside the usual per-variable state table.
- Side-by-side domain comparison on the same function.
- A lattice view: Hasse diagrams for finite-lattice domains, the actual ascending chain
  traversed for infinite ones.
- One reference analysis provider (source-level C via tree-sitter), plus a second, standalone
  provider analyzing LLVM IR directly — proof the trace protocol and engine are genuinely
  provider-agnostic (not yet wired into this panel; see the project's own docs).
