/**
 * The three lines of DOM helper this panel needs, instead of a framework.
 *
 * The panel is tables and forms over a small API; a virtual DOM would be more code than the panel.
 * Sections re-render by replacing their own container's children — coarse, and exactly fine at this
 * size.
 */

type Child = Node | string | null | undefined;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((event: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'function') {
      node.addEventListener(key.replace(/^on/, ''), value);
    } else if (typeof value === 'boolean') {
      if (value) node.setAttribute(key, '');
    } else if (key === 'class') {
      node.className = value;
    } else if (key === 'value' && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)) {
      node.value = value;
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Replaces `node`'s children wholesale — the panel's whole rendering model. */
export function render(node: HTMLElement, ...children: Child[]): void {
  clear(node);
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

/** "4m 12s", for uptimes and burn clocks. */
export function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** "3 minutes ago", for save timestamps an operator reads at a glance. */
export function ago(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const ms = Date.now() - then;
  if (ms < 0) return iso;
  if (ms < 60_000) return 'just now';
  return `${duration(ms)} ago`;
}
