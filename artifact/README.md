# AIViz reviewer artifact

This directory is the reproducibility entry point for the AIViz `0.2.0` release. It supports the
tool-paper claims through automated engineering evidence; it does not collect human-subject data
or make claims about learning outcomes.

## Five-minute reviewer tutorial

The final release will attach `aiviz-0.2.0.vsix` to the archival release and identify the same
version on the VS Code Marketplace. Use either source, not both.

1. In VS Code, choose **Extensions: Install from VSIX...** and select `aiviz-0.2.0.vsix` (or
   install **AIViz 0.2.0** from the Marketplace).
2. Open a new, trusted folder and add the supplied `examples/count.c` file. No repository
   checkout, Node installation, compiler, or external analysis binary is required for this step.
3. Place the cursor in `count`, run **AIViz: Analyze Current Function**, choose **Intervals**,
   then step to a widening using **Step Over to Next Widening**. The panel reports the value lost
   by widening.
4. Run **AIViz: Compare Domains** and compare **Intervals** with **Sign**.
5. Open the supplied `examples/count.ll` and run **AIViz: Analyze Current Function**. The same
   panel is backed by the bundled LLVM IR provider.
6. Copy the supplied `examples/zero-nonzero-domain` directory to
   `.aiviz/domains/zero-nonzero` in the trusted folder. Run **AIViz: Reload Domains**, select
   **Zero / Nonzero**, and analyze `count.c` again.

The expected observations are: an explicit widening-loss explanation, two side-by-side domain
traces, a successful LLVM IR analysis, and **Zero / Nonzero** in the domain picker. If any step
fails, run **AIViz: Show Domain Diagnostics** and attach its output when reporting the issue.

## Reproduce current automated evidence

From a repository checkout with Node 20 or newer and dependencies installed (`npm install`), run:

```bash
npm run artifact:smoke
npm run artifact:providers
npm run artifact:external-domain
npm run artifact:determinism
npm run artifact:domain-failures
npm run artifact:benchmark
```

Each command writes `artifact/results/<name>.json` (provenance and exit statuses) and
`artifact/results/<name>.log` (raw command output). These files are deliberately ignored by Git;
the final archive will contain evidence regenerated from the frozen `v0.2.0` revision.

| Command | Claims checked now | What it proves |
| --- | --- | --- |
| `artifact:smoke` | AIVIZ-C1 | Build, schema/protocol validation, and deterministic engine tests pass. |
| `artifact:providers` | AIVIZ-C2 | The packaged C and LLVM provider executables pass real stdio checks. |
| `artifact:external-domain` | AIVIZ-C3 | The independent example validates and is loaded by the packaged C provider. |
| `artifact:determinism` | AIVIZ-C1 | Ten repeated analyses produce one SHA-256 trace hash. |
| `artifact:domain-failures` | AIVIZ-E2 | Invalid API version, built-in-ID collision, and module exception are diagnosed while a built-in analysis still converges. |
| `artifact:benchmark` | AIVIZ-E3 | Warm-cache analysis latency, trace bytes, steps, and iterations for the fixed C/LLVM corpus. |

Clean-install, concrete-containment, and browser-rendering evidence remain release-time checks.
See [CLAIMS.md](CLAIMS.md) for claim wording and evidence requirements.

## Release checklist

Before publishing, execute and record the following at the frozen `v0.2.0` revision:

- [ ] Run the six commands above and preserve their JSON/log evidence.
- [ ] Build the VSIX with `npm run package -w extension`; record its SHA-256 and size.
- [ ] On a clean VS Code profile, time the five-minute tutorial using the VSIX; repeat on the
  supported operating systems and record VS Code version, OS, and architecture.
- [ ] Verify the Marketplace package and VSIX have the same version and byte-identical packaged
  contents where applicable.
- [ ] Add clean-install, concrete-containment, and browser-rendering measurements before final
  release evidence is frozen.
- [ ] Ensure every paper claim cites a claim ID and generated result, and that the paper, VSIX,
  example package, demo video, archive, and Git tag all say `0.2.0`.

No publish, tag, or upload is performed by any command in this directory.
