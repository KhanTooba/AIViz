import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { AnalysisTrace, ProviderInfo } from '@aiviz/trace-protocol';
import { validateTrace } from '@aiviz/trace-protocol';
import { ProviderClient } from './providerClient.js';
import { domainManifestTemplate, domainModuleTemplate } from './domainScaffold.js';
import {
  BUNDLED_PROVIDERS,
  providerForDocument,
  resolveProviderLaunch,
  supportedDocumentDescription,
  type BundledProvider,
} from './providerRegistry.js';
import { TraceUI, makeNonce } from './traceUI.js';

export function activate(context: vscode.ExtensionContext): void {
  const clients = new Map<string, ProviderClient>();
  const providerInfos = new Map<string, ProviderInfo>();
  const lastDomains = new Map<string, string>();
  const reportedDiagnostics = new Map<string, string>();
  const domainOutput = vscode.window.createOutputChannel('AIViz Domains');
  let domainWatchers: vscode.Disposable[] = [];
  let domainChangeTimer: NodeJS.Timeout | undefined;
  let domainReloadPromptVisible = false;
  let panel: vscode.WebviewPanel | undefined;
  // Bumped on every analysis; a request only applies its result if it is still
  // the most recent one requested. Without this, a slow analysis triggered by
  // an earlier save could overwrite the result of a faster, more recent one.
  let generation = 0;

  const ui = new TraceUI(context.extensionUri, (fn, domain) => runAnalysis(fn, domain));

  /** Only trusted workspace folders are passed to provider subprocesses. The
   * extension host itself never imports a workspace domain module. */
  const workspaceDomainDirectories = (): string[] => {
    if (!vscode.workspace.isTrusted) return [];
    return (vscode.workspace.workspaceFolders ?? []).map((folder) =>
      path.join(folder.uri.fsPath, '.aiviz', 'domains')
    );
  };

  const disposeProviderClients = (): void => {
    for (const client of clients.values()) client.dispose();
    clients.clear();
    providerInfos.clear();
    reportedDiagnostics.clear();
  };

  const showDomainDiagnostics = (): void => {
    domainOutput.show(true);
  };

  const reportDomainDiagnostics = (provider: BundledProvider, info: ProviderInfo): void => {
    const diagnostics = info.domainDiagnostics ?? [];
    const signature = JSON.stringify(diagnostics);
    if (reportedDiagnostics.get(provider.id) === signature) return;
    reportedDiagnostics.set(provider.id, signature);

    const workspaceCount = info.domains.filter((domain) => domain.origin === 'workspace').length;
    domainOutput.appendLine(
      `${provider.name}: ${workspaceCount} workspace domain${workspaceCount === 1 ? '' : 's'} loaded.`
    );
    for (const diagnostic of diagnostics) {
      domainOutput.appendLine(
        `[${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}` +
          (diagnostic.path ? ` (${diagnostic.path})` : '')
      );
    }
    if (diagnostics.length > 0) {
      void vscode.window
        .showWarningMessage(
          `AIViz: ${diagnostics.length} workspace domain${diagnostics.length === 1 ? '' : 's'} could not be loaded for ${provider.name}.`,
          'Show Domain Diagnostics'
        )
        .then((choice) => {
          if (choice === 'Show Domain Diagnostics') showDomainDiagnostics();
        });
    }
  };

  const getClient = (provider: BundledProvider): ProviderClient => {
    const existing = clients.get(provider.id);
    if (existing) return existing;

    const launch = resolveProviderLaunch(
      context.extensionPath,
      provider,
      workspaceDomainDirectories()
    );
    if (!launch) {
      throw new Error(
        `could not find the bundled ${provider.name} provider — run \`npm run build\` in the repo root.`
      );
    }
    const client = new ProviderClient({
      command: process.execPath,
      args: [launch.entry],
      env: launch.env,
    });
    clients.set(provider.id, client);
    return client;
  };

  const getProvider = async (
    provider: BundledProvider
  ): Promise<{ client: ProviderClient; info: ProviderInfo }> => {
    const client = getClient(provider);
    let info = providerInfos.get(provider.id);
    if (!info) {
      info = await client.initialize();
      if (info.id !== provider.id) {
        client.dispose();
        clients.delete(provider.id);
        throw new Error(
          `bundled provider identity mismatch: expected ${provider.id}, received ${info.id}`
        );
      }
      providerInfos.set(provider.id, info);
      reportDomainDiagnostics(provider, info);
    }
    return { client, info };
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
   * @param options.silent Used for the save-triggered refresh: no "open a
   *   supported file first" warning if the saved file isn't the one being analyzed, and
   *   failures are shown in the panel rather than as an error toast — an
   *   unsupported program is an expected outcome of editing, not a bug.
   */
  async function runAnalysis(
    fnName?: string,
    domainId?: string,
    options: { doc?: vscode.TextDocument; silent?: boolean } = {}
  ): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const panelRequested = fnName !== undefined || domainId !== undefined;
    const currentTraceDocument = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.fsPath === ui.currentFile() && providerForDocument(doc) !== undefined
    );
    const doc =
      options.doc ??
      (panelRequested ? currentTraceDocument : undefined) ??
      (editor && providerForDocument(editor.document) ? editor.document : currentTraceDocument);

    if (!doc) {
      if (!options.silent) {
        void vscode.window.showWarningMessage(
          `AIViz: open a supported ${supportedDocumentDescription()} first.`
        );
      }
      return;
    }
    const provider = providerForDocument(doc);
    if (!provider) return;

    // Always bring the panel to front for a manual run; a save-triggered
    // refresh should update in place without stealing focus or popping the
    // panel open if the user closed it.
    if (!options.silent) openPanel();
    if (!ui.hasSurface) return;

    const myGeneration = ++generation;
    const file = doc.uri.fsPath;
    const source = doc.getText();

    try {
      const { client: c, info } = await getProvider(provider);

      ui.setStatus(
        options.silent ? `Re-analysing with ${info.name}…` : `Analysing with ${info.name}…`,
        true
      );
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

      const requestedDomain = domainId ?? lastDomains.get(provider.id) ?? 'intervals';
      const domain = info.domains.some((candidate) => candidate.id === requestedDomain)
        ? requestedDomain
        : info.domains[0]?.id;
      if (!domain) throw new Error(`${info.name} did not advertise any abstract domains`);
      lastDomains.set(provider.id, domain);

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
        domains: info.domains.map((d) => ({ id: d.id, name: d.name })),
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
      editor && providerForDocument(editor.document)
        ? editor.document
        : vscode.workspace.textDocuments.find((candidate) =>
            providerForDocument(candidate)
          );
    if (!doc) {
      void vscode.window.showWarningMessage(
        `AIViz: open a supported ${supportedDocumentDescription()} first.`
      );
      return;
    }
    const provider = providerForDocument(doc);
    if (!provider) return;

    try {
      const { client: c, info } = await getProvider(provider);
      const domains = info.domains;
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

  /** Restart providers rather than importing changed workspace code in place.
   * That clears Node's module cache and makes a reload deterministic. */
  async function reloadDomains(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        'AIViz: workspace domains are disabled until you trust this workspace.'
      );
      return;
    }

    generation++;
    disposeProviderClients();
    domainOutput.clear();
    const initialized = await Promise.allSettled(BUNDLED_PROVIDERS.map((provider) => getProvider(provider)));
    const failures = initialized.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (failures.length > 0) {
      const detail = failures
        .map((failure) =>
          failure.reason instanceof Error ? failure.reason.message : String(failure.reason)
        )
        .join('; ');
      void vscode.window.showErrorMessage(`AIViz: could not reload domains — ${detail}`);
      return;
    }

    const current = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.fsPath === ui.currentFile() && providerForDocument(doc) !== undefined
    );
    if (current && ui.hasSurface) {
      const selection = ui.currentSelection();
      await runAnalysis(selection?.function, selection?.domain, { doc: current, silent: true });
    }
    void vscode.window.showInformationMessage('AIViz: workspace domains reloaded.');
  }

  async function createWorkspaceDomain(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        'AIViz: trust the workspace before creating a domain that the providers will execute.'
      );
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      void vscode.window.showWarningMessage('AIViz: open a workspace folder before creating a domain.');
      return;
    }
    const folder =
      folders.length === 1
        ? folders[0]!
        : await vscode.window.showQuickPick(
            folders.map((candidate) => ({ label: candidate.name, folder: candidate })),
            { placeHolder: 'Workspace folder for the new AIViz domain' }
          ).then((picked) => picked?.folder);
    if (!folder) return;

    const id = await vscode.window.showInputBox({
      prompt: 'Domain ID',
      placeHolder: 'zero-nonzero',
      validateInput: (value) =>
        /^[a-z][a-z0-9-]*$/.test(value) ? undefined : 'Use lowercase letters, digits, and hyphens.',
    });
    if (!id) return;
    const name = await vscode.window.showInputBox({
      prompt: 'Domain display name',
      value: id.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()),
      validateInput: (value) => (value.trim() ? undefined : 'A display name is required.'),
    });
    if (!name) return;

    const directory = vscode.Uri.joinPath(folder.uri, '.aiviz', 'domains', id);
    try {
      await vscode.workspace.fs.stat(directory);
      void vscode.window.showWarningMessage(`AIViz: ${directory.fsPath} already exists.`);
      return;
    } catch {
      // Expected for a new domain; createDirectory also creates the parents.
    }
    try {
      await vscode.workspace.fs.createDirectory(directory);
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(directory, 'domain.json'),
        Buffer.from(domainManifestTemplate(id, name.trim()), 'utf8')
      );
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(directory, 'domain.mjs'),
        Buffer.from(domainModuleTemplate(id, name.trim()), 'utf8')
      );
      const choice = await vscode.window.showInformationMessage(
        `AIViz: created ${id}. Reload domains to make it selectable.`,
        'Reload Domains',
        'Open domain.mjs'
      );
      if (choice === 'Reload Domains') await reloadDomains();
      if (choice === 'Open domain.mjs') {
        await vscode.window.showTextDocument(vscode.Uri.joinPath(directory, 'domain.mjs'));
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `AIViz: could not create domain — ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const queueDomainReloadPrompt = (): void => {
    if (!vscode.workspace.isTrusted) return;
    if (domainChangeTimer) clearTimeout(domainChangeTimer);
    domainChangeTimer = setTimeout(() => {
      domainChangeTimer = undefined;
      if (domainReloadPromptVisible) return;
      domainReloadPromptVisible = true;
      void vscode.window
        .showInformationMessage(
          'AIViz: workspace domain files changed. Reload domains to use the new definitions.',
          'Reload Domains'
        )
        .then(async (choice) => {
          if (choice === 'Reload Domains') await reloadDomains();
        })
        .then(() => {
          domainReloadPromptVisible = false;
        }, () => {
          domainReloadPromptVisible = false;
        });
    }, 300);
  };

  const resetDomainWatchers = (): void => {
    for (const watcher of domainWatchers) watcher.dispose();
    domainWatchers = [];
    if (!vscode.workspace.isTrusted) return;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, '.aiviz/domains/**')
      );
      domainWatchers.push(
        watcher,
        watcher.onDidCreate(queueDomainReloadPrompt),
        watcher.onDidChange(queueDomainReloadPrompt),
        watcher.onDidDelete(queueDomainReloadPrompt)
      );
    }
  };

  resetDomainWatchers();
  if (!vscode.workspace.isTrusted) {
    domainOutput.appendLine(
      'Workspace is untrusted: AIViz built-in domains remain available; workspace domains are disabled.'
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('aiviz.analyze', () => runAnalysis()),
    vscode.commands.registerCommand('aiviz.compare', () => runCompare()),
    vscode.commands.registerCommand('aiviz.loadTrace', () => loadTraceFile()),
    vscode.commands.registerCommand('aiviz.createDomain', () => createWorkspaceDomain()),
    vscode.commands.registerCommand('aiviz.reloadDomains', () => reloadDomains()),
    vscode.commands.registerCommand('aiviz.showDomainDiagnostics', () => showDomainDiagnostics()),
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
      if (!providerForDocument(e.textEditor.document)) return;
      if (e.textEditor.document.uri.fsPath !== ui.currentFile()) return;
      const line = e.selections[0]?.active.line;
      if (line !== undefined) ui.highlightLine(line + 1);
    }),
    // Re-run the analysis when the file it came from is saved, so the panel
    // never shows stale results next to edited source. Only the file already
    // being shown triggers this — saving an unrelated supported file elsewhere in the
    // workspace should not steal the panel.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!providerForDocument(doc)) return;
      if (!ui.hasSurface || doc.uri.fsPath !== ui.currentFile()) return;
      if (!vscode.workspace.getConfiguration('aiviz').get('analyzeOnSave', true)) return;

      const selection = ui.currentSelection();
      void runAnalysis(selection?.function, selection?.domain, { doc, silent: true });
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      resetDomainWatchers();
      queueDomainReloadPrompt();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      resetDomainWatchers();
      void reloadDomains();
    }),
    {
      dispose: () => {
        if (domainChangeTimer) clearTimeout(domainChangeTimer);
        for (const watcher of domainWatchers) watcher.dispose();
        disposeProviderClients();
      },
    },
    domainOutput,
    { dispose: () => ui.dispose() }
  );
}

export function deactivate(): void {
  /* handled by subscriptions */
}
