# AIViz 0.2.0 release contract

This document defines the release that will accompany the SANER 2027 Tool Demo submission. It
is a scope boundary, not a statement that the current development build already satisfies every
item. The machine-readable target version and deadlines live in
[`artifact/release.json`](../artifact/release.json). The reviewer tutorial, implemented artifact
commands, and pre-publication checklist live in [`artifact/README.md`](../artifact/README.md).

## Submission contract

- Venue: SANER 2027 Tool Demo Track.
- Optional abstract deadline: October 19, 2026, Anywhere on Earth.
- Paper deadline: October 23, 2026, Anywhere on Earth.
- Format: at most five pages, including references.
- Target public version and Git tag: `0.2.0` / `v0.2.0`.
- Evaluation: automated and engineering-based; no human-participant study is planned.

The paper may say that AIViz is *designed to support instruction and exploration*. It must not
claim improved learning, retention, usability, or classroom effectiveness because this release
does not evaluate those outcomes.

## Central contribution claims

The paper will organize its contribution around three claims. Their stable identifiers must be
used in the paper notes, artifact scripts, raw evaluation output, and release checklist.

1. **AIVIZ-C1 — Observable fixpoint execution.** AIViz materializes a deterministic,
   protocol-valid static-analysis trace and lets a user replay transfers, joins, widening,
   narrowing, and widening loss in the VS Code interface.
2. **AIVIZ-C2 — Provider-independent visualization.** The same extension and trace UI analyze C
   source and textual LLVM IR through separately bundled providers without language-specific
   analysis logic in the client.
3. **AIVIZ-C3 — Extension without modification.** A third party can add a compatible abstract
   value domain under `.aiviz/domains/<domain-id>/`, validate it, reload domains, and use it in
   the existing UI without editing or rebuilding AIViz.

These claims concern the tool architecture and behavior. The implementations of standard
abstract domains are not presented as novel.

## Supporting engineering claims

- **AIVIZ-E1 — Installability.** A reviewer can install a self-contained Marketplace release or
  matching VSIX and run a bundled example without installing this repository's dependencies.
- **AIVIZ-E2 — Isolation and failure handling.** Workspace domain code runs only in a trusted
  workspace and inside the provider subprocess. Invalid manifests, incompatible API versions,
  ID collisions, and exceptions produce diagnostics without disabling built-in domains. The
  subprocess boundary is crash isolation, not a security sandbox.
- **AIVIZ-E3 — Interactive scale.** On the declared benchmark corpus and reference machine, the
  extension remains usable according to reported analysis latency, trace size, step count, and
  rendering measurements. The paper will report measured values rather than promise an
  unmeasured threshold.

## Fixed v0.2.0 interface decisions

The v0.2.0 custom-domain layout is:

```text
.aiviz/domains/<domain-id>/
  domain.json
  domain.mjs
```

`domain.json` declares the manifest schema version, domain API version, stable ID, display name,
entry module, kind, and supported provider languages. For v0.2.0, an external module exports a
value lattice; the provider adapts it with AIViz's existing non-relational domain machinery.
External domains cannot replace a built-in ID.

The command **AIViz: Reload Domains** restarts the relevant provider, rescans and validates the
workspace domains, and refreshes the domain picker. Editing a domain must not require a full VS
Code window reload. A file watcher may prompt the user to run this command after a change.

Workspace domain code is disabled when VS Code Workspace Trust is absent. Built-in domains must
continue to work, and the UI must explain why the workspace domains are unavailable.

## Release gates

The release is not ready to tag until all of the following are true:

- [ ] Marketplace and VSIX installation is self-contained and takes less than five minutes in
  the automated clean-environment acceptance procedure.
- [ ] C and LLVM IR both work through the installed extension.
- [ ] The separately packaged example domain loads with zero changes to tracked AIViz source.
- [ ] Every factual capability or evaluation claim in the paper has an entry in
  [`artifact/CLAIMS.md`](../artifact/CLAIMS.md) and a repeatable command.
- [ ] Correctness, determinism, interoperability, robustness, performance, and installability
  evidence has been generated; a unit-test total alone is insufficient.
- [ ] Related work explicitly discusses Manim-DFA and accurately differentiates AIViz.
- [ ] The demo shows widening loss, domain comparison, LLVM IR, and external-domain reloading.
- [ ] Automated acceptance tests exercise a fresh installation and the written tutorial without
  relying on repository dependencies.
- [ ] Git tag, Marketplace package, VSIX, archived artifact, external example, evaluation data,
  video, and paper all identify version `0.2.0`; recorded checksums match the frozen files.

## Version policy

During development, workspace packages may remain at `0.1.0`. The version is bumped exactly once
after all release gates pass and before collecting the final evidence. At that freeze point:

1. set every workspace package and internal dependency to `0.2.0`;
2. rebuild and rerun the complete artifact suite from a clean checkout;
3. package the VSIX and publish the byte-equivalent Marketplace build;
4. archive code, example, evaluation data, and checksums under a DOI;
5. insert the tag, commit, DOI, Marketplace identifier, video URL, and checksums into the paper;
6. make no behavioral change without issuing a new version and regenerating all evidence.

## Explicitly out of scope

- A human-participant user study or claims about learning effectiveness.
- Loading arbitrary workspace code without Workspace Trust.
- Treating the provider subprocess as a security boundary.
- General C/LLVM support beyond each provider's documented allow-list.
- A stable `1.0` custom-domain API; v0.2.0 compatibility is checked explicitly.
