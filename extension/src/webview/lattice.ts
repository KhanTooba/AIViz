import type { HasseDiagram, StepKind } from '@aiviz/trace-protocol';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number> = {}
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

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

export interface ChainItem {
  label: string;
  kind: StepKind;
  stepIndex: number;
}

/** Label on the connector between two consecutive chain items. Undefined
 * means "nothing notable" — just a plain downward step. */
const CHAIN_CONNECTOR_LABEL: Partial<Record<StepKind, string>> = {
  join: '⊔ join',
  widen: '▽ widen',
  narrow: '△ narrow',
  stabilize: '✓ stabilized',
};

const ROW_H = 54;
const COL_W = 54;
const NODE_R = 17;

interface Point {
  x: number;
  y: number;
}

/** Longest path from a root (no incoming edge) to each node — the standard
 * way to assign vertical rank in a Hasse diagram (⊥ at rank 0, ⊤ highest). */
function computeRanks(graph: HasseDiagram): Map<string, number> {
  const preds = new Map<string, string[]>(graph.nodes.map((n) => [n.id, []]));
  for (const [lower, upper] of graph.edges) preds.get(upper)?.push(lower);

  const rank = new Map<string, number>();
  const resolve = (id: string, visiting: Set<string>): number => {
    const cached = rank.get(id);
    if (cached !== undefined) return cached;
    const ps = preds.get(id) ?? [];
    if (ps.length === 0 || visiting.has(id)) {
      rank.set(id, 0);
      return 0;
    }
    visiting.add(id);
    const r = 1 + Math.max(...ps.map((p) => resolve(p, visiting)));
    rank.set(id, r);
    return r;
  };
  for (const n of graph.nodes) resolve(n.id, new Set());
  return rank;
}

function layoutHasse(graph: HasseDiagram): { positions: Map<string, Point>; width: number; height: number } {
  const rank = computeRanks(graph);
  const maxRank = Math.max(0, ...rank.values());

  const byRank = new Map<number, string[]>();
  for (const n of [...graph.nodes].sort((a, b) => a.label.localeCompare(b.label))) {
    const r = rank.get(n.id) ?? 0;
    (byRank.get(r) ?? byRank.set(r, []).get(r)!).push(n.id);
  }

  const positions = new Map<string, Point>();
  let maxAbsX = 0;
  for (const [r, ids] of byRank) {
    ids.forEach((id, i) => {
      const x = (i - (ids.length - 1) / 2) * COL_W;
      const y = (maxRank - r) * ROW_H + NODE_R + 4;
      positions.set(id, { x, y });
      maxAbsX = Math.max(maxAbsX, Math.abs(x));
    });
  }

  const width = maxAbsX * 2 + COL_W;
  const height = (maxRank + 1) * ROW_H + 8;
  // Shift every x by half the width so nothing is negative.
  for (const p of positions.values()) p.x += width / 2;
  return { positions, width, height };
}

/**
 * Renders either a Hasse diagram (finite lattices) or the ascending chain a
 * variable actually traversed (infinite lattices, where no finite diagram
 * exists). Exactly one of the two is meaningful for any given domain.
 */
export class LatticeView {
  constructor(private readonly host: HTMLElement) {}

  showEmpty(message: string): void {
    this.host.replaceChildren(h('p', { class: 'muted lattice-empty' }, message));
  }

  showHasse(graph: HasseDiagram, currentLabel: string | undefined): void {
    const { positions, width, height } = layoutHasse(graph);

    const svg = el('svg', { class: 'lattice-svg', viewBox: `0 0 ${width} ${height}` });
    svg.setAttribute('height', String(Math.min(height, 260)));
    const edgeLayer = el('g', { class: 'lattice-edges' });
    const nodeLayer = el('g', { class: 'lattice-nodes' });
    svg.append(edgeLayer, nodeLayer);

    for (const [lower, upper] of graph.edges) {
      const a = positions.get(lower);
      const b = positions.get(upper);
      if (!a || !b) continue;
      edgeLayer.appendChild(
        el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'lattice-edge' })
      );
    }

    for (const n of graph.nodes) {
      const p = positions.get(n.id);
      if (!p) continue;
      const isCurrent = n.label === currentLabel;
      const group = el('g', {
        class: `lattice-node${isCurrent ? ' lattice-node-current' : ''}`,
        transform: `translate(${p.x}, ${p.y})`,
      });
      group.appendChild(el('circle', { r: NODE_R, class: 'lattice-node-circle' }));
      const text = el('text', { class: 'lattice-node-label', y: 4 });
      text.textContent = n.label;
      group.appendChild(text);
      nodeLayer.appendChild(group);
    }

    this.host.replaceChildren(svg);
  }

  showChain(items: ChainItem[], currentStepIndex: number | undefined): void {
    const rows: HTMLElement[] = [];
    items.forEach((item, i) => {
      if (i > 0) {
        const label = CHAIN_CONNECTOR_LABEL[item.kind];
        const kindClass = label ? ` lattice-chain-connector-${item.kind}` : '';
        rows.push(
          h('div', { class: `lattice-chain-connector${kindClass}` }, label ? `↓ ${label}` : '↓')
        );
      }
      const isCurrent = item.stepIndex === currentStepIndex;
      rows.push(
        h(
          'div',
          { class: `lattice-chain-item${isCurrent ? ' lattice-chain-item-current' : ''}` },
          h('span', { class: 'lattice-chain-value' }, item.label),
          h('span', { class: 'muted lattice-chain-step' }, `step ${item.stepIndex + 1}`)
        )
      );
    });
    this.host.replaceChildren(h('div', { class: 'lattice-chain' }, ...rows));
  }
}
