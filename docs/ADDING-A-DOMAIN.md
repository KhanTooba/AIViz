# Adding a workspace domain

AIViz `0.2.0` can load a third-party **value lattice** from a trusted workspace. This extends the
existing non-relational analysis engine: your module implements one value per variable, and
AIViz supplies environments, expression evaluation, assignments, guards, joins, widening, and
trace generation. It does not register another analysis-provider process.

## Safety boundary

Domain modules are JavaScript code. AIViz never imports them in the VS Code extension host; it
passes their directories to the selected C or LLVM provider subprocess only when VS Code reports
that the workspace is trusted. The subprocess protects the editor from ordinary provider crashes,
but it is **not** a security sandbox. Do not trust a workspace whose domain code you would not
run locally.

In an untrusted workspace, built-in domains continue to work and workspace domains are disabled.

## Directory layout

Place one domain per subdirectory under the workspace root:

```text
.aiviz/domains/
  zero-nonzero/
    domain.json
    domain.mjs
```

After creating or changing a domain, run **AIViz: Reload Domains**. The command restarts the
provider, rescans the directory, validates the manifest and lattice, and refreshes the existing
domain picker. File changes prompt for this reload; a full VS Code window reload is unnecessary.

To create a valid starting point inside a trusted workspace, run **AIViz: Create Custom Domain**.
It writes `domain.json` and a conservative finite-lattice implementation, then offers to reload
domains. The generated arithmetic deliberately returns `top` where it has no precise semantics;
replace it with a sound implementation for your domain.

For terminal-based authoring, the domain SDK provides the same workflow:

```bash
aiviz-domain create .aiviz/domains/my-domain --id my-domain --name "My Domain"
aiviz-domain check .aiviz/domains/my-domain
```

## Manifest

`domain.json` must satisfy
[`@aiviz/domain-sdk`'s schema](../packages/domain-sdk/schema/domain.schema.json):

```json
{
  "schemaVersion": 1,
  "apiVersion": "0.2",
  "id": "zero-nonzero",
  "name": "Zero / Nonzero",
  "description": "Distinguishes zero from a nonzero integer.",
  "kind": "value-lattice",
  "entry": "./domain.mjs",
  "languages": ["c", "llvm-ir"]
}
```

`id` must match `^[a-z][a-z0-9-]*$`. It cannot duplicate a built-in domain or another workspace
domain. `entry` must be an `.mjs` file inside the same domain directory. `languages` controls
which bundled providers offer the domain: use `c`, `llvm-ir`, or both.

## Module interface

`domain.mjs` exports a named `lattice` object. Its `id`, `name`, and `finiteLattice` values must
agree with the manifest. The object follows AIViz's
[`ValueLattice`](../packages/analysis-core/src/domain.ts) interface. At discovery time AIViz
checks the complete method surface and samples basic lattice laws; an invalid module is skipped
with a diagnostic while built-ins remain usable.

The smallest useful implementation looks like this shape:

```js
export const lattice = {
  id: 'zero-nonzero',
  name: 'Zero / Nonzero',
  finiteLattice: true,
  bottom: /* value */,
  top: /* value */,
  isBottom(value) { /* boolean */ },
  isTop(value) { /* boolean */ },
  equal(left, right) { /* boolean */ },
  leq(left, right) { /* boolean */ },
  join(left, right) { /* value */ },
  meet(left, right) { /* value */ },
  widen(left, right) { /* value */ },
  narrow(left, right) { /* value */ },
  constant(number) { /* value */ },
  add(left, right) { /* value */ },
  sub(left, right) { /* value */ },
  mul(left, right) { /* value */ },
  div(left, right) { /* value */ },
  mod(left, right) { /* value */ },
  neg(value) { /* value */ },
  refine(operator, left, right) { /* value */ },
  format(value) { return { repr: '...', kind: 'value' }; },
  describeLoss(oldValue, joinedValue, widenedValue) { return undefined; },
  latticeGraph() { return { nodes: [], edges: [] }; }
};
```

`format` uses `kind: 'bottom' | 'top' | 'value'`. Finite lattices must provide a valid
`latticeGraph`; infinite lattices omit it. Arithmetic and guard refinement must be conservative:
if an operation cannot be modeled precisely, return a sound over-approximation such as `top`.

## Diagnostics

Run **AIViz: Show Domain Diagnostics** to see malformed manifests, incompatible API versions,
duplicate IDs, modules that fail to load, or lattice validation failures. Diagnostics are also
written to the **AIViz Domains** output channel. A faulty optional domain never prevents a
built-in domain from being selected.

For a complete out-of-tree example, see
[`examples/zero-nonzero-domain`](../examples/zero-nonzero-domain). It can be copied into another
workspace without changing AIViz.
