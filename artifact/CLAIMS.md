# AIViz claim-to-evidence ledger

This ledger is the source of truth for claims in the SANER 2027 tool-demo paper. A claim is not
paper-ready until its command exists, succeeds from a documented clean environment, and writes
its raw result beneath `artifact/results/`. The commands below are planned during Phase 1; later
phases must change their status to **implemented** only after verification.

## Rules

1. Put a claim ID next to every capability, quantitative result, or compatibility statement in
   the paper source while drafting.
2. Do not copy a number into the paper by hand. Generate a small LaTeX macro or checked result
   file from the corresponding artifact command.
3. Record operating system, architecture, VS Code version, Node version where applicable, Git
   commit, AIViz version, command, start time, and result with every run.
4. Use a fixed corpus and fixed random seeds. Randomized containment tests provide bounded
   validation, not proof of soundness.
5. Preserve failures as diagnostics in raw output; do not silently remove unsupported cases.
6. At release freeze, `npm run artifact:all` must run every command in this ledger and fail when
   the source version differs from `artifact/release.json`.

## Claim matrix

| ID | Paper-safe claim | Repeatable command | Required evidence | Status |
| --- | --- | --- | --- | --- |
| AIVIZ-C1 | AIViz records protocol-valid fixpoint steps and supports deterministic replay, including explicit widening-loss data. | `npm run artifact:smoke` and `npm run artifact:determinism` | Schema validation, expected step kinds/loss fields, repeated trace hashes, fixed corpus and seeds. | Implemented for the declared development fixture; repeat at release freeze. |
| AIVIZ-C2 | One installed extension analyzes supported C and LLVM IR inputs through two providers while reusing the same trace UI. | `npm run artifact:providers` | Extension-level runs for both languages, provider identity in traces, protocol validation, screenshots or machine-readable UI smoke results. | Implemented for the development bundle; Phase 6 adds measured release evidence. |
| AIVIZ-C3 | A separately packaged value domain is discovered, validated, reloaded, and used without changing or rebuilding AIViz. | `npm run artifact:external-domain` | Clean AIViz tree before/after, example package checksum, discovery diagnostics, trace naming the external domain, zero tracked-source diff. | Implemented for the development bundle; Phase 6 adds clean-release evidence. |
| AIVIZ-E1 | The release installs and runs without repository dependencies in the supported clean environments. | Manual GitHub Release clean-install check | GitHub Release/VSIX identity, elapsed steps/times, supported OS matrix, example analysis result. | Release-time manual check |
| AIVIZ-E2 | Bad or incompatible workspace domains fail diagnostically without breaking built-in domains. | `npm run artifact:domain-failures` | Cases for malformed manifest, API mismatch, duplicate/built-in ID, module exception, and post-failure built-in analysis. | Implemented for the declared fault corpus; repeat at release freeze. |
| AIVIZ-E3 | AIViz's measured analysis costs on the declared corpus are suitable for an interactive demonstration. | `npm run artifact:benchmark` | Reference machine, corpus, warmup/repetition policy, median and tail latency, trace bytes, and step count. Browser rendering measurement is a release-time manual check. | Implemented for provider analysis; repeat rendering measurement at release freeze. |
| AIVIZ-V1 | Results for supported examples contain sampled concrete executions. | `npm run artifact:containment` | Fixed-seed generated inputs, concrete outcomes, abstract results, containment verdicts by provider/domain. | Planned |

## Paper section mapping

| Paper section | Claim IDs expected |
| --- | --- |
| Introduction and contributions | AIVIZ-C1, AIVIZ-C2, AIVIZ-C3 |
| Architecture and trace protocol | AIVIZ-C1, AIVIZ-C2, AIVIZ-E2 |
| Interaction scenario | AIVIZ-C1, AIVIZ-E1 |
| External-domain interface | AIVIZ-C3, AIVIZ-E2 |
| Evaluation | all IDs, with AIVIZ-V1 described as bounded validation |
| Limitations | explicit boundaries from the release contract; no unsupported claim IDs |

## Canonical command surface

The final public artifact will expose these commands from the repository root:

```bash
npm run artifact:smoke
npm run artifact:providers
npm run artifact:external-domain
npm run artifact:install
npm run artifact:domain-failures
npm run artifact:determinism
npm run artifact:containment
npm run artifact:benchmark
npm run artifact:all
```

Until a command is implemented, it must not be added to `package.json` as a placeholder that
returns success. Missing evidence should fail visibly.
