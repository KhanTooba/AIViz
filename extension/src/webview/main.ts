import { isBlockOwnState, type AnalysisTrace, type DisplayState, type Step, type VarValue } from '@aiviz/trace-protocol';
import { CfgView, formatLines } from './cfg.js';
import { LatticeView, type ChainItem } from './lattice.js';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
};

const vscode = acquireVsCodeApi();

interface SessionInfo {
  functions: { name: string; line: number; supported: boolean; reason?: string }[];
  domains: { id: string; name: string }[];
  selectedFunction: string;
  selectedDomain: string;
}

type ToWebview =
  | { type: 'trace'; trace: AnalysisTrace; session: SessionInfo }
  | { type: 'status'; message: string; busy?: boolean }
  | { type: 'command'; action: 'next' | 'prev' | 'stepOverWidening' }
  | { type: 'highlightLine'; line: number };

const STEP_LABELS: Record<Step['kind'], string> = {
  transfer: 'Transfer',
  join: 'Join',
  widen: 'Widening',
  narrow: 'Narrowing',
  push: 'Worklist',
  stabilize: 'Stabilized',
};

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

/** Variable lookup that tolerates a bottom state. */
function varsOf(state: DisplayState): Map<string, VarValue> {
  return new Map(state.vars.map((v) => [v.name, v]));
}

class App {
  private trace?: AnalysisTrace;
  private session?: SessionInfo;
  private index = 0;
  private cfg?: CfgView;
  private lattice?: LatticeView;
  private relatedBlocks: string[] = [];
  private selectedLatticeVar?: string;

  private readonly root = document.getElementById('root')!;
  private readonly statusEl = h('div', { class: 'status' });
  private readonly cfgHost = h('div', { class: 'cfg-host' });
  private readonly controlsEl = h('div', { class: 'controls' });
  private readonly explainEl = h('div', { class: 'explain' });
  private readonly stateEl = h('div', { class: 'state' });
  private readonly lossEl = h('div', { class: 'loss' });
  private readonly latticeHost = h('div', { class: 'lattice-host' });
  private readonly latticeVarSelect = h('select', { class: 'picker lattice-var-picker' }) as HTMLSelectElement;

  private readonly stepSection = section('Current step', this.explainEl);
  private readonly stateSection = section('Abstract state', this.stateEl);
  private readonly latticeSection = section(
    'Lattice',
    h(
      'label',
      { class: 'picker-label lattice-var-label' },
      'variable',
      this.latticeVarSelect
    ),
    this.latticeHost
  );

  mount(): void {
    this.root.replaceChildren(
      section('Status', this.statusEl),
      section('Control flow graph', this.cfgHost),
      this.controlsEl,
      this.stepSection,
      this.stateSection,
      this.latticeSection,
      this.lossEl
    );
    this.cfg = new CfgView(this.cfgHost, {
      onBlockClick: (blockId) => this.onBlockClick(blockId),
    });
    this.lattice = new LatticeView(this.latticeHost);
    this.latticeVarSelect.onchange = () => {
      this.selectedLatticeVar = this.latticeVarSelect.value;
      this.renderLattice();
    };
    this.installKeys();
    vscode.postMessage({ type: 'ready' });
  }

  private installKeys(): void {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'n') this.go(this.index + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'p') this.go(this.index - 1);
      else if (e.key === 'w') this.stepOverWidening();
    });
  }

  setTrace(trace: AnalysisTrace, session: SessionInfo): void {
    this.trace = trace;
    this.session = session;
    this.index = 0;
    this.relatedBlocks = [];
    this.selectedLatticeVar = trace.variables[0]?.name;
    this.cfg?.render(trace.cfg, trace.lineMap.blockToLines);
    this.cfg?.setWideningPoints(trace.summary.wideningPoints);
    this.render();
  }

  showMessage(message: string, busy = false): void {
    this.statusEl.replaceChildren(
      h('p', { class: busy ? 'muted busy' : 'muted' }, message)
    );
  }

  private get step(): Step | undefined {
    return this.trace?.steps[this.index];
  }

  go(index: number): void {
    if (!this.trace) return;
    const max = this.trace.steps.length - 1;
    this.index = Math.max(0, Math.min(max, index));
    this.render();
  }

  next(): void {
    this.go(this.index + 1);
  }

  prev(): void {
    this.go(this.index - 1);
  }

  /**
   * Jumps to the next widening step — the "step over" control.
   *
   * Widening points are where a loop's precision is decided, so skipping
   * between them is the coarse-grained way to read a fixpoint computation.
   */
  stepOverWidening(): void {
    if (!this.trace) return;
    const next = this.trace.summary.wideningStepIndices.find((i) => i > this.index);
    if (next !== undefined) {
      this.go(next);
    } else {
      // Past the last widening: land on the end, where the answer is.
      this.go(this.trace.steps.length - 1);
    }
  }

  private onBlockClick(blockId: string): void {
    const lines = this.trace?.lineMap.blockToLines[blockId] ?? [];
    vscode.postMessage({ type: 'revealBlock', blockId, lines });
    this.relatedBlocks = [blockId];
    this.cfg?.setHighlight(this.step?.blockId, this.relatedBlocks);
  }

  /** Editor cursor moved: light up every block that owns this source line. */
  highlightLine(line: number): void {
    if (!this.trace) return;
    const blocks = this.trace.lineMap.lineToBlocks[String(line)] ?? [];
    this.relatedBlocks = blocks;
    this.cfg?.setHighlight(this.step?.blockId, blocks);
    this.renderStatus();
  }

  private render(): void {
    if (!this.trace) return;
    this.renderStatus();

    // An unsupported program still has a valid trace, just no steps. Show the
    // reasons instead of an empty stepper with nothing to step through.
    const hasSteps = this.trace.steps.length > 0;
    this.stepSection.hidden = !hasSteps;
    this.stateSection.hidden = !hasSteps;
    this.latticeSection.hidden = !hasSteps;
    if (!hasSteps) {
      this.controlsEl.replaceChildren();
      this.explainEl.replaceChildren();
      this.stateEl.replaceChildren();
      this.lossEl.replaceChildren();
      this.latticeHost.replaceChildren();
      return;
    }

    this.renderControls();
    this.renderExplain();
    this.renderState();
    this.renderLoss();
    this.renderLattice();
    this.cfg?.setHighlight(this.step?.blockId, this.relatedBlocks);
    vscode.postMessage({
      type: 'stepChanged',
      index: this.index,
      blockId: this.step?.blockId ?? '',
      lines: this.trace.lineMap.blockToLines[this.step?.blockId ?? ''] ?? [],
    });
  }

  /** Function and domain pickers, driving re-analysis in the extension host. */
  private renderPickers(): HTMLElement | undefined {
    const s = this.session;
    if (!s) return undefined;

    const fnSelect = h('select', { class: 'picker' }) as HTMLSelectElement;
    for (const f of s.functions) {
      const opt = h('option', { value: f.name }) as HTMLOptionElement;
      opt.textContent = f.supported ? f.name : `${f.name}: unsupported`;
      opt.disabled = !f.supported;
      if (f.reason) opt.title = f.reason;
      opt.selected = f.name === s.selectedFunction;
      fnSelect.append(opt);
    }
    fnSelect.onchange = () =>
      vscode.postMessage({ type: 'selectFunction', name: fnSelect.value });

    const domainSelect = h('select', { class: 'picker' }) as HTMLSelectElement;
    for (const d of s.domains) {
      const opt = h('option', { value: d.id }) as HTMLOptionElement;
      opt.textContent = d.name;
      opt.selected = d.id === s.selectedDomain;
      domainSelect.append(opt);
    }
    domainSelect.onchange = () =>
      vscode.postMessage({ type: 'selectDomain', id: domainSelect.value });

    return h(
      'div',
      { class: 'picker-row' },
      h('label', { class: 'picker-label' }, 'function', fnSelect),
      h('label', { class: 'picker-label' }, 'domain', domainSelect)
    );
  }

  private renderStatus(): void {
    const t = this.trace;
    if (!t) return;
    const s = t.summary;

    const verdict = s.converged
      ? h('span', { class: 'badge badge-ok' }, `Converged in ${s.iterations} iterations`)
      : h(
          'span',
          { class: 'badge badge-warn' },
          s.notConvergedReason ?? 'Did not converge'
        );

    const rows: Node[] = [];
    const pickers = this.renderPickers();
    if (pickers) rows.push(pickers);

    // Diagnostics mean the program was rejected; lead with why.
    if (t.diagnostics.length > 0) {
      rows.push(
        h(
          'div',
          { class: 'diagnostics' },
          h('div', { class: 'diag-title' }, 'This program is not supported'),
          ...t.diagnostics.map((d) =>
            h(
              'div',
              { class: 'diag' },
              h('span', { class: 'diag-line' }, `line ${d.line}`),
              h('span', {}, ` ${d.message}`)
            )
          )
        )
      );
      this.statusEl.replaceChildren(...rows);
      return;
    }

    rows.push(
      h('div', { class: 'status-line' }, verdict),
      h(
        'div',
        { class: 'status-line muted' },
        `${s.stepCount} steps · ${s.wideningStepIndices.length} widening step(s) · ` +
          `${t.cfg.blocks.length} blocks`
      )
    );

    if (this.relatedBlocks.length > 1) {
      rows.push(
        h(
          'div',
          { class: 'status-note' },
          `This source line maps to ${this.relatedBlocks.length} program points: ` +
            this.relatedBlocks.join(', ') +
            ': one line of C is often several distinct points in the CFG.'
        )
      );
    }
    this.statusEl.replaceChildren(...rows);
  }

  private renderControls(): void {
    const t = this.trace;
    if (!t) return;
    const last = t.steps.length - 1;

    const prev = h('button', { class: 'btn' }, '◀ Prev');
    prev.disabled = this.index <= 0;
    prev.onclick = () => this.go(this.index - 1);

    const next = h('button', { class: 'btn btn-primary' }, 'Next ▶');
    next.disabled = this.index >= last;
    next.onclick = () => this.go(this.index + 1);

    const over = h('button', { class: 'btn' }, '⏭ Widening');
    over.title = 'Jump to the next widening step';
    over.onclick = () => this.stepOverWidening();

    const scrub = h('input', { class: 'scrub', type: 'range' }) as HTMLInputElement;
    scrub.min = '0';
    scrub.max = String(last);
    scrub.value = String(this.index);
    scrub.oninput = () => this.go(Number(scrub.value));

    this.controlsEl.replaceChildren(
      h('div', { class: 'btn-row' }, prev, next, over),
      h(
        'div',
        { class: 'scrub-row' },
        scrub,
        h('span', { class: 'counter' }, `${this.index + 1} / ${t.steps.length}`)
      )
    );
  }

  private renderExplain(): void {
    const step = this.step;
    const t = this.trace;
    if (!step || !t) return;

    const lines = t.lineMap.blockToLines[step.blockId] ?? [];
    const header = h(
      'div',
      { class: 'step-header' },
      h('span', { class: `chip chip-${step.kind}` }, STEP_LABELS[step.kind]),
      h('span', { class: 'muted' }, ` ${step.blockId} · ${formatLines(lines)}`),
      h('span', { class: 'muted right' }, `iteration ${step.iteration}`)
    );

    const body = h('p', { class: 'narration' }, step.explanation);
    const children: Node[] = [header, body];

    // Join/widen/narrow are the steps whose operands matter, so show them.
    if (step.inputs && step.inputs.length > 0) {
      const opLabel = step.kind === 'join' ? 'joining' : 'operands';
      children.push(
        h(
          'div',
          { class: 'operands' },
          h('div', { class: 'operands-title muted' }, opLabel),
          ...step.inputs.map((inp, i) =>
            h(
              'div',
              { class: 'operand' },
              h('span', { class: 'operand-idx muted' }, `${i + 1}.`),
              this.renderStateInline(inp)
            )
          )
        )
      );
    }
    this.explainEl.replaceChildren(...children);
  }

  private renderStateInline(state: DisplayState): HTMLElement {
    if (state.kind === 'bottom') {
      return h('span', { class: 'val val-bottom' }, '⊥ unreachable');
    }
    const span = h('span', { class: 'inline-state' });
    state.vars.forEach((v, i) => {
      if (i > 0) span.append(', ');
      span.append(
        h('span', { class: 'vname' }, v.name),
        ' ↦ ',
        h('span', { class: `val val-${v.kind}` }, v.repr)
      );
    });
    return span;
  }

  private renderState(): void {
    const step = this.step;
    const t = this.trace;
    if (!step || !t) return;

    if (step.after.kind === 'bottom') {
      this.stateEl.replaceChildren(
        h('p', { class: 'muted' }, '⊥: this program point is unreachable.')
      );
      return;
    }

    const before = varsOf(step.before);
    const changed = new Set(step.changed ?? []);
    const table = h('table', { class: 'state-table' });
    table.append(
      h(
        'tr',
        {},
        h('th', {}, 'var'),
        h('th', {}, 'before'),
        h('th', {}, ''),
        h('th', {}, 'after')
      )
    );

    for (const v of step.after.vars) {
      const prev = before.get(v.name);
      const didChange = changed.has(v.name) || (prev && prev.repr !== v.repr);
      const row = h('tr', { class: didChange ? 'row-changed' : '' });
      row.append(
        h('td', { class: 'vname' }, v.name),
        h('td', { class: `val val-${prev?.kind ?? 'top'}` }, prev?.repr ?? 'n/a'),
        h('td', { class: 'arrow' }, didChange ? '→' : ''),
        h('td', { class: `val val-${v.kind}` }, v.repr)
      );
      table.append(row);
    }

    const constraints = step.after.constraints;
    if (constraints && constraints.length > 0) {
      const list = h('ul', { class: 'relations-list' });
      for (const c of constraints) list.append(h('li', { class: 'relation' }, c));
      const relations = h(
        'div',
        { class: 'relations' },
        h('div', { class: 'relations-title muted' }, 'Relations'),
        list
      );
      this.stateEl.replaceChildren(table, relations);
    } else {
      this.stateEl.replaceChildren(table);
    }
  }

  /**
   * The widening-loss panel. Only meaningful on widen steps, and deliberately
   * spells out what plain join would have given — that contrast is the lesson.
   */
  private renderLoss(): void {
    const step = this.step;
    if (!step || step.kind !== 'widen' || !step.loss || step.loss.length === 0) {
      this.lossEl.replaceChildren();
      return;
    }

    const items = step.loss.map((l) =>
      h(
        'div',
        { class: 'loss-item' },
        h(
          'div',
          { class: 'loss-head' },
          h('span', { class: 'vname' }, l.name),
          h('span', { class: 'muted' }, `: ${l.lostBound} bound discarded`)
        ),
        h(
          'div',
          { class: 'loss-row' },
          h('span', { class: 'muted' }, 'join alone would give '),
          h('span', { class: 'val val-joined' }, l.joined),
          h('span', { class: 'muted' }, ' but widening gives '),
          h('span', { class: 'val val-widened' }, l.widened)
        ),
        h('p', { class: 'loss-msg' }, l.message)
      )
    );

    this.lossEl.replaceChildren(section('Precision lost to widening', ...items));
  }

  /**
   * Finite lattices (Sign) get their true Hasse diagram, with the current
   * value's node highlighted. Infinite lattices (Intervals, Constant
   * Propagation) have no finite diagram to draw, so the ascending chain a
   * variable actually traversed is plotted instead — the fragment of the
   * lattice the analysis actually walked, scoped to the block the current
   * step is at, since that is where widening decisions are made.
   */
  private renderLattice(): void {
    const t = this.trace;
    const step = this.step;
    if (!t || !step || !this.lattice) return;

    this.syncLatticeVarPicker(t);
    const varName = this.selectedLatticeVar;
    if (!varName) {
      this.lattice.showEmpty('This function has no variables to track.');
      return;
    }

    const graph = t.domain.latticeGraph;
    if (graph) {
      const current = step.after.vars.find((v) => v.name === varName)?.repr;
      this.lattice.showHasse(graph, current);
      return;
    }

    const items: ChainItem[] = t.steps
      .filter((s) => s.blockId === step.blockId && isBlockOwnState(s))
      .flatMap((s) => {
        const v = s.after.vars.find((x) => x.name === varName);
        return v ? [{ label: v.repr, kind: s.kind, stepIndex: s.index }] : [];
      });

    if (items.length === 0) {
      this.lattice.showEmpty(`No recorded values for ${varName} at ${step.blockId} yet.`);
      return;
    }
    this.lattice.showChain(items, this.index);
  }

  private syncLatticeVarPicker(t: AnalysisTrace): void {
    const names = t.variables.map((v) => v.name);
    const current = Array.from(this.latticeVarSelect.options, (o) => o.value);
    if (current.join(',') === names.join(',')) {
      this.latticeVarSelect.value = this.selectedLatticeVar ?? names[0] ?? '';
      return;
    }
    this.latticeVarSelect.replaceChildren(
      ...names.map((name) => {
        const opt = h('option', { value: name }) as HTMLOptionElement;
        opt.textContent = name;
        opt.selected = name === this.selectedLatticeVar;
        return opt;
      })
    );
  }
}

const app = new App();
app.mount();

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'trace':
      app.setTrace(msg.trace, msg.session);
      break;
    case 'status':
      app.showMessage(msg.message, msg.busy ?? false);
      break;
    case 'highlightLine':
      app.highlightLine(msg.line);
      break;
    case 'command':
      if (msg.action === 'next') app.next();
      else if (msg.action === 'prev') app.prev();
      else app.stepOverWidening();
      break;
  }
});
