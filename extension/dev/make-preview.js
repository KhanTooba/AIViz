/**
 * Generates a self-contained `dist/preview.html` for developing the webview
 * outside VS Code.
 *
 * Everything is inlined (CSS, bundle, trace) so it opens straight from file://
 * with no server and no fetch, and it stubs `acquireVsCodeApi` so the panel
 * behaves exactly as it does in the real extension host.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const css = readFileSync('dist/webview.css', 'utf8');
const js = readFileSync('dist/webview.js', 'utf8');
const trace = readFileSync('dist/fixtures/count-intervals.trace.json', 'utf8');

// Approximate a dark VS Code theme so the preview is representative.
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
}
body { max-width: 460px; }
`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>AIViz webview preview</title>
<style>${themeVars}</style>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>
  // Stub of the VS Code webview bridge.
  const __posted = [];
  window.__posted = __posted;
  function acquireVsCodeApi() {
    return {
      postMessage: (m) => { __posted.push(m); },
      getState: () => undefined,
      setState: () => {},
    };
  }
</script>
<script>${js}</script>
<script>
  const __trace = ${trace};
  window.postMessage({
    type: 'trace',
    trace: __trace,
    session: {
      functions: [{ name: __trace.program.function, line: 1, supported: true }],
      domains: [
        { id: 'intervals', name: 'Intervals' },
        { id: 'sign', name: 'Sign' },
        { id: 'constprop', name: 'Constant Propagation' },
      ],
      selectedFunction: __trace.program.function,
      selectedDomain: __trace.domain.id,
    },
  }, '*');
</script>
</body>
</html>`;

writeFileSync('dist/preview.html', html);
console.log('wrote dist/preview.html');
