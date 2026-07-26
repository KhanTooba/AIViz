import * as vscode from 'vscode';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { AnalysisTrace, ProviderInfo } from '@aiviz/trace-protocol';
import { validateTrace } from '@aiviz/trace-protocol';
import { ProviderClient } from './providerClient.js';
import { TraceUI, makeNonce } from './traceUI.js';

/**
 * Locates the bundled provider.
 *
 * Checked in order: packaged inside the extension, then the monorepo layout, so
 * both an installed .vsix and `F5` from the repo work.
 */
function resolveProviderEntry(extensionPath: string): string | undefined {
  return [
    path.join(extensionPath, 'dist', 'provider', 'main.cjs'),
    path.join(extensionPath, '..', 'packages', 'provider-c-source', 'dist', 'main.js'),
    path.join(extensionPath, 'node_modules', '@aiviz', 'provider-c-source', 'dist', 'main.js'),
    path.join(extensionPath, '..', 'node_modules', '@aiviz', 'provider-c-source', 'dist', 'main.js'),
  ].find((p) => existsSync(p));
}

export function activate(context: vscode.ExtensionContext): void {
  let client: ProviderClient | undefined;
  let info: ProviderInfo | undefined;
  let lastDomain = 'intervals';
  let panel: vscode.WebviewPanel | undefined;
  // Bumped on every analysis; a request only applies its result if it is still
  // the most recent one requested. Without this, a slow analysis triggered by
  // an earlier save could overwrite the result of a faster, more recent one.
  let generation = 0;

  const ui = new TraceUI(context.extensionUri, (fn, domain) => runAnalysis(fn, domain));

  const getClient = (): ProviderClient => {
    if (client) return client;
    const entry = resolveProviderEntry(context.extensionPath);
    if (!entry) {
      throw new Error(
        'could not find the bundled C provider — run `npm run build` in the repo root.'
      );
    }
    client = new ProviderClient({
      command: process.execPath,
      args: [entry],
      // The provider cannot resolve node_modules once bundled into the .vsix,
      // so tell it where the tree-sitter wasm files were copied.
      env: { AIVIZ_WASM_DIR: path.join(context.extensionPath, 'dist', 'provider') },
    });
    return client;
  };

  /** Opens the trace beside the editor — the right-hand column. */
  function openPanel(): vscode.WebviewPanel {
    if (panel) {
      panel.reveal(vscode.ViewColumn.Beside, true);
      return panel;
    }
    panel = vscode.window.createWebviewPanel(
      'aiviz.tracePanel',
      'AIViz — Analysis Trace',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      }
    );
    panel.webview.html = ui.html(panel.webview);
    ui.attach(
      {
        webview: panel.webview,
        reveal: () => panel?.reveal(vscode.ViewColumn.Beside, true),
      },
      panel.onDidDispose
    );
    panel.onDidDispose(() => {
      panel = undefined;
    });
    return panel;
  }

  /**
   * @param options.silent Used for the save-triggered refresh: no "open a C
   *   file first" warning if the saved file isn't the one being analyzed, and
   *   failures are shown in the panel rather than as an error toast — an
   *   unsupported program is an expected outcome of editing, not a bug.
   */
  async function runAnalysis(
    fnName?: string,
    domainId?: string,
    options: { doc?: vscode.TextDocument; silent?: boolean } = {}
  ): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const doc =
      options.doc ??
      (editor?.document.languageId === 'c'
        ? editor.document
        : vscode.workspace.textDocuments.find(
            (d) => d.uri.fsPath === ui.currentFile() && d.languageId === 'c'
          ));

    if (!doc) {
      if (!options.silent) void vscode.window.showWarningMessage('AIViz: open a C file first.');
      return;
    }

    // Always bring the panel to front for a manual run; a save-triggered
    // refresh should update in place without stealing focus or popping the
    // panel open if the user closed it.
    if (!options.silent) openPanel();
    if (!ui.hasSurface) return;

    const myGeneration = ++generation;
    const file = doc.uri.fsPath;
    const source = doc.getText();

    try {
      const c = getClient();
      info ??= await c.initialize();

      ui.setStatus(options.silent ? 'Re-analysing…' : 'Analysing', true);
      const { functions } = await c.listFunctions(file, source);
      if (myGeneration !== generation) return; // superseded by a newer request

      if (functions.length === 0) {
        ui.setStatus('No functions found in this file.');
        return;
      }

      // Default to the function the cursor is in: the last one starting at or
      // above the caret.
      const caret = (editor?.selection.active.line ?? 0) + 1;
      const atCaret = [...functions].reverse().find((f) => f.line <= caret);
      const chosen =
        functions.find((f) => f.name === fnName)?.name ?? atCaret?.name ?? functions[0]!.name;

      const domain = domainId ?? lastDomain;
      lastDomain = domain;

      const cfg = vscode.workspace.getConfiguration('aiviz');
      const trace = await c.analyze({
        file,
        source,
        function: chosen,
        domain,
        config: {
          wideningDelay: cfg.get('wideningDelay', 1),
          narrowing: cfg.get('narrowing', true),
          maxIterations: cfg.get('maxIterations', 200),
        },
      });
      if (myGeneration !== generation) return; // superseded by a newer request

      // Validate provider output before rendering: a third-party provider that
      // drifts from the schema should give a clear error, not a broken panel.
      const result = validateTrace(trace);
      if (!result.valid) {
        const detail = result.issues
          .slice(0, 3)
          .map((i) => `${i.path || '<root>'}: ${i.message}`)
          .join('; ');
        throw new Error(`provider returned an invalid trace — ${detail}`);
      }

      ui.setTrace(trace, {
        functions,
        domains: (info?.domains ?? []).map((d) => ({ id: d.id, name: d.name })),
        selectedFunction: chosen,
        selectedDomain: domain,
      });
    } catch (err) {
      if (myGeneration !== generation) return;
      const message = err instanceof Error ? err.message : String(err);
      ui.setStatus(`Analysis failed: ${message}`);
      if (!options.silent) void vscode.window.showErrorMessage(`AIViz: ${message}`);
    }
  }

  /** Loads a trace from disk without running a provider — used to inspect a
   * saved trace, e.g. the reference fixture. */
  async function loadTraceFile(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'Analysis trace': ['json'] },
      openLabel: 'Load trace',
    });
    const file = picked?.[0]?.fsPath;
    if (!file) return;

    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      const result = validateTrace(parsed);
      if (!result.valid) {
        const detail = result.issues
          .slice(0, 3)
          .map((i) => `${i.path || '<root>'}: ${i.message}`)
          .join('; ');
        throw new Error(`not a valid AIViz trace — ${detail}`);
      }
      const trace = parsed as AnalysisTrace;
      openPanel();
      ui.setTrace(trace, {
        functions: [{ name: trace.program.function, line: 1, supported: true }],
        domains: [{ id: trace.domain.id, name: trace.domain.name }],
        selectedFunction: trace.program.function,
        selectedDomain: trace.domain.id,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`AIViz: ${message}`);
    }
  }

  let comparePanel: vscode.WebviewPanel | undefined;

  /** Builds the standalone HTML page for the compare panel's webview. */
  function compareHtml(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'compareWebview.js')
    );
    const styles = webview.asWebviewUri(
      vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview.css')
    );
    const nonce = makeNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styles}" rel="stylesheet">
<title>AIViz — Compare Domains</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  /**
   * Compares two domains on the same program and function.
   *
   * Opens as its own editor tab rather than beside the current editor — two
   * columns of comparison data need the width, matching the plan's original
   * "compare mode opens in a full editor tab" decision.
   */
  async function runCompare(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const doc =
      editor?.document.languageId === 'c'
        ? editor.document
        : vscode.workspace.textDocuments.find((d) => d.languageId === 'c');
    if (!doc) {
      void vscode.window.showWarningMessage('AIViz: open a C file first.');
      return;
    }

    try {
      const c = getClient();
      info ??= await c.initialize();
      const domains = info?.domains ?? [];
      if (domains.length < 2) {
        void vscode.window.showWarningMessage('AIViz: this provider offers fewer than two domains.');
        return;
      }

      const file = doc.uri.fsPath;
      const source = doc.getText();
      const { functions } = await c.listFunctions(file, source);
      const supported = functions.filter((f) => f.supported);
      if (supported.length === 0) {
        void vscode.window.showWarningMessage('AIViz: no supported functions in this file.');
        return;
      }

      let chosenFn: string;
      if (supported.length === 1) {
        chosenFn = supported[0]!.name;
      } else {
        const picked = await vscode.window.showQuickPick(
          supported.map((f) => f.name),
          { placeHolder: 'Function to compare' }
        );
        if (!picked) return; // user cancelled
        chosenFn = picked;
      }

      const domainA = await vscode.window.showQuickPick(
        domains.map((d) => d.name),
        { placeHolder: 'First domain to compare' }
      );
      if (!domainA) return;
      const remaining = domains.filter((d) => d.name !== domainA);
      const domainB = await vscode.window.showQuickPick(
        remaining.map((d) => d.name),
        { placeHolder: 'Second domain to compare' }
      );
      if (!domainB) return;

      const idOf = (name: string) => domains.find((d) => d.name === name)!.id;
      const cfg = vscode.workspace.getConfiguration('aiviz');
      const analyzeConfig = {
        wideningDelay: cfg.get('wideningDelay', 1),
        narrowing: cfg.get('narrowing', true),
        maxIterations: cfg.get('maxIterations', 200),
      };

      const [traceA, traceB] = await Promise.all([
        c.analyze({ file, source, function: chosenFn, domain: idOf(domainA), config: analyzeConfig }),
        c.analyze({ file, source, function: chosenFn, domain: idOf(domainB), config: analyzeConfig }),
      ]);

      for (const t of [traceA, traceB]) {
        const result = validateTrace(t);
        if (!result.valid) {
          const detail = result.issues
            .slice(0, 3)
            .map((i) => `${i.path || '<root>'}: ${i.message}`)
            .join('; ');
          throw new Error(`provider returned an invalid trace — ${detail}`);
        }
      }

      if (!comparePanel) {
        comparePanel = vscode.window.createWebviewPanel(
          'aiviz.comparePanel',
          `AIViz Compare: ${domainA} vs ${domainB}`,
          vscode.ViewColumn.Active,
          {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
          }
        );
        comparePanel.webview.html = compareHtml(comparePanel.webview);
        comparePanel.onDidDispose(() => {
          comparePanel = undefined;
        });
      } else {
        comparePanel.title = `AIViz Compare: ${domainA} vs ${domainB}`;
        comparePanel.reveal(vscode.ViewColumn.Active);
      }
      void comparePanel.webview.postMessage({ type: 'data', traceA, traceB });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`AIViz: ${message}`);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('aiviz.analyze', () => runAnalysis()),
    vscode.commands.registerCommand('aiviz.compare', () => runCompare()),
    vscode.commands.registerCommand('aiviz.loadTrace', () => loadTraceFile()),
    vscode.commands.registerCommand('aiviz.next', () =>
      ui.post({ type: 'command', action: 'next' })
    ),
    vscode.commands.registerCommand('aiviz.prev', () =>
      ui.post({ type: 'command', action: 'prev' })
    ),
    vscode.commands.registerCommand('aiviz.stepOverWidening', () =>
      ui.post({ type: 'command', action: 'stepOverWidening' })
    ),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor.document.languageId !== 'c') return;
      const line = e.selections[0]?.active.line;
      if (line !== undefined) ui.highlightLine(line + 1);
    }),
    // Re-run the analysis when the file it came from is saved, so the panel
    // never shows stale results next to edited source. Only the file already
    // being shown triggers this — saving an unrelated C file elsewhere in the
    // workspace should not steal the panel.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== 'c') return;
      if (!ui.hasSurface || doc.uri.fsPath !== ui.currentFile()) return;
      if (!vscode.workspace.getConfiguration('aiviz').get('analyzeOnSave', true)) return;

      const selection = ui.currentSelection();
      void runAnalysis(selection?.function, selection?.domain, { doc, silent: true });
    }),
    { dispose: () => client?.dispose() },
    { dispose: () => ui.dispose() }
  );
}

export function deactivate(): void {
  /* handled by subscriptions */
}
