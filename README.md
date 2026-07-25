# AIViz

**A visualization platform and protocol for interactive static-analysis traces, demonstrated with abstract interpretation.**

Every static analyzer is a batch tool: you run it, you get final invariants, and the fixpoint
computation itself — the joins, the widening, the narrowing, the iteration until stabilization —
is invisible. AIViz makes that process visible, replayable and teachable.

You open a C file, pick a function, and step through the analysis like a debugger: forward,
backward, or straight to the next widening. At every step you see the CFG, the abstract state,
which variables changed, a plain-language explanation of *why*, and — at widening steps —
exactly what precision was thrown away.

The contribution is the **trace protocol**, not the analyzer. The VS Code extension is a client;
analysis providers are separate processes that speak a versioned JSON contract. Abstract
interpretation is the flagship demonstration, not the limit.

## Architecture

The design is LSP-shaped: **client / server / versioned protocol**.

```
  C source
     │  provider (separate process, JSON-RPC over stdio)
     ▼
  tree-sitter ──> CFG ──> instrumented worklist fixpoint
     │
     ▼
  AnalysisTrace (versioned JSON)
     │
     ▼
  VS Code client — renders and replays, never computes
```

| Package | What it is |
| --- | --- |
| `packages/trace-protocol` | The contract: trace + provider types, and a conformance validator (`aiviz-validate`) |
| `packages/analysis-core` | Abstract domains and the instrumented fixpoint engine |
| `packages/provider-c-source` | v1 reference provider: source-level C via tree-sitter |
| `extension` | The VS Code client |

The engine and domains live **provider-side**. The client is analysis-free, which is what lets a
provider be written in any language.

## Why the fixpoint engine is ours

Verified while designing this: IKOS, Crab, Mopsa and Frama-C/Eva all let you *tune* widening
(`--widening-delay`, `--widening-period`) but none expose an API to *observe* iteration by
iteration. So the instrumented worklist that emits a `Step` per state transition had to be
written regardless of which library supplies the lattice math.

The trace is materialised in full before stepping begins. That makes `prev` a pure index
decrement — no state to unwind — and means the iteration count is known before you take a single
step. The engine is deterministic (reverse post-order worklist), so traces are reproducible and
golden-trace tests are meaningful.

## v1 scope

**Supported:** `int`/`bool` locals, `+ - * / %`, `if`/`else`, `while`, `for`, `do-while`,
`break`, `continue`, `return`, nested loops.

**Rejected**, each with an exact line and reason: pointers, arrays, structs, floats, `goto`,
function calls, recursion, `malloc`/`free`, and unparseable source.

The precheck is an **allow-list**, not a deny-list — tree-sitter parses C we have no semantics
for, and silently analysing something unmodelled would produce confidently wrong invariants.

**Domains:** Intervals, Sign, Constant Propagation. Congruence/Parity are v2; Octagons/Zones/
Polyhedra are v3, and are the natural point to add an external provider wrapping Apron or ELINA.

## Try it

```bash
npm install
npm run build
npm test
```

Run the analysis on an example without opening VS Code:

```bash
node scripts/gen-fixture.mjs examples/sum.c sum intervals
```

Develop the panel UI standalone in a browser:

```bash
cd extension && npm run build && node dev/make-preview.js
# open extension/dist/preview.html
```

In VS Code: press `F5` to launch the Extension Development Host, open a file from `examples/`,
and run **AIViz: Analyze Current Function**.

## One source line is often several program points

`for (int i = 0; i < 10; i = i + 1)` is three distinct program points: the initialiser, the
condition, and the latch carrying the update. So `line -> block` is deliberately one-to-many, and
clicking a line highlights the whole set with the best match emphasised.

This is treated as a teaching feature rather than an inconvenience — it is one of the first
things that has to click for the CFG to make sense. In `examples/sum.c`, line 5 maps to three
blocks.

## What the tool shows that a lecture slide cannot

On `examples/count.c` (`while (i < 10) i = i + 1;`), interval analysis converges in 4 iterations:

- **Widening** takes `i` from `[0, 0]` to `[0, +∞)` and reports the cost: plain join would have
  kept `[0, 1]`. The discarded bound is struck through in the panel.
- **Narrowing** then recovers `i ↦ [10, 10]` exactly at the exit. Turn narrowing off in settings
  and the same program ends at `[10, +∞)` — the delta *is* the lesson.
- **Sign** converges in fewer iterations than Intervals (finite lattice, no infinite ascending
  chains) and **Constant Propagation** collapses straight to `⊤` when the loop merges `0` and `1`.

There are also limits worth showing. In `examples/sum.c`, intervals cannot bound `total`, because
the domain is non-relational and the loop guard mentions only `i`. That imprecision is not a bug
to hide — it is the motivation for relational domains.

## Writing a provider

A provider is any process implementing four methods over newline-delimited JSON-RPC 2.0:

```
aiviz/initialize     -> ProviderInfo
aiviz/listFunctions  -> { functions }
aiviz/precheck       -> { supported, diagnostics }
aiviz/analyze        -> AnalysisTrace
```

Validate your output against the schema before wiring it up:

```bash
npx aiviz-validate my-trace.json
```

The client validates every trace it receives, so a provider that drifts from the schema produces
a clear error rather than a broken panel.

## Status

Working: the protocol and its validator, the three v1 domains, the fixpoint engine, the
tree-sitter C provider, and the VS Code client with CFG, stepping, state diffing, narration and
widening-loss reporting.

Not yet built: the lattice view, side-by-side domain comparison, the provider SDK and contributor
docs, and the second (LLVM IR) provider that validates the protocol across two different IRs.

## License

MIT.
