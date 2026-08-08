/**
 * The supervisor's decisions, with no process and no socket in sight.
 *
 * `supervisor.ts` is a process: it spawns a child, holds sockets, and cannot be unit-tested for the
 * same reason `index.ts` cannot. Everything it *decides* lives here instead — when to try again,
 * how long to wait, when to stop trying, what a dead child's exit code meant, and which lines of its
 * output to keep. That is the same split `admin.ts` makes against `index.ts`, and it is what lets
 * the crash-loop rules be pinned by tests rather than by restarting a real server thirty times.
 *
 * **This file imports nothing, and that is a requirement rather than an accident.** The supervisor
 * exists to be running when the game server is not — including when the game server is not running
 * *because it does not parse*. A supervisor that imported `@mygame/shared`, or `admin.ts`, or
 * anything that reaches the world loader, would die of the same fault it is supposed to survive and
 * report. The one duplicated constant below is duplicated for exactly that reason.
 */

/**
 * The loopback addresses a request may arrive from.
 *
 * **Deliberately a copy of `admin.ts`'s set rather than an import of it.** Importing it would drag
 * the whole admin router — and through it the shared package, the world loader and the model
 * client — into a process whose entire value is that it still answers when those are broken. Three
 * strings are a cheaper price than that coupling.
 */
export const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * How long a child must stay up before the crash that follows counts as a *new* problem rather than
 * the next iteration of an old one.
 *
 * Without this the failure counter is a lifetime tally: a server that ran for a week and then died
 * once would be judged against restarts from the week before, and a supervisor that gave up on the
 * first crash in seven days is a supervisor nobody keeps running. Sixty seconds is well past the
 * world load, which is the expensive part of a boot and where a bad zone file kills a child.
 */
export const HEALTHY_MS = 60_000;

/**
 * The wait before each successive restart attempt, in order.
 *
 * Exponential and capped, because the two failure shapes want opposite things: a transient fault (a
 * port still in TIME_WAIT, a file being written as it was read) clears in a second and wants a fast
 * retry, while a permanent one (a syntax error, a missing `data/world/`) will not clear at all and
 * wants the supervisor to stop hammering it and leave the logs readable. The ladder is what turns
 * the first into a blip and the second into an obvious, slow, legible failure.
 */
export const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

/**
 * Consecutive crashes tolerated before the supervisor stops trying and waits for an operator.
 *
 * A give-up threshold is not pessimism, it is the difference between a crash loop that is *visible*
 * and one that is merely loud: a supervisor that restarts for ever writes the same failure into the
 * ring buffer a thousand times and pushes the first — the only one with the real cause above it —
 * out the back. Five attempts spend the whole ladder, which is 31 seconds of patience.
 */
export const GIVE_UP_AFTER = 5;

/* -------------------------------------------------------------------------- */
/* What a dead child's exit meant                                              */
/* -------------------------------------------------------------------------- */

/**
 * Why the child is no longer running.
 *
 * `stopped` is the operator's own doing and is never a crash; the other three are read off the exit
 * itself. The distinction that matters is {@link ExitVerdict.crashed}, because that is the only
 * thing the restart policy asks about.
 */
export type ExitReason =
  | { readonly t: 'stopped' }
  | { readonly t: 'clean' }
  | { readonly t: 'failed'; readonly code: number }
  | { readonly t: 'signalled'; readonly signal: string };

export interface ExitVerdict {
  readonly reason: ExitReason;
  /** One sentence, written for the operator reading the status card. */
  readonly text: string;
  /** Whether the supervisor should try to bring it back. */
  readonly crashed: boolean;
}

/**
 * Reads an exit into a reason, a sentence and a verdict.
 *
 * `expected` is set when the supervisor asked for this stop, and it wins over everything else — a
 * graceful stop exits `0` and an escalated one exits on a signal, and neither is a crash when it
 * was the operator who pressed the button.
 *
 * **An unexpected clean exit does not count as a crash, deliberately.** The supervisor cannot tell a
 * server that shut itself down on purpose from one that fell over quietly, and of the two possible
 * mistakes, restarting a process that meant to exit is the one that fights the operator in a loop
 * they did not ask for. It is reported plainly instead and the Start button is right there.
 */
export function describeExit(
  code: number | null,
  signal: string | null,
  expected: boolean,
): ExitVerdict {
  if (expected) {
    return { reason: { t: 'stopped' }, text: 'stopped by the operator', crashed: false };
  }
  if (signal) {
    return {
      reason: { t: 'signalled', signal },
      text: `killed by ${signal}`,
      crashed: true,
    };
  }
  if (code === 0) {
    return { reason: { t: 'clean' }, text: 'exited cleanly, and nobody asked it to', crashed: false };
  }
  const value = code ?? -1;
  return { reason: { t: 'failed', code: value }, text: `crashed with exit code ${describeCode(value)}`, crashed: true };
}

/**
 * An exit code as an operator can recognise it.
 *
 * **Windows reports a forcibly terminated process as an unsigned 32-bit value**, so killing the
 * server from Task Manager or `Stop-Process -Force` arrives here as `4294967295` — a number that
 * tells the operator who did it precisely nothing. Rendered beside its hex it is `0xffffffff` and
 * recognisable on sight. Small codes are left alone, because `1` is already the clearest form of
 * itself.
 */
function describeCode(code: number): string {
  if (code > 0x7fff_ffff) return `${code} (0x${code.toString(16)})`;
  return String(code);
}

/**
 * The consecutive-failure count after an exit.
 *
 * Anything that is not a crash clears the count outright — an operator's stop is not a strike
 * against the next start. A crash after a healthy run starts the count again at one, which is what
 * {@link HEALTHY_MS} exists to express: the run proved the build boots, so whatever killed it is a
 * new fault and deserves the full ladder rather than the tail of an old one.
 */
export function nextFailureCount(previous: number, ranMs: number, crashed: boolean): number {
  if (!crashed) return 0;
  if (ranMs >= HEALTHY_MS) return 1;
  return previous + 1;
}

/* -------------------------------------------------------------------------- */
/* Whether and when to try again                                               */
/* -------------------------------------------------------------------------- */

export type RestartDecision =
  | { readonly t: 'restart'; readonly delayMs: number; readonly attempt: number }
  | { readonly t: 'give-up'; readonly attempts: number };

/**
 * How long to wait before attempt number `failures`, or whether to stop trying.
 *
 * `failures` counts the crash that has just happened, so the first crash is `1` and takes the first
 * rung of the ladder. Past the ladder's length the delay stays at its last rung — but with
 * {@link GIVE_UP_AFTER} at the ladder's length that is unreachable today, and the clamp is there so
 * that lengthening the threshold alone cannot walk off the end of the array.
 */
export function restartDecision(failures: number): RestartDecision {
  if (failures > GIVE_UP_AFTER) return { t: 'give-up', attempts: failures - 1 };
  const rung = Math.min(failures, BACKOFF_MS.length) - 1;
  return { t: 'restart', delayMs: BACKOFF_MS[Math.max(rung, 0)]!, attempt: failures };
}

/* -------------------------------------------------------------------------- */
/* The recent output                                                           */
/* -------------------------------------------------------------------------- */

/** Where a line came from. `sup` is the supervisor's own voice, interleaved in the same stream. */
export type LogStream = 'out' | 'err' | 'sup';

export interface LogLine {
  /** Monotonic across the supervisor's life, so a poller can ask for only what it has not seen. */
  readonly seq: number;
  readonly at: number;
  readonly stream: LogStream;
  readonly text: string;
}

export interface LogRingOptions {
  readonly capacity?: number;
  /** Injectable so tests can pin timestamps; the process passes `Date.now`. */
  readonly now?: () => number;
}

/**
 * The last N lines the child said, and the supervisor's own commentary interleaved with them.
 *
 * **A ring rather than a file, because this is a tail and not an audit.** `admin.ts` writes
 * `data/admin-audit.jsonl` for the operations an operator performs, which must survive for ever;
 * this is the server's console, which is unbounded and whose value decays in minutes. Keeping the
 * last few hundred lines in memory is what makes the panel's log pane free — and it means a crash
 * loop cannot fill a disk while nobody is looking.
 *
 * **Chunks are not lines, and that is most of what this class is for.** A pipe delivers whatever
 * happened to be in the buffer, so one `data` event can hold half a line, and the half that
 * completes it arrives in the next. Splitting each chunk on its own would shred long lines — stack
 * traces, exactly the output worth reading — so a partial tail is held **per stream** until its
 * newline arrives. {@link close} is what publishes the last partial, and it matters more than it
 * looks: a process that dies mid-write ends without a trailing newline, and that unterminated line
 * is usually the one naming the cause.
 */
export class LogRing {
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly lines: LogLine[] = [];
  private readonly partial = new Map<LogStream, string>();
  private seq = 0;
  private droppedCount = 0;

  constructor(options: LogRingOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? 500);
    this.now = options.now ?? Date.now;
  }

  /** Lines pushed out of the back of the ring — shown so a truncated tail says it is truncated. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Every line ever admitted, dropped ones included. Also the highest `seq` issued. */
  get total(): number {
    return this.seq;
  }

  /** Feeds a chunk of child output in, emitting whatever complete lines it finishes. */
  write(stream: LogStream, chunk: string): void {
    const held = (this.partial.get(stream) ?? '') + chunk;
    const parts = held.split('\n');
    // The last element is whatever follows the final newline — empty when the chunk ended on one.
    this.partial.set(stream, parts.pop() ?? '');
    for (const part of parts) this.push(stream, part);
  }

  /** The supervisor's own line, in the same stream the operator is already reading. */
  note(text: string): void {
    this.push('sup', text);
  }

  /**
   * Publishes any held partial for a stream that has ended.
   *
   * Called when the child's pipes close, which is the moment the held text stops being "the start of
   * the next line" and becomes "the last thing it managed to say".
   */
  close(stream: LogStream): void {
    const held = this.partial.get(stream);
    this.partial.delete(stream);
    if (held) this.push(stream, held);
  }

  /** The most recent `limit` lines, oldest first; optionally only those newer than `since`. */
  tail(limit = 200, since = 0): LogLine[] {
    const fresh = since > 0 ? this.lines.filter((line) => line.seq > since) : this.lines;
    return fresh.slice(Math.max(0, fresh.length - Math.max(0, limit)));
  }

  private push(stream: LogStream, text: string): void {
    // A carriage return survives `split('\n')` on Windows-authored output and would otherwise be
    // rendered as a stray glyph in the panel's log pane.
    this.lines.push({ seq: ++this.seq, at: this.now(), stream, text: text.replace(/\r$/, '') });
    while (this.lines.length > this.capacity) {
      this.lines.shift();
      this.droppedCount++;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* What the child is doing                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The supervisor's view of its child.
 *
 * `gave-up` is a separate state from `stopped` on purpose: both mean nothing is running, and only
 * one of them means the operator should go and read the log before pressing Start.
 */
export type RunState =
  | { readonly t: 'stopped'; readonly by: 'operator' | 'boot' | 'itself' }
  | { readonly t: 'starting' }
  | { readonly t: 'up'; readonly pid: number; readonly since: number }
  | { readonly t: 'backoff'; readonly until: number; readonly attempt: number }
  | { readonly t: 'gave-up'; readonly attempts: number };

/** Whether a state means a child process exists — the question start/stop refusals are built on. */
export function isRunning(state: RunState): boolean {
  return state.t === 'up' || state.t === 'starting';
}

/** Whether the supervisor intends to start something without being asked again. */
export function isPending(state: RunState): boolean {
  return state.t === 'backoff';
}
