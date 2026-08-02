/**
 * The panel shell: navigation, the server pulse in the header, and the token field.
 *
 * Sections own everything inside `#main`. The ones whose game systems do not exist yet are honest
 * stubs — named, with the phase that unblocks them, doing nothing — which is the same rule the game
 * client's inventory drawer follows. See `docs/DESIGN-admin-panel.md` §5.
 */

import { call, rememberToken, storedToken, type StatusBody } from './api.ts';
import { el, render } from './dom.ts';
import { dashboardSection } from './sections/dashboard.ts';
import { messagingSection } from './sections/messaging.ts';
import { playersSection } from './sections/players.ts';
import { stubSection } from './sections/stubs.ts';

interface Section {
  readonly slug: string;
  readonly title: string;
  /** Set for a stub — shown as a right-aligned tag in the nav. */
  readonly waits?: string;
  mount(root: HTMLElement): void;
  /** Stops the section's polling. Optional because stubs have nothing to stop. */
  unmount?(): void;
}

const SECTIONS: Section[] = [
  dashboardSection,
  playersSection,
  messagingSection,
  stubSection('zones', 'Zones', 'next slice', [
    'Reading first: the zone list, a room browser with sector, flags and prose, door states and repop clocks.',
    'Live operations second: force a repop, work a door.',
    'Authoring last, as overlay files that survive `npm run worldgen` — the base data is regenerated, so hand edits to it are lost by design. See DESIGN-admin-panel.md §1.',
  ]),
  stubSection('mobs', 'Mobs', 'next slice', [
    'Live: instances by zone, slay, spawn from a harvested template.',
    'Authoring: template overrides (name, level, combat numbers, aggression) as overlay files over data/world/spawns/.',
  ]),
  stubSection('items', 'Items', 'Phase 15', [
    'There is no item system yet — items, inventory and equipment are Phase 15.',
    'The light catalogue is the one item-shaped thing in the game today, and it is code rather than data; the dashboard lists it read-only.',
  ]),
  stubSection('quests', 'Quests', 'Phase 17', [
    'Nothing exists to edit — quests are Phase 17. This tab exists so the panel’s shape is the plan’s shape.',
  ]),
];

const nav = document.getElementById('nav')!;
const main = document.getElementById('main')!;
let active: Section | undefined;

function currentSlug(): string {
  return window.location.hash.replace(/^#\/?/, '') || 'players';
}

function show(slug: string): void {
  const section = SECTIONS.find((s) => s.slug === slug) ?? SECTIONS[1]!;
  active?.unmount?.();
  active = section;
  for (const link of nav.querySelectorAll('a')) {
    link.classList.toggle('active', link.dataset.slug === section.slug);
  }
  render(main);
  section.mount(main);
}

render(
  nav,
  ...SECTIONS.map((section) =>
    el(
      'a',
      { href: `#/${section.slug}`, 'data-slug': section.slug },
      section.title,
      section.waits ? el('span', { class: 'soon' }, section.waits) : null,
    ),
  ),
);
window.addEventListener('hashchange', () => show(currentSlug()));

/* ---------------------------------------------------------------- the pulse */

const pulse = document.getElementById('pulse')!;
const pulseText = document.getElementById('pulse-text')!;

async function beat(): Promise<void> {
  const result = await call<StatusBody>('GET', '/status');
  if (result.ok && result.body) {
    pulse.classList.add('up');
    pulseText.textContent =
      `${result.body.playersOnline} online · up ${formatUptime(result.body.uptimeMs)}` +
      (result.body.token === 'required' ? ' · token required' : '');
  } else {
    pulse.classList.remove('up');
    pulseText.textContent = result.error ?? 'unreachable';
  }
}

function formatUptime(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

void beat();
setInterval(() => void beat(), 5000);

/* ---------------------------------------------------------------- the token */

const tokenField = document.getElementById('token') as HTMLInputElement;
tokenField.value = storedToken();
tokenField.addEventListener('change', () => {
  rememberToken(tokenField.value);
  void beat();
});

show(currentSlug());
