# AIViz 0.2.0 engineering evidence

This file records the release-time engineering evidence for the AIViz `v0.2.0` GitHub Release.
The raw JSON records and command logs are packaged as `aiviz-0.2.0-evidence.zip` alongside the
VSIX release asset.

The evidence suite was run on macOS (Darwin), arm64, with Node `v26.5.0`. The raw records retain
the exact operating-system string, command start and finish times, AIViz version, and Git revision.

| Check | Result |
| --- | --- |
| Build, test, and release preflight | Passed; the automated suite contains 248 passing tests. |
| C and LLVM provider transport | Passed using each bundled provider over standard input/output. |
| Independent Zero / Nonzero domain | Passed; the example validated and loaded for both C and LLVM IR. |
| Deterministic replay | Ten `count.c` interval analyses produced one SHA-256 trace hash: `f04ba80b04fbf35cba4fa4cf0f3dac1e4e274438eb4ecb3df1954734b3ce5cad`. |
| Invalid-domain isolation | Passed; malformed domains produced diagnostics while a built-in analysis still converged. |
| Fixed-corpus provider benchmark | Passed after one warm-up and 15 repetitions per case; detailed median and p95 latency, trace bytes, steps, and iterations are in the raw JSON. |

The manual clean-install check and browser-rendering timing occur after the GitHub Release exists,
because they must use the public release asset rather than a repository checkout. The demo video
will show the same installed-extension workflow.
