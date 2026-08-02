/**
 * The draft control — a brief, a model, and a button that fills the prose box.
 *
 * **The model drafts; the human commits.** Nothing here saves. The draft lands in the editor's text
 * area, where it can be read, rewritten, coloured or simply not saved, and only the ordinary Save
 * writes it to the overlay. That ordering is the whole ethic of the feature: unreviewed machine prose
 * must never already be in the world, and throwing a draft away must be the cheap path.
 *
 * ## Two things it will not do
 *
 * It will not overwrite prose that is already there without asking. Drafting over a room somebody
 * wrote is the one destructive thing this button could do, and a confirm is cheaper than the apology.
 *
 * It will not remember the brief for you across rooms. The brief is *about this room* — "forest by a
 * stream" — and carrying it to the next one silently produces a second room by the same stream.
 *
 * The **model choice** does persist, because that is a property of the machine rather than of the
 * room: nine models are installed and you settle on one.
 */

import { call, type DraftBody, type OllamaBody } from './api.ts';
import { el } from './dom.ts';

/** The last model used. A property of this machine, unlike the brief, which is about one room. */
const MODEL_KEY = 'mygame.admin.ollamaModel';

export interface DraftControl {
  readonly node: HTMLElement;
  /** The model and brief behind whatever is currently in the box, for recording provenance on save. */
  provenance(): { by: string; brief: string } | undefined;
}

export interface DraftOptions {
  readonly roomId: number;
  /** Reads what is in the prose box now — so an occupied box can be defended before overwriting it. */
  readonly current: () => string;
  /** Puts a draft into the prose box and refreshes its preview. */
  readonly apply: (text: string) => void;
}

export function draftControl(options: DraftOptions): DraftControl {
  let drafted: { by: string; brief: string } | undefined;

  const brief = el('input', {
    type: 'text',
    class: 'brief',
    placeholder: 'a few words — "forest by a stream", "a war room, maps and a cold draught"',
  });
  const model = el('select', { class: 'model' });
  const button = el('button', {}, 'Draft with Ollama');
  const flash = el('span', { class: 'flash' });

  // The picker is filled from Ollama's own `/api/tags` rather than a list in this file, so pulling or
  // deleting a model on the machine needs no change here. Owner's requirement, and it is also the
  // only way this stays true a month from now.
  void (async () => {
    const result = await call<OllamaBody>('GET', '/ollama');
    if (!result.ok || !result.body?.reachable || result.body.models.length === 0) {
      model.replaceChildren(el('option', {}, 'no models'));
      model.setAttribute('disabled', '');
      button.setAttribute('disabled', '');
      // Said plainly and without alarm: not running Ollama is an ordinary state of a machine, and
      // this is the one place that would otherwise be a mystery dropdown.
      flash.className = 'flash';
      flash.textContent = 'Ollama is not answering on 11434 — start it to draft prose here.';
      return;
    }
    const remembered = localStorage.getItem(MODEL_KEY);
    model.replaceChildren(
      ...result.body.models.map((entry) =>
        el(
          'option',
          { value: entry.name, ...(entry.name === remembered ? { selected: true } : {}) },
          entry.parameters ? `${entry.name} · ${entry.parameters}` : entry.name,
        ),
      ),
    );
    if (remembered && result.body.models.some((entry) => entry.name === remembered)) model.value = remembered;
  })();

  model.addEventListener('change', () => localStorage.setItem(MODEL_KEY, model.value));

  const run = async (): Promise<void> => {
    const line = brief.value.trim();
    if (!line) {
      flash.className = 'flash err';
      flash.textContent = 'A brief first — it is the one thing the model cannot work out for itself.';
      brief.focus();
      return;
    }
    // The only destructive thing this button can do.
    if (options.current().trim() && !confirm('Replace the description already in the box with a new draft?')) return;

    button.setAttribute('disabled', '');
    flash.className = 'flash';
    flash.textContent = `${model.value} is writing… (a large model on a cold start can take a minute)`;

    const result = await call<DraftBody>('POST', `/rooms/${options.roomId}/describe`, {
      model: model.value,
      brief: line,
    });
    button.removeAttribute('disabled');

    if (!result.ok || !result.body) {
      flash.className = 'flash err';
      flash.textContent = result.error ?? 'the model did not answer';
      return;
    }
    options.apply(result.body.description);
    drafted = { by: result.body.model, brief: result.body.brief };
    flash.className = 'flash ok';
    flash.textContent =
      `Drafted by ${result.body.model} in ${(result.body.ms / 1000).toFixed(1)}s. ` +
      `Read it, edit it, colour it — nothing is saved until you press Save.`;
  };

  button.addEventListener('click', () => void run());
  // Enter in the brief is the obvious gesture, and reaching for the mouse to run the thing you just
  // finished typing is the kind of small friction that makes a tool feel unfinished.
  brief.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Enter') {
      event.preventDefault();
      void run();
    }
  });

  return {
    node: el(
      'div',
      { class: 'draft' },
      el('span', { class: 'field-label' }, 'draft from a brief'),
      el('div', { class: 'row' }, brief),
      el('div', { class: 'row' }, model, button, flash),
    ),
    provenance: () => drafted,
  };
}
