import dagre from '@dagrejs/dagre';
import type { Block, Cfg, LineRange } from '@aiviz/trace-protocol';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface CfgViewOptions {
  onBlockClick(blockId: string): void;
}

interface Placed {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Geometry for one CFG box.
 *
 * A block's `label` carries one line per statement (see cfgbuilder.ts), so a
 * straight-line run of several statements with no branch between them must
 * show all of them, not just the first. Height and width are both derived
 * from the actual line count and content, and this is computed once up front
 * so the dagre sizing pass and the drawing pass never disagree.
 */
interface BlockLayout {
  lines: string[];
  overflow: number;
  sublabel: string;
  width: number;
  height: number;
}

const LINE_H = 15;
const PAD_TOP = 14;
const PAD_X = 10;
const MAX_LINES = 8;
const SUB_GAP = 8;
const SUB_H = 14;
const CHAR_W = 6.6;
const MIN_WIDTH = 120;
const MAX_WIDTH = 340;

function layoutBlock(b: Block, blockToLines: Record<string, LineRange[]>): BlockLayout {
  const raw = (b.label ?? b.blockId).split('\n');
  const lines = raw.slice(0, MAX_LINES);
  const overflow = Math.max(0, raw.length - lines.length);
  const sublabel = `${b.blockId} · ${formatLines(blockToLines[b.blockId] ?? b.lines)}`;
  const moreText = overflow > 0 ? `+${overflow} more` : '';

  const longest = Math.max(
    4,
    ...lines.map((l) => l.length),
    moreText.length,
    sublabel.length
  );
  const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, longest * CHAR_W + PAD_X * 2));

  const bodyLines = lines.length + (overflow > 0 ? 1 : 0);
  const height = PAD_TOP + bodyLines * LINE_H + SUB_GAP + SUB_H;

  return { lines, overflow, sublabel, width, height };
}

/** Renders a line set the way the protocol intends it to read: `7, 9–11`. */
export function formatLines(ranges: LineRange[]): string {
  if (ranges.length === 0) return 'n/a';
  const parts = ranges.map((r) => (r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`));
  return parts.length === 1 ? `line ${parts[0]}` : `lines ${parts.join(', ')}`;
}

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number> = {}
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/**
 * Interactive CFG rendered as hand-built SVG.
 *
 * Deliberately not Mermaid: click-to-highlight, per-block state overlays and
 * widening flags all need direct control over individual node elements.
 */
export class CfgView {
  private readonly svg: SVGSVGElement;
  private readonly viewport: SVGGElement;
  private readonly nodeEls = new Map<string, SVGGElement>();
  private scale = 1;
  private tx = 0;
  private ty = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly opts: CfgViewOptions
  ) {
    this.svg = el('svg', { class: 'cfg-svg' });
    this.viewport = el('g');

    const defs = el('defs');
    for (const [id, cls] of [
      ['arrow', 'cfg-arrow'],
      ['arrow-active', 'cfg-arrow-active'],
    ] as const) {
      const marker = el('marker', {
        id,
        viewBox: '0 0 10 10',
        refX: 9,
        refY: 5,
        markerWidth: 5,
        markerHeight: 5,
        orient: 'auto-start-reverse',
      });
      marker.appendChild(el('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: cls }));
      defs.appendChild(marker);
    }
    this.svg.appendChild(defs);
    this.svg.appendChild(this.viewport);
    this.host.appendChild(this.svg);

    this.installPanZoom();
  }

  private installPanZoom(): void {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    this.svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const next = Math.min(3, Math.max(0.25, this.scale * factor));
      // Zoom toward the pointer rather than the origin, or the graph runs away.
      const rect = this.svg.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      this.tx = px - ((px - this.tx) * next) / this.scale;
      this.ty = py - ((py - this.ty) * next) / this.scale;
      this.scale = next;
      this.applyTransform();
    });

    this.svg.addEventListener('pointerdown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      this.svg.setPointerCapture(e.pointerId);
      this.svg.classList.add('cfg-dragging');
    });
    this.svg.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      this.tx += e.clientX - lastX;
      this.ty += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      this.applyTransform();
    });
    const end = (e: PointerEvent) => {
      dragging = false;
      this.svg.releasePointerCapture?.(e.pointerId);
      this.svg.classList.remove('cfg-dragging');
    };
    this.svg.addEventListener('pointerup', end);
    this.svg.addEventListener('pointercancel', end);
  }

  private applyTransform(): void {
    this.viewport.setAttribute(
      'transform',
      `translate(${this.tx}, ${this.ty}) scale(${this.scale})`
    );
  }

  render(cfg: Cfg, blockToLines: Record<string, LineRange[]>): void {
    this.viewport.replaceChildren();
    this.nodeEls.clear();

    const g = new dagre.graphlib.Graph({ multigraph: false });
    g.setGraph({ rankdir: 'TB', nodesep: 24, ranksep: 36, marginx: 12, marginy: 12 });
    g.setDefaultEdgeLabel(() => ({}));

    for (const b of cfg.blocks) {
      const { width, height } = layoutBlock(b, blockToLines);
      g.setNode(b.blockId, { width, height });
    }
    for (const b of cfg.blocks) {
      for (const s of b.succs) g.setEdge(b.blockId, s);
    }
    dagre.layout(g);

    const edgeLayer = el('g', { class: 'cfg-edges' });
    const nodeLayer = el('g', { class: 'cfg-nodes' });
    this.viewport.appendChild(edgeLayer);
    this.viewport.appendChild(nodeLayer);

    const byId = new Map(cfg.blocks.map((b) => [b.blockId, b]));

    for (const e of g.edges()) {
      const pts = (g.edge(e).points ?? []) as { x: number; y: number }[];
      if (pts.length === 0) continue;
      const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
      // A back edge goes *upward* in the layout to a loop header. Testing only
      // "targets a loop header" would wrongly flag the loop's entry edge too.
      const from = g.node(e.v) as Placed | undefined;
      const to = g.node(e.w) as Placed | undefined;
      const isBack =
        byId.get(e.w)?.isLoopHeader === true &&
        from !== undefined &&
        to !== undefined &&
        to.y <= from.y;
      const path = el('path', {
        d,
        class: `cfg-edge${isBack ? ' cfg-edge-back' : ''}`,
        'marker-end': 'url(#arrow)',
      });
      path.dataset.from = e.v;
      path.dataset.to = e.w;
      edgeLayer.appendChild(path);
    }

    for (const b of cfg.blocks) {
      const pos = g.node(b.blockId) as Placed | undefined;
      if (!pos) continue;
      const x = pos.x - pos.width / 2;
      const y = pos.y - pos.height / 2;
      const layout = layoutBlock(b, blockToLines);

      const group = el('g', { class: 'cfg-node', transform: `translate(${x}, ${y})` });
      group.dataset.block = b.blockId;

      const classes = ['cfg-box'];
      if (b.isLoopHeader) classes.push('cfg-box-header');
      if (b.isEntry) classes.push('cfg-box-entry');
      if (b.isExit) classes.push('cfg-box-exit');
      group.appendChild(
        el('rect', {
          width: pos.width,
          height: pos.height,
          rx: 5,
          class: classes.join(' '),
        })
      );

      // Every statement in the block gets its own line, left-aligned like a
      // short code listing, rather than squashing them into one row.
      let ly = PAD_TOP;
      for (const line of layout.lines) {
        const t = el('text', { x: PAD_X, y: ly, class: 'cfg-stmt' });
        t.textContent = line;
        group.appendChild(t);
        ly += LINE_H;
      }
      if (layout.overflow > 0) {
        const more = el('text', { x: PAD_X, y: ly, class: 'cfg-stmt cfg-stmt-more' });
        more.textContent = `+${layout.overflow} more`;
        group.appendChild(more);
        ly += LINE_H;
      }

      group.appendChild(
        el('line', { x1: 0, y1: ly + SUB_GAP / 2 - 1, x2: pos.width, y2: ly + SUB_GAP / 2 - 1, class: 'cfg-divider' })
      );

      const sub = el('text', { x: PAD_X, y: pos.height - 4, class: 'cfg-sublabel' });
      sub.textContent = layout.sublabel;
      group.appendChild(sub);

      if (b.isLoopHeader) {
        const badge = el('text', { x: pos.width - 7, y: 14, class: 'cfg-badge' });
        badge.textContent = '↻';
        group.appendChild(badge);
      }

      group.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.opts.onBlockClick(b.blockId);
      });

      nodeLayer.appendChild(group);
      this.nodeEls.set(b.blockId, group);
    }

    this.fit(g.graph() as { width?: number; height?: number });
  }

  private fit(graph: { width?: number; height?: number }): void {
    const w = graph.width ?? 1;
    const h = graph.height ?? 1;
    const rect = this.host.getBoundingClientRect();
    const availW = Math.max(1, rect.width);
    // Cap the panel height so the CFG never crowds out the rest of the panel.
    const availH = Math.max(160, Math.min(340, h + 24));
    this.svg.setAttribute('height', String(availH));
    this.scale = Math.min(1, availW / (w + 24));
    this.tx = (availW - w * this.scale) / 2;
    this.ty = 8;
    this.applyTransform();
  }

  /**
   * `current` is the block the step is happening at; `related` are the other
   * blocks a clicked source line maps to. Keeping them visually distinct is the
   * point — one C line is often several program points.
   */
  setHighlight(current: string | undefined, related: readonly string[] = []): void {
    const relatedSet = new Set(related);
    for (const [id, node] of this.nodeEls) {
      node.classList.toggle('cfg-node-current', id === current);
      node.classList.toggle('cfg-node-related', id !== current && relatedSet.has(id));
    }
  }

  /** Flags blocks where widening was applied, so they read as loop-control points. */
  setWideningPoints(blocks: readonly string[]): void {
    const set = new Set(blocks);
    for (const [id, node] of this.nodeEls) {
      node.classList.toggle('cfg-node-widening', set.has(id));
    }
  }
}
