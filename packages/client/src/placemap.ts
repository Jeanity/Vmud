/**
 * The world as a graph of Places — V4, and the only view wider than the ground you are standing on.
 *
 * `M` frames the Place you are on. This is the other question: *where have I been, and how does it
 * join up?* `HANDOFF.md`'s first decision settles the form it may take — worldgen normalises
 * coordinates per zone and per level, so no two Places share a coordinate space and none of the 991
 * cross-zone exits is a geometric neighbour. **There is no plane to draw this on.** So it is a
 * diagram: nodes for Places, lines for links, laid out by how far you walked to reach them rather
 * than by where they are, because where they are is not a thing the world knows.
 *
 * ## Rings, not physics
 *
 * Nodes sit on concentric rings by their distance in *links* from where you are standing, and within
 * a ring they are ordered by their key. That makes the layout a pure function of the graph: the same
 * world always draws the same picture, and opening the map twice does not rearrange it. A
 * force-directed layout would look better on a big graph and would wobble on this one — and a map
 * that moves while you read it is worse than a plain one.
 *
 * Rings also carry the only spatial meaning available: the middle is here, and further out is
 * further away in the sense that actually matters, which is *how many boundaries you crossed*.
 *
 * ## SVG, and plain DOM around it
 *
 * Same reasoning as the admin panel's zone map: a few dozen shapes, every one wanting a label and a
 * tooltip, both free in the DOM and fiddly in a canvas. It also means this survives anything going
 * wrong inside Phaser, which is the property `LogPanel` and `AnnounceBanner` are here for.
 */

import type { Place, PlaceEdge, PlaceNode } from '@mygame/shared';

const NS = 'http://www.w3.org/2000/svg';

/** Ring spacing and node radius, in SVG units. The viewBox scales to whatever the pane gives us. */
const RING = 92;
const NODE_R = 26;

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function keyOf(place: Place): string {
  return `${place.zone}:${place.level}`;
}

export class PlaceMap {
  private readonly node: HTMLElement;
  private nodes: readonly PlaceNode[] = [];
  private edges: readonly PlaceEdge[] = [];
  private here: Place | undefined;
  private open = false;
  /**
   * Raised when the view is opened, so the server can answer with a current graph.
   *
   * The push on Place change cannot carry this: how much of a Place you have explored climbs with
   * every step inside it, so a graph pushed on arrival would under-report the room you are standing
   * in by however far you have walked since.
   */
  onOpen: (() => void) | undefined;

  constructor() {
    const node = document.getElementById('placemap');
    if (!node) throw new Error('placemap element missing from index.html');
    this.node = node;
    // Clicking the backdrop closes it. The same gesture as pressing the key again, and the one
    // everybody tries first on a full-screen overlay.
    this.node.addEventListener('click', (event) => {
      if (event.target === this.node) this.hide();
    });
  }

  /** Takes the latest graph. Redraws only while open — there is no point laying out a hidden pane. */
  update(nodes: readonly PlaceNode[], edges: readonly PlaceEdge[], here: Place): void {
    this.nodes = nodes;
    this.edges = edges;
    this.here = here;
    if (this.open) this.draw();
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  private show(): void {
    this.open = true;
    this.node.hidden = false;
    // Drawn from what is already in hand *and* refreshed: the view has to appear on the keypress
    // rather than a round trip later, and the numbers on it have to be right a moment afterwards.
    this.draw();
    this.onOpen?.();
  }

  hide(): void {
    this.open = false;
    this.node.hidden = true;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Breadth-first distance from where you are standing, in links.
   *
   * A Place you have been to but cannot reach through *seen* links is possible — you might have
   * arrived by an exit whose room you have since forgotten, or by an admin teleport — so anything
   * unreached lands in a final ring of its own rather than being dropped. A node the map knows about
   * and does not draw would be the worse bug.
   */
  private rings(): Map<string, number> {
    const depth = new Map<string, number>();
    if (!this.here) return depth;
    const neighbours = new Map<string, string[]>();
    for (const edge of this.edges) {
      const a = keyOf(edge.a);
      const b = keyOf(edge.b);
      if (!neighbours.has(a)) neighbours.set(a, []);
      if (!neighbours.has(b)) neighbours.set(b, []);
      neighbours.get(a)!.push(b);
      neighbours.get(b)!.push(a);
    }

    depth.set(keyOf(this.here), 0);
    let frontier = [keyOf(this.here)];
    for (let step = 1; frontier.length > 0; step++) {
      const next: string[] = [];
      for (const key of frontier) {
        for (const to of neighbours.get(key) ?? []) {
          if (depth.has(to)) continue;
          depth.set(to, step);
          next.push(to);
        }
      }
      frontier = next;
    }

    const unreached = this.nodes.map((n) => keyOf(n)).filter((key) => !depth.has(key));
    if (unreached.length > 0) {
      const beyond = Math.max(0, ...depth.values()) + 1;
      for (const key of unreached) depth.set(key, beyond);
    }
    return depth;
  }

  private draw(): void {
    this.node.replaceChildren();
    if (!this.here) return;

    const depth = this.rings();
    const byRing = new Map<number, string[]>();
    for (const node of this.nodes) {
      const ring = depth.get(keyOf(node)) ?? 0;
      if (!byRing.has(ring)) byRing.set(ring, []);
      byRing.get(ring)!.push(keyOf(node));
    }
    // Sorted, so the picture is a function of the graph and nothing else.
    for (const list of byRing.values()) list.sort();

    const at = new Map<string, { x: number; y: number }>();
    for (const [ring, keys] of byRing) {
      if (ring === 0) {
        for (const key of keys) at.set(key, { x: 0, y: 0 });
        continue;
      }
      // Spread around the circle, offset by the ring so successive rings do not line up into spokes.
      keys.forEach((key, i) => {
        const angle = (i / keys.length) * Math.PI * 2 + ring * 0.4;
        at.set(key, { x: Math.cos(angle) * RING * ring, y: Math.sin(angle) * RING * ring });
      });
    }

    const xs = [...at.values()].map((p) => p.x);
    const ys = [...at.values()].map((p) => p.y);
    const pad = NODE_R + 36;
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    const width = Math.max(...xs) - minX + pad;
    const height = Math.max(...ys) - minY + pad;

    const root = svg('svg', {
      viewBox: `${minX} ${minY} ${width} ${height}`,
      class: 'placemap-svg',
      role: 'img',
      'aria-label': 'Places you have visited and how they join',
    });

    // Lines first, so the discs sit on top of their own connections.
    for (const edge of this.edges) {
      const a = at.get(keyOf(edge.a));
      const b = at.get(keyOf(edge.b));
      if (!a || !b) continue;
      root.append(svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'placemap-link' }));
      // The direction travelled, at the midpoint. `up` and `down` are the interesting ones — they are
      // how a castle stacks — and they are the two a diagram cannot show any other way.
      const label = svg('text', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 4, class: 'placemap-via' });
      label.textContent = edge.via;
      root.append(label);
    }

    for (const node of this.nodes) {
      const key = keyOf(node);
      const point = at.get(key);
      if (!point) continue;
      const isHere = key === keyOf(this.here);

      const group = svg('g', { class: isHere ? 'placemap-node here' : 'placemap-node' });
      group.append(svg('circle', { cx: point.x, cy: point.y, r: NODE_R }));

      // The zone's name wrapped to two short lines, because "IceCrag Castle - Lower Level" beside a
      // 26px disc is a paragraph. Level goes underneath as a small tag: one zone is up to eleven
      // Places and the number is the only thing telling them apart.
      const words = node.zoneName.split(/\s+/);
      const half = Math.ceil(words.length / 2);
      const lines = words.length > 2 ? [words.slice(0, half).join(' '), words.slice(half).join(' ')] : [node.zoneName];
      lines.forEach((line, i) => {
        const text = svg('text', {
          x: point.x,
          y: point.y + NODE_R + 14 + i * 12,
          class: 'placemap-name',
        });
        text.textContent = line;
        group.append(text);
      });

      const level = svg('text', { x: point.x, y: point.y + 4, class: 'placemap-level' });
      level.textContent = `L${node.level}`;
      group.append(level);

      const title = svg('title', {});
      title.textContent =
        `${node.zoneName} — level ${node.level}\n` +
        `${node.rooms} room${node.rooms === 1 ? '' : 's'} explored` +
        (isHere ? '\nyou are here' : '');
      group.append(title);
      root.append(group);
    }

    const frame = document.createElement('div');
    frame.className = 'placemap-frame';
    const heading = document.createElement('h2');
    heading.textContent = `Where you have been — ${this.nodes.length} place${this.nodes.length === 1 ? '' : 's'}`;
    const hint = document.createElement('p');
    hint.textContent = 'Shift+M or Escape to close. Distance from the centre is how many boundaries you crossed to get there, not how far away it is.';
    frame.append(heading, root, hint);
    this.node.append(frame);
  }
}
