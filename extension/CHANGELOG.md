# Changelog

## Unreleased — target 0.2.0

- Bundle both the source-level C and textual LLVM IR providers in the extension.
- Select the provider automatically from the document language or `.c`/`.ll` extension.
- Analyze, replay, and compare LLVM IR functions through the same UI used for C.
- Smoke-test both packaged provider executables over the real stdio transport.
- Load compatible workspace value domains from `.aiviz/domains/` only after Workspace Trust,
  with manifest/API/lattice validation, diagnostics, file-change prompts, and **Reload Domains**.
- Add **Create Custom Domain**, the `aiviz-domain` create/check CLI, and a separately packaged
  Zero / Nonzero example domain that is exercised through the bundled provider.

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
- One reference analysis provider (source-level C via tree-sitter), plus a second standalone
  provider analyzing LLVM IR directly.
