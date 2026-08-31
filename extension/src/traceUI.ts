/**
 * Shared rendering host for the trace UI.
 *
 * The same webview content is used from two places — a view in the sidebar and
 * a panel beside the editor — so the message plumbing lives here rather than
 * being duplicated per surface. Both stay in sync because every attached
 * webview receives the same broadcasts.
 */

import * as vscode from 'vscode';
import type { AnalysisTrace, FunctionInfo, LineRange } from '@aiviz/trace-protocol';

export interface SessionInfo {
  functions: FunctionInfo[];
  domains: { id: string; name: string }[];
  selectedFunction: string;
  selectedDomain: string;
}

export type FromWebview =
  | { type: 'ready' }
  | { type: 'stepChanged'; index: number; blockId: string; lines: LineRange[] }
  | { type: 'revealBlock'; blockId: string; lines: LineRange[] }
  | { type: 'selectFunction'; name: string }
  | { type: 'selectDomain'; id: string };

export type ToWebview =
  | { type: 'trace'; trace: AnalysisTrace; session: SessionInfo }
  | { type: 'status'; message: string; busy?: boolean }
  | { type: 'command'; action: 'next' | 'prev' | 'stepOverWidening' }
  | { type: 'highlightLine'; line: number };

const blockDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('editor.selectionHighlightBackground'),
  isWholeLine: true,
  overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.findMatchForeground'),
  overviewRulerLane: vscode.OverviewRulerLane.Center,
});

export interface Surface {
  webview: vscode.Webview;
  reveal(): void;
}

export class TraceUI {
  private readonly surfaces = new Set<Surface>();
  private trace?: AnalysisTrace;
  private session?: SessionInfo;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly reanalyze: (fn?: string, domain?: string) => Promise<void>
  ) {}

  attach(surface: Surface, onDispose: vscode.Event<unknown>): void {
    this.surfaces.add(surface);
    onDispose(() => this.surfaces.delete(surface));

    surface.webview.onDidReceiveMessage((msg: FromWebview) => {
      switch (msg.type) {
        case 'ready':
          if (this.trace && this.session) {
            this.postTo(surface, { type: 'trace', trace: this.trace, session: this.session });
          } else {
            this.postTo(surface, {
              type: 'status',
              message:
                'Open a C source (.c) or textual LLVM IR (.ll) file and run “AIViz: Analyze Current Function”.',
            });
          }
          break;
        case 'stepChanged':
        case 'revealBlock':
          void this.revealLines(msg.lines);
          break;
        case 'selectFunction':
          void this.reanalyze(msg.name, this.session?.selectedDomain);
          break;
        case 'selectDomain':
          void this.reanalyze(this.session?.selectedFunction, msg.id);
          break;
      }
    });
  }

  get hasSurface(): boolean {
    return this.surfaces.size > 0;
  }

  currentFile(): string | undefined {
    return this.trace?.program.file;
  }

  /** The function and domain currently shown — used to keep both selected
   * across a re-analysis triggered by saving the file. */
  currentSelection(): { function: string; domain: string } | undefined {
    if (!this.session) return undefined;
    return { function: this.session.selectedFunction, domain: this.session.selectedDomain };
  }

  setTrace(trace: AnalysisTrace, session: SessionInfo): void {
    this.trace = trace;
    this.session = session;
    void vscode.commands.executeCommand('setContext', 'aiviz.traceLoaded', true);
    this.post({ type: 'trace', trace, session });
    for (const s of this.surfaces) s.reveal();
  }

  setStatus(message: string, busy = false): void {
    this.post({ type: 'status', message, busy });
  }

  highlightLine(line: number): void {
    if (this.trace) this.post({ type: 'highlightLine', line });
  }

  post(msg: ToWebview): void {
    for (const s of this.surfaces) this.postTo(s, msg);
  }

  private postTo(surface: Surface, msg: ToWebview): void {
    void surface.webview.postMessage(msg);
  }

  private async revealLines(ranges: LineRange[]): Promise<void> {
    if (!this.trace || ranges.length === 0) return;
    const editor = await this.editorForTrace();
    if (!editor) return;

    const decorations = ranges.map(
      (r) => new vscode.Range(Math.max(0, r.start - 1), 0, Math.max(0, r.end - 1), 1e9)
    );
    editor.setDecorations(blockDecoration, decorations);
    if (decorations[0]) {
      editor.revealRange(decorations[0], vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  }

  private async editorForTrace(): Promise<vscode.TextEditor | undefined> {
    if (!this.trace) return undefined;
    const target = this.trace.program.file;
    const open = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === target);
    if (open) return open;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      return await vscode.window.showTextDocument(doc, {
        preserveFocus: true,
        viewColumn: vscode.ViewColumn.One,
      });
    } catch {
      return vscode.window.activeTextEditor;
    }
  }

  html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')
    );
    const styles = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.css')
    );
    const nonce = makeNonce();

    // Strict CSP: no remote loads at all, which is why every asset is bundled.
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${styles}" rel="stylesheet">
<title>AIViz Analysis Trace</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    blockDecoration.dispose();
  }
}

export function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
