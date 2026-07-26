# Adding a provider

A provider is a separate process that speaks the [AIViz trace protocol](./PROTOCOL.md) — see
that document first for the wire format. This one is a practical walkthrough: what to
implement, how to launch it, and how to check it before wiring it into anything.

**Current limitation, stated up front:** the VS Code extension shipped in this repo only
launches its one bundled provider (`@aiviz/provider-c-source`) today. There is no
settings-based provider registry yet for pointing the extension at an external provider — that
is on the roadmap, not implemented. What you get today from following this guide is a provider
process you can test standalone with the conformance kit; wiring an arbitrary third-party
provider into the extension's UI is future work.

## The contract

Four methods, described fully in [PROTOCOL.md](./PROTOCOL.md#methods):
`initialize`, `listFunctions`, `precheck`, `analyze`. In TypeScript, that's the
[`AnalysisProvider`](../packages/trace-protocol/src/provider.ts) interface:

```ts
interface AnalysisProvider {
  initialize(): ProviderInfo | Promise<ProviderInfo>;
  listFunctions(req: DocumentRequest): ListFunctionsResult | Promise<ListFunctionsResult>;
  precheck(req: PrecheckRequest): PrecheckResult | Promise<PrecheckResult>;
  analyze(req: AnalyzeRequest): AnalysisTrace | Promise<AnalysisTrace>;
}
```

`analyze()` is the one with real work to do. The pattern this repo uses (see
[`@aiviz/analysis-core`](../packages/analysis-core)) is: parse to a small IR, build a CFG, run
an instrumented worklist fixpoint that emits a `Step` per state transition, return the whole
thing as one `AnalysisTrace`. None of that is prescribed by the protocol — only the shape of
what `analyze()` returns is.

## Option A: TypeScript, using `@aiviz/provider-sdk`

This is what `provider-c-source` itself does — the SDK is not aspirational, it's dogfooded by
the provider this extension ships.

**1. Implement `AnalysisProvider`.**

```ts
// src/myProvider.ts
import type { AnalysisProvider, ProviderInfo, AnalysisTrace } from '@aiviz/trace-protocol';

export class MyProvider implements AnalysisProvider {
  initialize(): ProviderInfo {
    return {
      id: 'my-provider',
      name: 'My Language Provider',
      version: '0.1.0',
      protocolVersion: '0.1.0',
      languages: ['mylang'],
      domains: [{ id: 'intervals', name: 'Intervals' }],
    };
  }
  listFunctions(req) { /* parse req.source, return { functions: [...] } */ }
  precheck(req) { /* return { supported, diagnostics } */ }
  analyze(req): AnalysisTrace { /* the real work */ }
}
```

**2. Serve it over stdio.** This is the one piece of transport boilerplate every provider
needs, so it's a single call:

```ts
// src/main.ts
#!/usr/bin/env node
import { serveOverStdio } from '@aiviz/provider-sdk';
import { MyProvider } from './myProvider.js';

serveOverStdio(new MyProvider());
```

That's the entire entry point — compare
[`provider-c-source/src/main.ts`](../packages/provider-c-source/src/main.ts), which is exactly
this.

**3. Ship a manifest** (`provider.json`) describing how to launch it:

```json
{
  "id": "my-provider",
  "name": "My Language Provider",
  "version": "0.1.0",
  "languages": ["mylang"],
  "command": "node",
  "args": ["./dist/main.js"]
}
```

`command`/`args` are resolved relative to the manifest's own directory (or `cwd`, if given) via
`resolveProviderLaunch` — see [`@aiviz/provider-sdk`](../packages/provider-sdk).

## Option B: any other language

The protocol is deliberately language-agnostic — see [PROTOCOL.md](./PROTOCOL.md#transport).
Read one line of JSON at a time from stdin, write one line of JSON per response to stdout:

```python
import sys, json

def handle(method, params):
    if method == "aiviz/initialize":
        return {"id": "my-py-provider", "name": "...", "version": "0.1.0",
                "protocolVersion": "0.1.0", "languages": ["mylang"],
                "domains": [{"id": "intervals", "name": "Intervals"}]}
    # ...listFunctions, precheck, analyze...

for line in sys.stdin:
    req = json.loads(line)
    try:
        result = handle(req["method"], req.get("params"))
        print(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}), flush=True)
    except Exception as e:
        print(json.dumps({"jsonrpc": "2.0", "id": req["id"],
                           "error": {"code": -32603, "message": str(e)}}), flush=True)
```

The one behavior worth copying exactly from `serveOverStdio`: **don't exit the instant stdin
closes if a request is still being processed.** If your analysis is ever asynchronous (a
subprocess call, a thread pool), track in-flight requests and defer exit until they've all
replied — otherwise a slow request's answer is silently dropped the moment the client
disconnects.

## Checking your provider

Before wiring anything up, run the conformance kit against it — the same checks a real client
implicitly depends on, run directly against your process over the real transport:

```bash
npx aiviz-conformance --fixture fixture.json -- node dist/main.js
# or, using your provider.json:
npx aiviz-conformance --manifest provider.json --fixture fixture.json
```

`fixture.json`:

```json
{
  "file": "test.c",
  "source": "int f(void) { int i = 0; while (i < 10) { i = i + 1; } return i; }",
  "function": "f",
  "domain": "intervals",
  "unsupported": {
    "file": "bad.c",
    "source": "int g(int *p) { return *p; }",
    "function": "g"
  }
}
```

This checks: `initialize()` is well-formed; `listFunctions()` reports your fixture function as
supported; `precheck()` agrees; `analyze()` returns a schema-valid, converged trace with a
non-empty explanation on every step; and — if you provide `unsupported` — that a rejected
program still gets a real line number and a protocol-valid "not supported" trace rather than a
thrown error. Without `--fixture`, only `initialize()` is checked — enough to confirm your
process starts and speaks JSON-RPC, not that its analysis is correct.

Run it without spawning a process at all, in your own test suite:

```ts
import { runConformanceSuite, summarize } from '@aiviz/provider-sdk';
import { MyProvider } from '../src/myProvider.js';

const checks = await runConformanceSuite(new MyProvider(), fixture);
assert.equal(summarize(checks).ok, true);
```

This is exactly what
[`provider-c-source`'s own test suite](../packages/provider-c-source/src/test/conformance.test.ts)
does — it is not a separate code path from what the CLI runs, just a different transport (an
in-process object instead of a spawned RPC proxy) feeding the same `runConformanceSuite`.

## See also

- [PROTOCOL.md](./PROTOCOL.md) — the wire format and trace schema in full.
- [`packages/provider-c-source`](../packages/provider-c-source) — a complete reference
  implementation, source-level C via tree-sitter.
- [`packages/provider-llvm-ir`](../packages/provider-llvm-ir) — a second complete reference
  implementation, LLVM textual IR (`.ll`) via a hand-rolled parser. Concrete evidence for this
  guide's own claim that the protocol is provider-agnostic: it reuses `@aiviz/analysis-core`'s
  engine and every domain completely unchanged, translating a structurally different IR
  (SSA `phi` nodes included) down to the same tiny `Cfg`/`Expr`/`Cond` shape the C provider
  produces.
- [`packages/provider-sdk`](../packages/provider-sdk) — `serveOverStdio`, the manifest loader,
  and the conformance kit's source.
