/**
 * The party roster — **Phase 18, protocol 19.**
 *
 * `ROADMAP.md` for the phase: *"consent, a shared list, the superlinear exp split"*. This is the shared
 * list, and the reason it is a panel rather than the `group` command's printout is that a printout is a
 * thing you ask for: the numbers on it are stale by the next round, and a party member falling over is
 * exactly the news you must not have to type a command to hear.
 *
 * ## Plain DOM, like the combat feed and the place map
 *
 * A list of rows with bars in it is the browser's job. It owes the renderer nothing, it stays legible
 * if something goes wrong inside the canvas, and it costs the tick nothing at all — the same argument
 * `combatfeed.ts`, `announce.ts` and `placemap.ts` all make.
 *
 * ## Rebuilt, not diffed
 *
 * The whole list is replaced on every message. A party is at most thirteen rows, arrives whole on the
 * wire (protocol 19 sends the roster, not a delta), and reordering — which happens the moment a leader
 * leaves and the second member is promoted — is the case a keyed diff would get subtly wrong. Thirteen
 * `div`s is nothing; a row that kept a stale leader mark is a lie about who is in charge.
 *
 * ## The three bars, and the number on the first one
 *
 * Health, movement and mana, in that order, coloured to match the world's own bars so a body on screen
 * and its row in this list cannot disagree at the same fraction. Movement and mana are fractions on the
 * wire; **health carries the exact pair too since protocol 21** — the aimable-heal change protocol 19's
 * note promised — and this panel puts it on the hp bar's hover, where a healer deciding who gets the
 * cure reads it without thirteen rows growing thirteen permanent labels.
 */

/** The world's own ramp — `scene.ts`'s `HEALTH_HURT_BELOW` / `HEALTH_LOW_BELOW`, deliberately copied. */
const HURT_BELOW = 0.6;
const LOW_BELOW = 0.3;

/** One member as the wire describes them. Structurally the protocol's `GroupMemberView`. */
export interface RosterMember {
  readonly id: number;
  readonly name: string;
  readonly level: number;
  readonly leader: boolean;
  readonly health: number;
  /** Exact hit points — protocol 21, the aimable-heal change. Negative in the dying window, shown as such. */
  readonly hp: number;
  readonly maxHp: number;
  readonly move: number;
  readonly mana: number;
  readonly here: boolean;
}

export class GroupRoster {
  private readonly section: HTMLElement;
  private readonly rows: HTMLElement;

  constructor() {
    const section = document.getElementById('group');
    const rows = document.getElementById('group-rows');
    if (!section || !rows) throw new Error('group elements missing from index.html');
    this.section = section;
    this.rows = rows;
  }

  /**
   * Draws a roster, or takes the section off screen when there is no group.
   *
   * An empty list is how the server says *"you are in no group"* — including to the person who just
   * left one, who by then has no group to be enumerated. So emptiness is a state to render, not a
   * message to ignore.
   */
  update(members: readonly RosterMember[]): void {
    this.section.classList.toggle('empty', members.length === 0);
    this.rows.replaceChildren(...members.map((member) => this.row(member)));
  }

  private row(member: RosterMember): HTMLElement {
    const row = document.createElement('div');
    row.className = member.here ? 'party-row' : 'party-row away';

    const who = document.createElement('span');
    who.className = 'who';
    if (member.leader) {
      const lead = document.createElement('span');
      lead.className = 'lead';
      // A mark rather than the word "leader": the row is 120 pixels wide and the name is the thing
      // being read. Titled, so what it means is one hover away.
      lead.textContent = '◆ ';
      lead.title = 'Group leader';
      who.append(lead);
    }
    // `textContent`, never `innerHTML`. A player's name is text somebody else typed, and this is the
    // rule every DOM surface in the client keeps for exactly that reason.
    who.append(document.createTextNode(member.name));
    if (!member.here) who.title = `${member.name} is not in the room — no share of a kill here`;

    const level = document.createElement('span');
    level.className = 'level';
    level.textContent = `L${member.level}`;

    const bars = document.createElement('div');
    bars.className = 'bars';
    const hpBar = bar('hp', member.health, healthClass(member.health));
    // Protocol 21: the number a healer aims by, on the bar it colours. A title rather than a always-on
    // label because the row is 120 pixels wide — the bar answers "roughly", the hover answers "exactly",
    // and the dying window's negative number is deliberately shown as the negative it is.
    hpBar.title = `${member.hp} / ${member.maxHp}`;
    bars.append(hpBar, bar('mv', member.move), bar('mn', member.mana));

    row.append(who, level, bars);
    return row;
  }
}

function healthClass(fraction: number): string | undefined {
  if (fraction < LOW_BELOW) return 'low';
  if (fraction < HURT_BELOW) return 'hurt';
  return undefined;
}

/**
 * One bar: a trough with a fill in it.
 *
 * The fill keeps a **minimum sliver whenever the pool is not empty**, because 1 hit point of 900 rounds
 * to nothing at this width and a bar that reads as empty for somebody still standing is the one error
 * this panel must not make.
 */
function bar(kind: string, fraction: number, extra?: string): HTMLElement {
  const trough = document.createElement('div');
  trough.className = extra ? `bar ${kind} ${extra}` : `bar ${kind}`;
  const fill = document.createElement('span');
  const clamped = Math.max(0, Math.min(1, fraction));
  fill.style.width = clamped <= 0 ? '0' : `${Math.max(4, clamped * 100)}%`;
  trough.append(fill);
  return trough;
}
