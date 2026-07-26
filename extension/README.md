# AIViz — Abstract Interpretation Visualizer

Step through static-analysis fixpoint computations like a debugger. AIViz runs real abstract
interpretation on your C function and shows you the control-flow graph, the abstract state at
every program point, and exactly what joins, widening, and narrowing do to it — one step at a
time, forward or backward.

This isn't a slide-deck simulation of abstract interpretation. It's a real fixpoint engine
running nine real abstract domains, instrumented to explain itself.

![Stepping through widening, with the discarded bound shown](media/demo-stepping-widening.gif)

## What you get

- **Click a line, see the block.** A CFG panel next to your code; clicking a line highlights the
  block(s) it maps to (one source line is often several program points — a `for` loop's
  initializer, condition, and update are three distinct blocks, and the panel shows all of
  them).
- **Step like a debugger.** Next / Previous walk the analysis one transfer at a time. Step-over-
  widening jumps straight to the next widening point, skipping the iterations in between.
- **See what widening actually throws away.** Every widening step shows the bound a plain join
  would have kept, struck through next to what widening actually kept — the cost of guaranteed
  termination, made visible instead of implicit.
- **Turn narrowing on or off** and watch the same program end at a different answer. That
  difference is the lesson, not a bug.
- **Nine abstract domains**, five non-relational (Intervals, Sign, Constant Propagation, Parity,
  Congruence) and four relational (Zones, Octagons, Zonotopes, Polyhedra) that track
  relationships *between* variables — a **Relations** section shows the cross-variable facts a
  relational domain finds (e.g. `j - i ≤ 1`) that no per-variable domain can express at all.
- **Compare domains side by side** on the same function, iteration by iteration — see exactly
  where a more precise domain diverges from a coarser one, and why.
- **A lattice view** for every domain: a Hasse diagram for the finite ones (Sign, Parity), the
  actual ascending chain traversed for the infinite ones (Intervals, Zones, ...).

![Comparing Intervals against Congruence on the same function, block by block](media/demo-compare-mode.gif)

## Getting started

1. Open a `.c` file and put your cursor in a function.
2. Run **AIViz: Analyze Current Function** (editor toolbar, or the command palette).
3. Click through the CFG, or use **Next Step** / **Previous Step** (`F10` / `Shift+F10`) and
   **Step Over to Next Widening** (`F11`).
4. Run **AIViz: Compare Domains** to see two domains analyze the same function side by side.

Supported C subset: `int`/`bool` locals, `+ - * / %`, `if`/`else`, `while`, `for`, `do-while`,
`break`, `continue`, `return`, and nested loops — no pointers, arrays, structs, floats, `goto`,
function calls, or recursion. A rejected function tells you exactly why, with a real line
number, rather than silently producing a wrong or misleading analysis.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `aiviz.wideningDelay` | `1` | Iterations at a loop header before widening kicks in |
| `aiviz.narrowing` | `true` | Run narrowing passes after widening to recover precision |
| `aiviz.maxIterations` | `200` | Abort rather than hang on a pathological fixpoint |
| `aiviz.analyzeOnSave` | `true` | Re-run the analysis automatically when the analyzed file is saved |

## Why this exists

Abstract interpretation courses usually stop at the math. This is the part after the math: what
a real, instrumented fixpoint computation actually does, at the granularity of one transfer
function at a time, on your own code. The engine and every domain are genuinely implemented —
not a slide simulation — including the parts that are supposed to lose precision (widening) and
the parts that sometimes recover it (narrowing).

## Learn more

The full project — the trace protocol, the fixpoint engine, all nine domains, and a second
analysis provider built on LLVM IR to prove the whole design is provider-agnostic — lives at the
project repository, along with the protocol reference and a guide for writing your own provider.
