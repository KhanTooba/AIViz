# The AIViz Trace Protocol

This is the contract between an **analysis provider** (a process that runs an analysis) and
the **VS Code client** (which renders and replays the result). The architecture is
[LSP](https://microsoft.github.io/language-server-protocol/)-shaped: client, server, versioned
protocol. Abstract interpretation over C is the reference implementation of both sides: the
protocol itself is not specific to either.

The client never computes analysis. It renders a trace and lets the user step through it. A
provider that gets this contract right can be written in any language, for any analysis, for
any target language.

Package: [`@aiviz/trace-protocol`](../packages/trace-protocol). Canonical types:
[`src/trace.ts`](../packages/trace-protocol/src/trace.ts),
[`src/provider.ts`](../packages/trace-protocol/src/provider.ts).

## Versioning

`PROTOCOL_VERSION` (currently `0.1.0`) is exported from the package and stamped on every trace
as `AnalysisTrace.version`. The protocol is pre-1.0: **exact** version matches are required (see
`validateTrace`), not just a matching major. Once the protocol stabilizes at `1.0.0`, this will
relax to semver-compatible matching.

## Transport

A provider is a separate OS process. The client and provider exchange
[JSON-RPC 2.0](https://www.jsonrpc.org/specification) messages over the process's stdin/stdout,
one JSON object per line (newline-delimited, no `Content-Length` framing: deliberately simpler
than LSP's transport, since traces are the payload, not a stream of fine-grained edits).

Running out-of-process is not incidental: a crash or an infinite loop inside an analysis must
not be able to take the editor down with it.

### Methods

| Method | Request | Response |
| --- | --- | --- |
| `aiviz/initialize` | `{}` | `ProviderInfo` |
| `aiviz/listFunctions` | `{ file, source }` | `{ functions: FunctionInfo[] }` |
| `aiviz/precheck` | `{ file, source, function }` | `{ supported, diagnostics }` |
| `aiviz/analyze` | `{ file, source, function, domain, config? }` | `AnalysisTrace` |

Method name constants live in `RPC_METHODS`, so a client and provider can never drift apart on
spelling. See [`AnalysisProvider`](../packages/trace-protocol/src/provider.ts) for exact types.

**A provider that raises an error must still reply**: a JSON-RPC error object, not a dropped
connection: so the client can show what went wrong instead of hanging. See
[`@aiviz/provider-sdk`](../packages/provider-sdk)'s `serveOverStdio`, which handles this
automatically if you use it.

## `ProviderInfo`

Returned by `initialize()`. Advertises what the provider can do:

```ts
{
  id: 'c-source', name: 'C (source-level, tree-sitter)', version: '0.1.0',
  protocolVersion: '0.1.0',
  languages: ['c'],
  domains: [
    { id: 'intervals', name: 'Intervals' },
    { id: 'sign', name: 'Sign', finiteLattice: true },
    { id: 'constprop', name: 'Constant Propagation' },
    { id: 'parity', name: 'Parity', finiteLattice: true },
    { id: 'congruence', name: 'Congruence' },
    { id: 'zones', name: 'Zones' },
    { id: 'octagons', name: 'Octagons' },
    { id: 'zonotopes', name: 'Zonotopes' },
    { id: 'polyhedra', name: 'Polyhedra' },
  ],
  capabilities: { narrowing: true, wideningLoss: true, latticeGraph: true },
  supportedSubset: 'Integer scalars only: int/bool locals, + - * / %, if/else, while, for, ...',
}
```

`domains` is what populates the domain picker in the client. `supportedSubset` is shown to
users so "why was my program rejected" has a starting answer before they even try it.

## `AnalysisTrace`

The full return value of `analyze()`. One JSON object, fully materialized: not a stream of
partial updates. That is a deliberate design choice: it is what makes `prev` a pure index
decrement (no state to unwind) and lets the client report the total iteration count *before*
the user takes a single step.

```ts
{
  version, provider, program, domain,   // identity
  cfg, lineMap,                          // the control-flow graph and its source mapping
  variables,                             // declared variables, in source order
  steps,                                 // the full, ordered fixpoint trace
  summary,                               // converged?, iteration/step counts, widening points
  diagnostics,                           // why a program was rejected, if it was
}
```

### `cfg` and `lineMap`

`cfg.blocks[]` carries `preds`/`succs` edges, a `lines: LineRange[]` (a **set** of ranges, not
one), and flags (`isEntry`, `isExit`, `isLoopHeader`).

**One source line can map to several blocks.** `for (i = 0; i < n; i++)` is three distinct
program points: the initializer, the condition, and the latch carrying the update: and the
latch's line sits back up on the `for` line textually. `lineMap.lineToBlocks` is deliberately
one-to-many for exactly this reason; `bestBlockForLine` picks the tightest-covering block as the
default emphasis, but the client is expected to show the whole set. Treat this as a feature, not
noise to collapse: it is one of the first things that has to click for a CFG to make sense at
all.

### `steps`

Each `Step` has a `kind`: `transfer | join | widen | narrow | stabilize | push`.

**The one subtlety that will bite a naive client:** `transfer` is emitted in two different
situations. A transfer through one of a block's *own* instructions carries a `sourceSpan`. A
transfer applying an *outgoing edge's guard* for one specific successor does **not**: it
belongs to that edge, not to the block. Mixing the two when reconstructing "this variable's
value at this block over time" interleaves two unrelated branch outcomes (e.g. a loop's
continue-branch and exit-branch narrowings) as if they were sequential updates to the same
value. Use the exported `isBlockOwnState(step)` predicate rather than re-deriving this rule.
It is exactly the check the client's own lattice and compare views use, and it existed because
this bug shipped once already.

`push` steps are keyed to the *target* block (the state arriving there), which is why they are
excluded from `isBlockOwnState` too.

### Abstract values

A `DisplayState` is `{ kind: 'bottom' | 'state', vars: VarValue[], constraints?: string[] }`. A
`VarValue` is `{ name, repr, kind: 'top' | 'bottom' | 'value' }`: a domain-agnostic,
pre-rendered string like `[0, 10]`, `+`, `⊤`. The client never parses or interprets `repr`; it
only displays it and compares it for equality between steps to detect a change. This is what
lets one client render Intervals, Sign, and any future third-party domain identically.

`constraints`, if present, is a list of pre-rendered strings like `"i - total ≤ 5"`: cross-variable
facts a **relational** domain (Zones, Octagons, Zonotopes, Polyhedra) wants to surface that don't
fit anywhere in `vars`, since each `VarValue` only ever describes one variable in isolation. A
non-relational domain (Intervals, Sign, Constant Propagation, Parity, Congruence) never sets
this field: absent means "nothing to show here", not "no relation exists". Every relational
domain still populates `vars` with each variable's own best derivable projection, so the
existing per-variable UI (state table, ascending-chain view, compare mode) keeps working
unmodified; `constraints` is additive.

#### What each relational domain can express exactly

Every domain's `assign`/`assume` recognizes the widest shape it can represent *exactly* and
falls back soundly (never incorrectly) otherwise: the same exact-vs-fallback discipline this
codebase already uses for e.g. `Sign.div`. Knowing the boundary explains why the same program
produces a precise relation in one domain and a plain `⊤` in another:

| Domain | Constraint shape | Assignment coefficients | Variables per constraint |
| --- | --- | --- | --- |
| Zones | `x - y ≤ c` | ±1 only | 2 |
| Octagons | `±x ± y ≤ c` | ±1 only | 2 |
| Zonotopes | affine form `c0 + Σ ck·εk` over shared noise symbols | arbitrary integer | unbounded |
| Polyhedra | arbitrary linear inequality `a·x ≤ c` | arbitrary integer | unbounded (see `maxVariables` below) |

A guard or assignment outside a domain's exact shape (e.g. a sum `x + y < 10` for Zones, or a
product of two variables for any of them) is a **sound no-op or a havoc**, never a guess: the
state either stays unchanged (a guard that can't be refined) or the target's old relations are
forgotten and rebound from its own interval (an assignment that can't be tracked exactly).

Zonotopes has one more nuance worth knowing: its `widen` collapses any variable whose *concrete
bound* grew back to a plain interval, unconditionally (see `domains/zonotopes.ts`'s doc
comment). A correlation this domain genuinely discovers at a join can therefore be destroyed the
moment widening runs, in a way Zones/Octagons/Polyhedra's matrix- and constraint-based widening
does not lose. This is a deliberate tradeoff for guaranteed termination, not a bug.

#### `maxVariables` and the `domain.tooManyVariables` diagnostic

A domain may declare `maxVariables` (Polyhedra does, since its Fourier–Motzkin-based operations
scale badly past a handful of variables). The provider checks a function's variable count
against this **before** calling `analyze`: a function that exceeds it gets the same
"unsupported" trace shape a precheck failure gets (`steps: []`, `summary.converged: false`, a
`diagnostics` entry with code `domain.tooManyVariables` and a real line number), never a slow or
memory-heavy analysis attempt.

### `HasseDiagram` (finite lattices only)

`domain.latticeGraph`, if present, is `{ nodes: {id, label}[], edges: [lower, upper][] }`: the
covering relation of a **finite** lattice (e.g. Sign: `⊥ < {-, 0, +} < {≤0, ≠0, ≥0} < ⊤`). A
`label` must exactly match the `repr` a `VarValue` of that domain can produce: that string
equality is the entire mechanism the client uses to highlight "where a value currently sits" in
the diagram.

Infinite lattices (Intervals, Constant Propagation) publish no `latticeGraph`. There is no
finite diagram to draw for "all integers", and the client instead plots the ascending chain a
variable actually traversed: built from ordinary `steps`, no extra field required.

### `LossItem` (widening steps only)

Widening is the step users understand least, so its cost is made explicit rather than left
implicit in the resulting state. `{ name, before, joined, widened, lostBound, message }`: where
`joined` is what a plain join would have produced and `widened` is what was actually kept.
`joined` may differ from the final `after` value shown for that step; `joined` exists
specifically to show the reader what precision would have survived without widening.

### `summary`

`stepCount`, `wideningStepIndices`, `stabilizedAtStep`, `converged`, `notConvergedReason`. All
of these must agree with `steps`: `validateTrace` checks this explicitly, e.g.
`wideningStepIndices` must exactly equal the indices where `kind === 'widen'`, since that field
is what powers "step over widening" in the client.

### `diagnostics`

An **unsupported program still returns a protocol-valid trace**: `steps: []`,
`summary.converged: false`, and `diagnostics` explaining why, each with a real 1-based `line`.
Never throw for "this program isn't supported"; that is an expected, first-class outcome, not
an error.

## Validating a trace

```ts
import { validateTrace } from '@aiviz/trace-protocol';
const result = validateTrace(trace);
// { valid: boolean, issues: { path, message }[] }
```

Or from the shell:

```bash
npx aiviz-validate my-trace.json
```

`validateTrace` checks internal consistency, not just field presence: dangling block
references, edges not mirrored in both directions, a line map pointing at a block that doesn't
exist, `summary` fields that disagree with `steps`. The client runs this on every trace it
receives: a provider that drifts from the schema produces a clear error, not a broken panel.

## See also

- [`ADDING-A-PROVIDER.md`](./ADDING-A-PROVIDER.md): writing a provider, in TypeScript or any
  other language, and checking it with the conformance kit.
- [`packages/trace-protocol/fixtures/count-intervals.trace.json`](../packages/trace-protocol/fixtures/count-intervals.trace.json)
 : a complete real trace to read end to end.
