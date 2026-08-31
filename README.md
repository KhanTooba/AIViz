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
  C source ──> tree-sitter provider ──┐
                                      ├──> CFG ──> instrumented worklist fixpoint
  LLVM IR ──> textual IR provider ───┘
                  │ separate processes, JSON-RPC over stdio
                  ▼
  AnalysisTrace (versioned JSON)
     │
     ▼
  VS Code client — renders and replays, never computes
```

| Package | What it is |
| --- | --- |
| `packages/trace-protocol` | The contract: trace + provider types, and a schema validator (`aiviz-validate`) |
| `packages/analysis-core` | Abstract domains and the instrumented fixpoint engine |
| `packages/provider-sdk` | Helpers for *writing* a provider: stdio transport, manifest loading, conformance kit (`aiviz-conformance`) |
| `packages/provider-c-source` | v1 reference provider: source-level C via tree-sitter, built on `provider-sdk` |
| `packages/provider-llvm-ir` | Textual LLVM IR provider, including SSA `phi` lowering |
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

**Domains:** Intervals, Sign, Constant Propagation, Parity, Congruence (`aℤ+b`) — all
non-relational, tracking each variable independently — plus four hand-rolled **relational**
domains that track relationships *between* variables: Zones (`x - y ≤ c`), Octagons
(`±x ± y ≤ c`), Zonotopes (affine forms over shared noise symbols), and Polyhedra (arbitrary
linear inequalities, via Fourier–Motzkin elimination, scoped to a handful of variables).

Parity and Congruence are worth contrasting with Intervals specifically for their widening.
Parity has finite height, same as Sign, so widening is plain join. Congruence is infinite but
uses a much blunter strategy than Intervals: rather than searching for a coarser common
modulus, it discards all periodicity the moment a loop's value changes and jumps straight to
`⊤`. Whether narrowing then recovers anything depends on the program: multiplying by a constant
even number re-derives "even" from the arithmetic alone (recovers), but a loop guard like
`i < 20` carries no periodicity information for this domain the way it does for Intervals
(does not recover). Both are real, correct, and demonstrable in the compare view.

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

In VS Code: press `F5` to launch the Extension Development Host, open a `.c` or `.ll` file from
`examples/`, and run **AIViz: Analyze Current Function**. The extension selects its bundled C
or LLVM IR provider from the document language/file extension; both render in the same panel.

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
to hide — it is the motivation for relational domains. It also does not fully resolve on
`sum.c` specifically: `total` ends up `i(i-1)/2`, a *quadratic* relationship, and Zones/Octagons/
Polyhedra only express *linear* constraints — there is no fixed `c` making `total - i ≤ c` true
across the loop, so widening discards it there too. That is a real, honest boundary of what
these domains can express, not a shortcoming of the implementation.

`examples/lockstep.c` is the flagship relational example instead: two counters incrementing in
lockstep under an *unbounded* loop (`j = i + 1` at entry, then both `i` and `j` incremented by 1
each iteration). Neither counter is individually bounded — `n`, the loop's trip count, is an
untracked parameter — but `j - i = 1` never changes, and Zones, Octagons, and Polyhedra all keep
that relation exactly through widening, something Intervals cannot express at all since it never
looks at more than one variable at a time. Zonotopes discovers the same relation at the join but
loses it once widening runs (see `domains/zonotopes.ts`'s doc comment) — a real, deliberate
tradeoff for guaranteed termination, worth seeing in the compare view alongside the others.

## Writing a provider

A provider is any process implementing four methods over newline-delimited JSON-RPC 2.0:

```
aiviz/initialize     -> ProviderInfo
aiviz/listFunctions  -> { functions }
aiviz/precheck       -> { supported, diagnostics }
aiviz/analyze        -> AnalysisTrace
```

In TypeScript, `@aiviz/provider-sdk` reduces that to implementing the four methods and calling
`serveOverStdio(new MyProvider())` — see [`provider-c-source/src/main.ts`](packages/provider-c-source/src/main.ts),
which is exactly that. Any other language just needs to read/write that JSON-RPC framing
directly; see [`docs/ADDING-A-PROVIDER.md`](docs/ADDING-A-PROVIDER.md).

Check a provider before wiring it up — against the schema, and against the real transport:

```bash
npx aiviz-validate my-trace.json                                         # a trace file
npx aiviz-conformance --fixture fixture.json -- node dist/main.js        # a live process
```

`aiviz-conformance` spawns your provider and runs it through `initialize`/`listFunctions`/
`precheck`/`analyze` over the real stdio transport — the same checks the client implicitly
depends on. The client also validates every trace it receives at runtime, so a provider that
drifts from the schema produces a clear error rather than a broken panel.

Full protocol reference: [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Adding a domain in a trusted workspace

The installed extension can also extend its built-in non-relational engine with a workspace-local
value lattice. Put a `domain.json` and `domain.mjs` under
`.aiviz/domains/<domain-id>/`, trust the workspace, then run **AIViz: Reload Domains**. The
selected provider loads and validates the module in its own subprocess; the VS Code extension
host never imports it. Invalid modules appear in **AIViz: Show Domain Diagnostics** and do not
disable built-in domains. See [`docs/ADDING-A-DOMAIN.md`](docs/ADDING-A-DOMAIN.md) for the exact
manifest and interface.

Use **AIViz: Create Custom Domain** for an in-editor scaffold, or use the `aiviz-domain create`
and `aiviz-domain check` CLI for terminal-based authoring. A separately packaged, copyable
example lives in [`examples/zero-nonzero-domain`](examples/zero-nonzero-domain).

## A second frontend: LLVM IR

[`packages/provider-llvm-ir`](packages/provider-llvm-ir) is a second, complete provider —
concrete proof that the trace protocol and `@aiviz/analysis-core`'s engine/domains are
genuinely IR-agnostic, not just written to look that way while secretly assuming
tree-sitter/C. It analyzes LLVM textual IR (`.ll`) directly, via a small hand-rolled parser (no
tree-sitter, no native LLVM bindings — LLVM's textual IR is simple and regular enough that a
line-oriented parser is more tractable than wiring up a grammar).

It takes `.ll` files, not `.c` files: generate one yourself, then analyze it —

```bash
clang -S -emit-llvm -O0 -Xclang -disable-O0-optnone foo.c -o foo.ll
npx aiviz-conformance --manifest packages/provider-llvm-ir/provider.json --fixture fixture.json
```

Same architecture, same trick as the C provider: lower to the exact same tiny `Cfg`/`Expr`/
`Cond` shape, then hand the CFG to the unmodified engine. LLVM IR's one real novelty — SSA
`phi` nodes at control-flow merges — turns out to need no engine changes at all: the engine
already reconciles per-predecessor-edge state generically via `domain.join()`, so a phi
becomes an ordinary assignment placed on each incoming edge rather than anything inside the
merge block itself (see the package's `cfgbuilder.ts` for the detail, including how a
predecessor with more than one phi-bearing successor — a "critical edge" — is handled by
always splitting onto a small intermediate block, rather than special-casing it).

Scoped to `i32`/`i1` scalars: `alloca`/`load`/`store` locals (what plain `clang -O0` output
actually uses — no phi nodes at all, confirmed directly), `phi` nodes (for hand-written or
optimized SSA-form IR), signed arithmetic and comparisons, and structured branches. No calls,
pointer arithmetic beyond a bare local, floats, bitwise/shift ops, or unsigned arithmetic — see
`provider-llvm-ir/src/precheck.ts` for the exact allow-list.

The VS Code extension bundles this provider alongside the C provider and selects it automatically
for `.ll` documents. The two processes remain independent, but both return the same trace format
to the same domain-agnostic panel. The extension's bundle-level test launches both packaged
executables over the real stdio transport and analyzes one fixture in each language.

## Status

Working: the protocol, its validator, and the conformance kit; nine domains (five non-relational,
four relational); the fixpoint engine; two complete providers — tree-sitter C and LLVM IR,
validating the protocol/engine across two different IRs; and the VS Code client — CFG,
stepping, state diffing, narration, widening-loss reporting, the lattice view (Hasse diagram for
finite lattices, ascending chain otherwise), side-by-side domain comparison, and a relations
section for the four relational domains' cross-variable facts.

Not yet built: the final self-contained Marketplace/VSIX release workflow. Arbitrary external
analysis-provider registration is also outside the current extension UI; v0.2.0 bundles the C
and LLVM IR providers explicitly.

## License

MIT.
