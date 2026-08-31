# AIViz 0.2.0 demo-video script

Target duration: 3:30--4:30. Record from the frozen `v0.2.0` VSIX on a clean VS Code profile.
Narration should describe tool behavior, not claim that users learn more effectively.

| Time | Screen action | Evidence / narration |
| --- | --- | --- |
| 0:00--0:20 | Open `count.c`; run **Analyze Current Function** with Intervals. | AIViz converts a supported function into an inspectable fixpoint trace. |
| 0:20--1:05 | Step through the CFG; use **Step Over to Next Widening**. | Point to the plain-join value and the discarded widening bound. |
| 1:05--1:30 | Toggle narrowing and show the changed exit state. | Narrowing can recover precision after a widening. |
| 1:30--2:05 | Run **Compare Domains** on the same function. | Show the same program under two domains. |
| 2:05--2:35 | Open `count.ll`; analyze `count`. | The same panel is backed by the bundled LLVM IR provider. |
| 2:35--3:15 | In a trusted workspace copy `zero-nonzero-domain`; show its manifest; run **Reload Domains**. | No AIViz source edit, rebuild, or window reload is needed. |
| 3:15--3:45 | Select **Zero / Nonzero** and analyze `count.c`; optionally open diagnostics. | The external domain appears in the existing picker and runs in the provider subprocess. |
| 3:45--4:05 | Show artifact commands and matching version identifiers. | Close with reproducibility and the scoped C/LLVM support boundary. |

Before recording, verify the tutorial in [README.md](README.md), ensure no personal paths or
tokens are visible, record at 1080p, and retain the project file plus final MP4 checksum in the
release archive.
