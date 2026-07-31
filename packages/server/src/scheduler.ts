/**
 * The event scheduler: sparse, future-dated work, ordered by when it is due.
 *
 * ## Why this exists now and did not exist in Phase 5
 *
 * It was drafted for regeneration and correctly thrown away: regeneration is *dense* — every actor, every
 * tick, for ever — and a priority queue whose every entry is re-inserted immediately is a slower loop with
 * extra bookkeeping. `vitals.ts` counts down a carried fraction instead, which is the right shape for
 * something that never stops.
 *
 * A combat round is the opposite and is the queue's first honest consumer: **one timer per combatant**,
 * most actors having none at all, each firing seconds apart and rescheduling itself once. 92 mobs stand in
 * IceCrag and at most a handful are ever swinging, so a heap holding three entries beats a scan over
 * ninety-two.
 *
 * ## Determinism is the whole reason this is not a `setTimeout`
 *
 * `CLAUDE.md` rule 3: simulation is deterministic, and combat must be auditable and replayable from a
 * seed. Two consequences shape the implementation:
 *
 * - **Time is passed in, never read.** Nothing here calls `Date.now()`. The tick supplies the clock, so a
 *   test can advance an hour in a millisecond and a replay lands on the same events in the same order.
 * - **Ties break on insertion order.** Two events due at the same millisecond is the common case, not the
 *   exotic one — every actor engaged on the same tick shares a deadline. A heap alone would order them by
 *   whatever the sift happened to do, so each entry carries a monotonic sequence number and the comparison
 *   falls through to it. Without that, the same seed can produce two different fights.
 */

/** What kind of work an entry represents. One per consumer, so a cancel can be selective. */
export const EVENT_KINDS = ['swing', 'command'] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

/** One piece of future-dated work. */
export interface ScheduledEvent {
  readonly kind: EventKind;
  /** Who it belongs to — an entity id, so cancelling everything for a departing actor is one call. */
  readonly actor: number;
  /** Simulation time it comes due, in milliseconds since the scheduler started. */
  readonly dueAt: number;
  /** Consumer-defined payload. */
  readonly data?: unknown;
}

interface Entry extends ScheduledEvent {
  /** Insertion order, for the tie-break. See the module note. */
  readonly seq: number;
  cancelled: boolean;
}

/**
 * A binary min-heap of pending work.
 *
 * Cancellation is **lazy**: an entry is flagged and skipped when it surfaces, rather than being found and
 * removed. Removal from the middle of a heap means an index and a sift in both directions, and combat
 * cancels rarely (a fight ending) while it pops constantly (every round). Paying at the pop is the cheaper
 * side of that trade, and it cannot leak: a cancelled entry is discarded the moment its time comes.
 */
export class Scheduler {
  private readonly heap: Entry[] = [];
  private seq = 0;
  private nowMs = 0;

  /** Simulation time as the scheduler understands it. Advanced only by {@link advance}. */
  get now(): number {
    return this.nowMs;
  }

  /** Pending entries, cancelled ones included. For tests and for a diagnostic line. */
  get size(): number {
    return this.heap.length;
  }

  /** Live entries only. */
  countLive(): number {
    let n = 0;
    for (const entry of this.heap) if (!entry.cancelled) n++;
    return n;
  }

  /**
   * Schedules work `delayMs` from now.
   *
   * Relative rather than absolute because every caller has one: a round is "3 seconds from this swing",
   * never "at simulation time 41,300". Absolute deadlines would make each consumer read `now` first, and
   * one of them would eventually read it from the wrong clock.
   */
  schedule(kind: EventKind, actor: number, delayMs: number, data?: unknown): void {
    const entry: Entry = {
      kind,
      actor,
      // Never in the past: a negative delay would sit at the top of the heap firing every tick.
      dueAt: this.nowMs + Math.max(0, delayMs),
      data,
      seq: this.seq++,
      cancelled: false,
    };
    this.heap.push(entry);
    this.up(this.heap.length - 1);
  }

  /**
   * Advances the clock and returns everything now due, in order.
   *
   * Events are returned rather than dispatched through a callback so the caller keeps control of ordering
   * against the rest of its tick — combat has to resolve after movement and before the entity sync, and a
   * scheduler that fired into handlers would decide that for it.
   */
  advance(elapsedMs: number): ScheduledEvent[] {
    this.nowMs += elapsedMs;
    const due: ScheduledEvent[] = [];
    for (;;) {
      const top = this.heap[0];
      if (!top || top.dueAt > this.nowMs) break;
      this.pop();
      if (top.cancelled) continue;
      due.push(top);
    }
    return due;
  }

  /** Cancels everything for one actor, optionally of one kind. Returns how many were flagged. */
  cancel(actor: number, kind?: EventKind): number {
    let n = 0;
    for (const entry of this.heap) {
      if (entry.cancelled || entry.actor !== actor) continue;
      if (kind !== undefined && entry.kind !== kind) continue;
      entry.cancelled = true;
      n++;
    }
    return n;
  }

  /** Whether this actor has live work of a kind pending. */
  has(actor: number, kind: EventKind): boolean {
    return this.heap.some((entry) => !entry.cancelled && entry.actor === actor && entry.kind === kind);
  }

  /* ------------------------------------------------------------------ */

  /** Earlier first; same millisecond falls through to insertion order. */
  private before(a: Entry, b: Entry): boolean {
    return a.dueAt !== b.dueAt ? a.dueAt < b.dueAt : a.seq < b.seq;
  }

  private up(start: number): void {
    let index = start;
    const entry = this.heap[index]!;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const above = this.heap[parent]!;
      if (!this.before(entry, above)) break;
      this.heap[index] = above;
      index = parent;
    }
    this.heap[index] = entry;
  }

  private pop(): void {
    const last = this.heap.pop()!;
    if (this.heap.length === 0) return;
    this.heap[0] = last;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.heap.length && this.before(this.heap[left]!, this.heap[smallest]!)) smallest = left;
      if (right < this.heap.length && this.before(this.heap[right]!, this.heap[smallest]!)) smallest = right;
      if (smallest === index) break;
      const swap = this.heap[smallest]!;
      this.heap[smallest] = this.heap[index]!;
      this.heap[index] = swap;
      index = smallest;
    }
  }
}
