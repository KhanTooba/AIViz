# AIViz Zero / Nonzero domain

This directory is intentionally outside the AIViz packages and extension. It is a separately
packaged example proving that a domain can be added without editing or rebuilding AIViz.

## Use it in a workspace

1. Install or open AIViz normally.
2. Copy this entire directory to your target workspace as:

   ```text
   <workspace>/.aiviz/domains/zero-nonzero/
   ```

3. Trust that workspace in VS Code; domain modules are executable code.
4. Run **AIViz: Reload Domains**.
5. Open a supported `.c` or `.ll` file, run **AIViz: Analyze Current Function**, and select
   **Zero / Nonzero** in the domain picker.

No AIViz source file is changed in this workflow. Remove the copied directory and reload domains
to remove it from the picker.

## Validate before copying

From a checkout of AIViz that has been built, run:

```bash
npm run check
```

This calls `aiviz-domain check .`, the same manifest and lattice validation used by AIViz
providers. The example supports both bundled provider languages: `c` and `llvm-ir`.

The provider subprocess is crash isolation rather than a security sandbox. Only use domain code
you trust.
