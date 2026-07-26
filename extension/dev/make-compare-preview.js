/**
 * Generates a self-contained `dist/compare-preview.html` for developing the
 * compare webview outside VS Code — same approach as make-preview.js.
 *
 *   node dev/make-compare-preview.js [file.c] [function] [domainA] [domainB]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { CSourceProvider } from '../../packages/provider-c-source/dist/provider.js';

const file = process.argv[2] ?? '../examples/count.c';
const fn = process.argv[3] ?? 'count';
const domainA = process.argv[4] ?? 'intervals';
const domainB = process.argv[5] ?? 'sign';

const source = readFileSync(file, 'utf8');
const provider = new CSourceProvider();

const traceA = await provider.analyze({ file, source, function: fn, domain: domainA });
const traceB = await provider.analyze({ file, source, function: fn, domain: domainB });

const css = readFileSync('dist/webview.css', 'utf8');
const js = readFileSync('dist/compareWebview.js', 'utf8');

const themeVars = `
:root {
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: "SF Mono", Menlo, Consolas, monospace;
  --vscode-foreground: #cccccc;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-sideBar-background: #181818;
  --vscode-editor-background: #1f1f1f;
  --vscode-editorWidget-background: #252526;
  --vscode-panel-border: #3c3c3c;
  --vscode-focusBorder: #0078d4;
  --vscode-textLink-foreground: #4daafc;
  --vscode-editor-foreground: #cccccc;
  --vscode-editor-selectionBackground: #264f78;
  --vscode-badge-background: #4d4d4d;
  --vscode-badge-foreground: #ffffff;
  --vscode-button-background: #0078d4;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #026ec1;
  --vscode-button-secondaryBackground: #313131;
  --vscode-button-secondaryForeground: #cccccc;
  --vscode-button-secondaryHoverBackground: #3c3c3c;
  --vscode-textBlockQuote-background: #202020;
  --vscode-errorForeground: #f85149;
  --vscode-editorWarning-foreground: #d29922;
  --vscode-testing-iconPassed: #2ea043;
  --vscode-diffEditor-insertedTextBackground: rgba(46, 160, 67, 0.15);
  --vscode-dropdown-background: #313131;
  --vscode-dropdown-foreground: #cccccc;
  --vscode-dropdown-border: #3c3c3c;
}
body { max-width: 700px; }
`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>AIViz compare preview</title>
<style>${themeVars}</style>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>
  function acquireVsCodeApi() {
    return { postMessage: () => {}, getState: () => undefined, setState: () => {} };
  }
</script>
<script>${js}</script>
<script>
  window.postMessage({ type: 'data', traceA: ${JSON.stringify(traceA)}, traceB: ${JSON.stringify(traceB)} }, '*');
</script>
</body>
</html>`;

writeFileSync('dist/compare-preview.html', html);
console.log(
  `wrote dist/compare-preview.html — ${domainA} (${traceA.summary.iterations} iter) vs ` +
    `${domainB} (${traceB.summary.iterations} iter)`
);
