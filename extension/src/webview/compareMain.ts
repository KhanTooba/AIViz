import { isBlockOwnState, type AnalysisTrace, type Step } from '@aiviz/trace-protocol';
import { CfgView, formatLines } from './cfg.js';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
};

const vscode = acquireVsCodeApi();

type ToWebview =
  | { type: 'data'; traceA: AnalysisTrace; traceB: AnalysisTrace }
  | { type: 'error'; message: string };

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function section(title: string, ...body: Node[]): HTMLElement {
  const details = h('details', { class: 'section', open: '' });
  details.append(h('summary', { class: 'section-title' }, title), ...body);
  return details;
}

interface IterState {
  repr: string;
  kind: Step['kind'];
}

/**
 * Per-iteration value of one variable at one block.
 *
 * Only steps where {@link isBlockOwnState} holds count — a `transfer`
 * without a `sourceSpan` is an edge guard for one specific successor, not
 * the block's own value, and must not be read as a point on this timeline.
 */
function iterationStates(
  trace: AnalysisTrace,
  blockId: string,
  varName: string
): Map<number, IterState> {
  const out = new Map<number, IterState>();
  for (const s of trace.steps) {
    if (s.blockId !== blockId || !isBlockOwnState(s)) continue;
    if (s.after.kind === 'bottom') {
      out.set(s.iteration, { repr: '⊥', kind: s.kind });
      continue;
    }
    const v = s.after.vars.find((x) => x.name === varName);
    if (v) out.set(s.iteration, { repr: v.repr, kind: s.kind });
  }
  return out;
}

const KIND_LABEL: Record<Step['kind'], string> = {
  transfer: 'transfer',
  join: 'join',
  widen: 'widen',
  narrow: 'narrow',
  stabilize: 'stabilized',
  push: 'push',
};

class CompareApp {
  private traceA?: AnalysisTrace;
  private traceB?: AnalysisTrace;
  private cfg?: CfgView;
  private selectedBlock?: string;
  private selectedVar?: string;

  private readonly root = document.getElementById('root')!;
  private readonly headerEl = h('div', { class: 'status' });
  private readonly cfgHost = h('div', { class: 'cfg-host' });
  private readonly pickersEl = h('div', { class: 'picker-row' });
  private readonly tableHost = h('div', { class: 'compare-table-host' });

  mount(): void {
    this.root.replaceChildren(
      section('Comparison', this.headerEl),
      section('Control flow graph: shared program', this.cfgHost),
      this.pickersEl,
      section('Per-iteration comparison', this.tableHost)
    );
    this.cfg = new CfgView(this.cfgHost, {
      onBlockClick: (blockId) => {
        this.selectedBlock = blockId;
        this.cfg?.setHighlight(blockId);
        this.render();
      },
    });
    vscode.postMessage({ type: 'ready' });
  }

  setData(traceA: AnalysisTrace, traceB: AnalysisTrace): void {
    this.traceA = traceA;
    this.traceB = traceB;
    this.selectedBlock =
      traceA.cfg.blocks.find((b) => b.isLoopHeader)?.blockId ?? traceA.cfg.entry;
    this.selectedVar = traceA.variables[0]?.name;
    this.cfg?.render(traceA.cfg, traceA.lineMap.blockToLines);
    this.cfg?.setHighlight(this.selectedBlock);
    this.render();
  }

  showError(message: string): void {
    this.headerEl.replaceChildren(h('p', { class: 'muted' }, message));
  }

  private render(): void {
    const a = this.traceA;
    const b = this.traceB;
    if (!a || !b) return;

    this.renderHeader(a, b);
    this.renderPickers(a);
    this.renderTable(a, b);
  }

  private renderHeader(a: AnalysisTrace, b: AnalysisTrace): void {
    const faster = a.summary.iterations === b.summary.iterations
      ? 'both needed the same number of iterations'
      : a.summary.iterations < b.summary.iterations
        ? `${a.domain.name} converged in fewer iterations than ${b.domain.name}`
        : `${b.domain.name} converged in fewer iterations than ${a.domain.name}`;

    this.headerEl.replaceChildren(
      h(
        'div',
        { class: 'status-line' },
        h('strong', {}, a.program.function),
        h('span', { class: 'muted' }, ` · ${a.program.file}`)
      ),
      h(
        'div',
        { class: 'compare-summary-row' },
        h(
          'div',
          { class: 'compare-summary-col' },
          h('div', { class: 'compare-domain-name' }, a.domain.name),
          h('div', { class: 'muted' }, `${a.summary.iterations} iteration(s) · ${a.summary.stepCount} steps`)
        ),
        h(
          'div',
          { class: 'compare-summary-col' },
          h('div', { class: 'compare-domain-name' }, b.domain.name),
          h('div', { class: 'muted' }, `${b.summary.iterations} iteration(s) · ${b.summary.stepCount} steps`)
        )
      ),
      h('div', { class: 'status-note' }, faster)
    );
  }

  private renderPickers(a: AnalysisTrace): void {
    const blockSelect = h('select', { class: 'picker' }) as HTMLSelectElement;
    for (const block of a.cfg.blocks) {
      const opt = h('option', { value: block.blockId }) as HTMLOptionElement;
      const label = block.label?.split('\n')[0] ?? block.blockId;
      opt.textContent = `${block.blockId}: ${label} (${formatLines(block.lines)})`;
      opt.selected = block.blockId === this.selectedBlock;
      blockSelect.append(opt);
    }
    blockSelect.onchange = () => {
      this.selectedBlock = blockSelect.value;
      this.cfg?.setHighlight(this.selectedBlock);
      this.render();
    };

    const varSelect = h('select', { class: 'picker' }) as HTMLSelectElement;
    for (const v of a.variables) {
      const opt = h('option', { value: v.name }) as HTMLOptionElement;
      opt.textContent = v.name;
      opt.selected = v.name === this.selectedVar;
      varSelect.append(opt);
    }
    varSelect.onchange = () => {
      this.selectedVar = varSelect.value;
      this.render();
    };

    this.pickersEl.replaceChildren(
      h('label', { class: 'picker-label' }, 'block', blockSelect),
      h('label', { class: 'picker-label' }, 'variable', varSelect)
    );
  }

  private renderTable(a: AnalysisTrace, b: AnalysisTrace): void {
    const blockId = this.selectedBlock;
    const varName = this.selectedVar;
    if (!blockId || !varName) {
      this.tableHost.replaceChildren();
      return;
    }

    const statesA = iterationStates(a, blockId, varName);
    const statesB = iterationStates(b, blockId, varName);
    const itersA = [...statesA.keys()];
    const itersB = [...statesB.keys()];

    if (itersA.length === 0 && itersB.length === 0) {
      this.tableHost.replaceChildren(
        h('p', { class: 'muted' }, `No recorded values for ${varName} at ${blockId}.`)
      );
      return;
    }

    const lastA = itersA.length > 0 ? Math.max(...itersA) : -1;
    const lastB = itersB.length > 0 ? Math.max(...itersB) : -1;
    const maxIter = Math.max(lastA, lastB, 0);

    const table = h('table', { class: 'compare-table' });
    table.append(
      h('tr', {}, h('th', {}, 'iteration'), h('th', {}, a.domain.name), h('th', {}, b.domain.name))
    );

    for (let it = 0; it <= maxIter; it++) {
      const cellA = this.cell(statesA.get(it), it > lastA, statesA.get(lastA), lastA);
      const cellB = this.cell(statesB.get(it), it > lastB, statesB.get(lastB), lastB);

      const differ =
        statesA.get(it) !== undefined &&
        statesB.get(it) !== undefined &&
        statesA.get(it)!.repr !== statesB.get(it)!.repr;

      table.append(
        h(
          'tr',
          { class: differ ? 'compare-row-differs' : '' },
          h('td', { class: 'compare-iter' }, String(it)),
          cellA,
          cellB
        )
      );
    }
    this.tableHost.replaceChildren(table);
  }

  private cell(
    state: IterState | undefined,
    frozen: boolean,
    lastKnown: IterState | undefined,
    lastIter: number
  ): HTMLElement {
    if (state) {
      return h(
        'td',
        {},
        h('span', { class: 'val val-value' }, state.repr),
        h('span', { class: 'muted compare-kind' }, ` ${KIND_LABEL[state.kind]}`)
      );
    }
    if (frozen && lastKnown) {
      return h(
        'td',
        { class: 'compare-frozen' },
        h('span', { class: 'val val-value' }, lastKnown.repr),
        h('span', { class: 'muted compare-kind' }, ` stabilized at iteration ${lastIter}`)
      );
    }
    return h('td', { class: 'muted' }, 'n/a');
  }
}

const app = new CompareApp();
app.mount();

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const msg = event.data;
  if (msg.type === 'data') app.setData(msg.traceA, msg.traceB);
  else app.showError(msg.message);
});
