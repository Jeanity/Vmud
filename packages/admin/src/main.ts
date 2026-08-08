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
import { itemsSection } from './sections/items.ts';
import { mobsSection } from './sections/mobs.ts';
import { playersSection } from './sections/players.ts';
import { questsSection } from './sections/quests.ts';
import { supervisorSection } from './sections/supervisor.ts';
import { worldSection } from './sections/world.ts';
import { zonesSection } from './sections/zones.ts';

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
  // A10. Deliberately above the content sections: it is the one that answers when the game server
  // is down, so it is where an operator goes first when the rest of the panel has gone blank.
  supervisorSection,
  worldSection,
  zonesSection,
  mobsSection,
  itemsSection,
  // A7q. The last stub in the panel, and it stopped being one when Phase 21 slice 7 gave it something
  // to edit — the tab that named the phase it was waiting for now edits the thing that phase built.
  questsSection,
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
