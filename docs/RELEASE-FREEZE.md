# AIViz 0.2.0 release freeze

This is the final local procedure before the manual Git tag, VSIX/Marketplace publication,
archive upload, video upload, and paper submission. It intentionally performs none of those
external actions.

## Before changing versions

1. Finish and commit the paper, video, and clean-install evidence.
2. Run the six implemented artifact commands in [artifact/README.md](../artifact/README.md).
3. Complete the remaining manual evidence: fresh VSIX installation, browser rendering timing,
   and the two-researcher tutorial check. These are release gates, not paper claims about
   learning effectiveness.

## Freeze procedure

1. Change every workspace package and the extension from `0.1.0` to `0.2.0`; change every
   internal `@aiviz/*` dependency range to the exact version `0.2.0`.
2. Update the version, tag, archive DOI, Marketplace identifier, and video URL in
   `paper/.../notes/release-metadata.tex`. Do not invent a DOI or URL before it exists.
3. Run `npm install --ignore-scripts`, `npm run build`, `npm test`, and all implemented artifact
   commands from a clean checkout.
4. Run `node artifact/release-check.mjs --frozen`. It must print no failures.
5. Package locally with `npm run package -w extension`, record the VSIX filename, SHA-256, size,
   and package contents. Perform clean-profile installation before publishing.
6. Make one final no-behavior-change commit, then create `v0.2.0`. Only after that should you
   publish the already-checked VSIX, archive the artifact, upload the video, and submit the paper.

If any behavior changes after the evidence is generated, repeat the procedure with a new version.
