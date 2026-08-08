/**
 * The supervisor — the one process that outlives the game server.
 *
 * `npm run supervisor`. It owns the game server as a child, exposes start / stop / restart on its
 * own loopback port, brings the child back when it crashes, and keeps the last few hundred lines it
 * said. See `docs/DESIGN-admin-panel.md` §10.
 *
 * ## Why this is a separate process at all
 *
 * `DESIGN-admin-panel.md` §1's rule — the game server is the only writer, and the panel is a client
 * of it — holds for every admin operation except these three, and it is worth being precise about
 * which part breaks. **Stop** can in fact be served by the process it kills; what cannot be served
 * is everything *after* it, because the thing answering is gone. **Start** has to be answered by
 * something that is running while the game server is not, and **restart** is both. So lifecycle
 * needs a survivor, and a survivor cannot be a route on the thing it restarts.
 *
 * That inverts the usual dependency and the file is shaped around it: **the supervisor must not
 * import the game.** Its whole value is answering when the game server is broken, including when it
 * is broken by not parsing — so this file imports node builtins and `supervisor-policy.ts`, which
 * itself imports nothing. Reaching for `admin.ts`'s `LOOPBACK`, or anything out of `@mygame/shared`,
 * would make the supervisor die of the fault it exists to report.
 *
 * ## What it owns, and what it does not
 *
 * **Only the game server.** `npm run dev` runs three children under `concurrently` — server, client
 * and admin — and the two Vite servers are deliberately not the supervisor's business: they hold no
 * state, they survive a game-server restart untouched, and the panel staying up *while the game
 * server is down* is the entire point. `npm run dev:supervised` is the operator's arrangement:
 * supervisor + the two Vite servers, with no second thing starting a game server.
 *
 * It also spawns the child **without `node --watch`**, which the plain `dev:server` script uses. A
 * watcher underneath a supervisor is two things claiming the same job: `--watch` restarts the
 * process on a file change without the parent ever seeing an exit, so the pid on screen would be a
 * lie and the crash counter would never move.
 *
 * ## Stopping gracefully, and why a signal is not enough
 *
 * `PlayerStore` writes on a debounce, so a hard kill costs up to `SAVE_DEBOUNCE_MS` of everyone's
 * progress — a restart button that quietly ate the last kill would be worse than no button. The
 * game server already flushes on `SIGINT`/`SIGTERM`, but **that handler cannot be reached from a
 * parent on Windows**: there are no POSIX signals there, and `child.kill('SIGTERM')` is
 * `TerminateProcess` — the handler never runs, on the platform this is developed on. So the polite
 * request goes over the **IPC channel** instead, which behaves the same everywhere, and the signals
 * are the escalation behind it: ask, then `SIGTERM`, then `SIGKILL`. See `index.ts`'s `shutdown`.
 *
 * ## Auth
 *
 * The same three layers as the admin API (§3), and the same `GAME_ADMIN_TOKEN`, so an operator sets
 * one token and the panel's one token field reaches both surfaces: an explicit loopback bind, a
 * loopback check on every request, a mandatory `x-admin-token` header whose *presence* is the CSRF
 * defence, and the token's value checked when one is set.
 *
 * **This is the most security-sensitive surface in the project, so the argument for leaving the
 * token optional in dev has to be made rather than inherited.** It rests on one property, and the
 * property is enforced by construction: {@link CHILD_ARGV} is fixed in this file. The supervisor
 * cannot be asked to run a command — there is no field for one, on any route — so it starts exactly
 * one program with exactly one set of arguments. A token nobody set therefore costs an unauthorised
 * loopback caller a game-server restart, not a shell. The day this binds anything but loopback that
 * argument expires with the bind, and {@link requireToken} is where it is enforced.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GIVE_UP_AFTER,
  LOOPBACK,
  LogRing,
  describeExit,
  isPending,
  isRunning,
  nextFailureCount,
  restartDecision,
  type RunState,
} from './supervisor-policy.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

/**
 * Deliberately `SUPERVISOR_PORT`, and `PORT` is not read here any more than it is in `index.ts`.
 *
 * `CLAUDE.md` gotcha 2: dev harnesses set `PORT` for a web server and `concurrently` hands its
 * environment to every child, and Node's `SO_REUSEADDR` means the wrong bind *succeeds* on Windows
 * rather than failing. This process is started by `concurrently` in `dev:supervised`, so it sits
 * exactly where that trap is laid.
 */
const SUPERVISOR_PORT = Number(process.env['SUPERVISOR_PORT'] ?? 8790);

/** Passed down to the child explicitly, so the port the game listens on is a fact status can report. */
const GAME_PORT = Number(process.env['GAME_PORT'] ?? 8787);

const ADMIN_TOKEN = process.env['GAME_ADMIN_TOKEN'] || undefined;

/**
 * The one program this supervisor can start.
 *
 * Fixed here rather than taken from a request, and that is the whole of the argument in the auth
 * note above: there is no route that accepts a command, so the worst an unauthorised loopback caller
 * can do is bounce the game server.
 */
const CHILD_ARGV = ['--disable-warning=ExperimentalWarning', join(HERE, 'index.ts')] as const;

/** How long the polite IPC request gets before the signals start. */
const STOP_GRACE_MS = 5_000;
/** How long `SIGTERM` gets before `SIGKILL`. */
const STOP_KILL_MS = 3_000;
/** How often to ask the child's `/health` whether it is listening yet. */
const READY_POLL_MS = 250;
/** How long a child may take to answer `/health` before the panel is told it is slow, not dead. */
const READY_TIMEOUT_MS = 60_000;

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

interface LastExit {
  readonly at: number;
  readonly code: number | null;
  readonly signal: string | null;
  readonly text: string;
  /** How long it had been running. What separates a crash loop from a one-off. */
  readonly ranMs: number;
}

const log = new LogRing({ capacity: 1_000 });
const bootedAt = Date.now();

let child: ChildProcess | undefined;
let state: RunState = { t: 'stopped', by: 'boot' };
let failures = 0;
let restarts = 0;
let startedAt = 0;
/** Milliseconds from spawn to the first `/health` answer, for the run that is up now. */
let readyMs: number | undefined;
let lastExit: LastExit | undefined;
let expectedStop = false;
let backoffTimer: NodeJS.Timeout | undefined;
let readyTimer: NodeJS.Timeout | undefined;
/** Resolved by the `exit` handler, so `stop` can await the child actually being gone. */
let exitWaiters: (() => void)[] = [];

function note(text: string): void {
  log.note(text);
  console.log(`[supervisor] ${text}`);
}

/* -------------------------------------------------------------------------- */
/* The child                                                                   */
/* -------------------------------------------------------------------------- */

function startChild(): { ok: true; pid: number } | { ok: false; error: string } {
  if (isRunning(state)) return { ok: false, error: 'the game server is already running' };
  cancelBackoff();

  let spawned: ChildProcess;
  try {
    spawned = spawn(process.execPath, [...CHILD_ARGV], {
      cwd: REPO_ROOT,
      // The child's own `GAME_PORT` is set explicitly rather than inherited by luck, so that what
      // status reports and what the child binds cannot drift apart.
      env: { ...process.env, GAME_PORT: String(GAME_PORT) },
      // `ipc` is the fourth slot, and it is what makes a graceful stop possible on Windows.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
  } catch (err) {
    const error = (err as Error).message;
    note(`could not spawn the game server: ${error}`);
    return { ok: false, error };
  }

  child = spawned;
  startedAt = Date.now();
  readyMs = undefined;
  expectedStop = false;
  state = { t: 'starting' };
  note(`starting the game server on GAME_PORT ${GAME_PORT} (pid ${spawned.pid})`);

  spawned.stdout?.setEncoding('utf8');
  spawned.stderr?.setEncoding('utf8');
  spawned.stdout?.on('data', (chunk: string) => log.write('out', chunk));
  spawned.stderr?.on('data', (chunk: string) => log.write('err', chunk));

  // A failure to spawn at all arrives here rather than as a throw — a missing binary, a bad cwd.
  spawned.on('error', (err) => {
    note(`the game server could not be started: ${err.message}`);
  });

  spawned.on('exit', (code, signal) => onChildExit(spawned, code, signal));
  pollReady(spawned);
  return { ok: true, pid: spawned.pid ?? -1 };
}

/**
 * Asks the child's own `/health` until it answers, then calls it up.
 *
 * A pid is not readiness: the world loader takes a moment and the port is not bound until it is
 * done, so a panel that said "up" the instant `spawn` returned would be wrong for the whole of the
 * boot — which is exactly the window an operator is watching after pressing Restart.
 */
function pollReady(owned: ChildProcess): void {
  clearTimeout(readyTimer);
  if (child !== owned || state.t !== 'starting') return;
  if (Date.now() - startedAt > READY_TIMEOUT_MS) {
    note(`the game server has not answered /health in ${Math.round(READY_TIMEOUT_MS / 1000)}s — still waiting`);
    return;
  }
  void probeHealth().then((health) => {
    if (child !== owned || state.t !== 'starting') return;
    if (health) {
      readyMs = Date.now() - startedAt;
      state = { t: 'up', pid: owned.pid ?? -1, since: startedAt };
      note(`the game server is listening on ${GAME_PORT} after ${readyMs} ms`);
      return;
    }
    readyTimer = setTimeout(() => pollReady(owned), READY_POLL_MS);
  });
}

function onChildExit(owned: ChildProcess, code: number | null, signal: string | null): void {
  if (child !== owned) return;
  const ranMs = Date.now() - startedAt;
  const verdict = describeExit(code, signal, expectedStop);

  // Whatever it managed to say without a trailing newline is usually the line naming the cause.
  log.close('out');
  log.close('err');

  child = undefined;
  clearTimeout(readyTimer);
  lastExit = { at: Date.now(), code, signal, text: verdict.text, ranMs };
  note(`the game server ${verdict.text} after ${Math.round(ranMs / 1000)}s`);

  const waiters = exitWaiters;
  exitWaiters = [];
  for (const waiter of waiters) waiter();

  if (!verdict.crashed) {
    state = { t: 'stopped', by: expectedStop ? 'operator' : 'itself' };
    failures = 0;
    expectedStop = false;
    return;
  }

  failures = nextFailureCount(failures, ranMs, true);
  const decision = restartDecision(failures);
  if (decision.t === 'give-up') {
    state = { t: 'gave-up', attempts: decision.attempts };
    note(`giving up after ${decision.attempts} consecutive crashes — read the log and press Start`);
    return;
  }
  state = { t: 'backoff', until: Date.now() + decision.delayMs, attempt: decision.attempt };
  note(`restarting in ${decision.delayMs} ms (attempt ${decision.attempt} of ${GIVE_UP_AFTER})`);
  backoffTimer = setTimeout(() => {
    backoffTimer = undefined;
    if (isPending(state) || state.t === 'gave-up') startChild();
  }, decision.delayMs);
}

function cancelBackoff(): void {
  if (backoffTimer) clearTimeout(backoffTimer);
  backoffTimer = undefined;
}

/**
 * Ask, then `SIGTERM`, then `SIGKILL` — and wait for the exit before answering.
 *
 * The waiting is the part that matters for restart: answering "stopped" while the port is still
 * held would make the start that follows fail to bind, and on Windows `SO_REUSEADDR` means it would
 * fail *silently* by succeeding (`CLAUDE.md` gotcha 2).
 */
async function stopChild(): Promise<void> {
  const owned = child;
  cancelBackoff();
  if (!owned) {
    state = { t: 'stopped', by: 'operator' };
    return;
  }
  expectedStop = true;
  const gone = new Promise<void>((done) => exitWaiters.push(done));

  if (owned.connected) {
    note('asking the game server to flush and exit');
    try {
      owned.send({ t: 'shutdown' });
    } catch {
      // The channel closed under us; the signals below are the answer.
    }
  }
  if (await settled(gone, STOP_GRACE_MS)) return;

  note('no answer — sending SIGTERM');
  owned.kill('SIGTERM');
  if (await settled(gone, STOP_KILL_MS)) return;

  note('still there — sending SIGKILL');
  owned.kill('SIGKILL');
  await gone;
}

/** Resolves true when `promise` won the race, false when the timeout did. */
async function settled(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((done) => {
    timer = setTimeout(() => done(false), ms);
  });
  const won = await Promise.race([promise.then(() => true), timeout]);
  clearTimeout(timer);
  return won;
}

/* -------------------------------------------------------------------------- */
/* Talking to the game server                                                  */
/* -------------------------------------------------------------------------- */

interface Health {
  readonly players: number | null;
  readonly zones: number | null;
}

/** The child's own `/health`, or undefined when it is not answering. Never throws, never hangs. */
async function probeHealth(): Promise<Health | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${GAME_PORT}/health`, {
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { players?: unknown; zones?: unknown };
    return {
      players: typeof body.players === 'number' ? body.players : null,
      zones: Array.isArray(body.zones) ? body.zones.length : null,
    };
  } catch {
    return undefined;
  }
}

/**
 * Tells the world a restart is coming, through the game server's own announce route.
 *
 * Best effort by design: a server too wedged to answer is a server that especially needs stopping,
 * so a failed announcement never blocks the stop. It is the roadmap's third condition on this
 * feature — a restart drops every player, and A2's world announce is exactly what it is for.
 */
async function announce(text: string): Promise<number | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${GAME_PORT}/admin/api/announce`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN_TOKEN ?? 'supervisor' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { heard?: unknown };
    return typeof body.heard === 'number' ? body.heard : undefined;
  } catch {
    return undefined;
  }
}

const DEFAULT_WARNING = 'The server is restarting. You will be disconnected — reconnect in a moment.';

/** Reads `{announce}`: a string replaces the warning, `false` skips it, absent takes the default. */
function warningFrom(body: unknown): string | undefined {
  const raw = (body ?? {}) as { announce?: unknown };
  if (raw.announce === false) return undefined;
  if (typeof raw.announce === 'string' && raw.announce.trim()) return raw.announce.trim().slice(0, 240);
  return DEFAULT_WARNING;
}

/* -------------------------------------------------------------------------- */
/* The HTTP surface                                                            */
/* -------------------------------------------------------------------------- */

interface Reply {
  readonly status: number;
  readonly body: unknown;
}

async function statusBody(): Promise<unknown> {
  const health = await probeHealth();
  return {
    ok: true,
    supervisor: {
      startedAt: bootedAt,
      uptimeMs: Date.now() - bootedAt,
      port: SUPERVISOR_PORT,
      gamePort: GAME_PORT,
      token: ADMIN_TOKEN === undefined ? 'open (loopback only)' : 'required',
      giveUpAfter: GIVE_UP_AFTER,
      command: `node ${CHILD_ARGV.join(' ')}`,
    },
    server: {
      state: state.t,
      // Spelled out rather than left to the panel, so the two cannot disagree about what
      // "gave-up after 5" means in a sentence.
      detail: describeState(),
      pid: state.t === 'up' ? state.pid : child?.pid ?? null,
      since: state.t === 'up' ? state.since : null,
      uptimeMs: isRunning(state) ? Date.now() - startedAt : null,
      readyMs: readyMs ?? null,
      restarts,
      failures,
      backoffUntil: state.t === 'backoff' ? state.until : null,
      attempt: state.t === 'backoff' ? state.attempt : null,
      lastExit: lastExit ?? null,
    },
    // What the game itself says, which is the only honest source for "how many am I about to drop".
    game: {
      reachable: health !== undefined,
      players: health?.players ?? null,
      zones: health?.zones ?? null,
    },
    log: { total: log.total, dropped: log.dropped },
  };
}

function describeState(): string {
  switch (state.t) {
    case 'up':
      return `up as pid ${state.pid}`;
    case 'starting':
      return 'started, waiting for it to listen';
    case 'backoff':
      return `crashed — restart attempt ${state.attempt} of ${GIVE_UP_AFTER} in ${Math.max(0, state.until - Date.now())} ms`;
    case 'gave-up':
      return `gave up after ${state.attempts} consecutive crashes`;
    case 'stopped':
      return state.by === 'operator'
        ? 'stopped by the operator'
        : state.by === 'itself'
          ? 'exited on its own and was not restarted'
          : 'not started yet';
  }
}

async function route(
  method: string,
  path: string,
  query: URLSearchParams,
  body: unknown,
): Promise<Reply> {
  if (method === 'GET' && path === '/status') return { status: 200, body: await statusBody() };

  if (method === 'GET' && path === '/log') {
    const limit = Number(query.get('limit') ?? 200);
    const since = Number(query.get('since') ?? 0);
    return {
      status: 200,
      body: {
        lines: log.tail(Number.isFinite(limit) ? limit : 200, Number.isFinite(since) ? since : 0),
        total: log.total,
        dropped: log.dropped,
      },
    };
  }

  if (method === 'POST' && path === '/start') {
    if (isRunning(state)) return { status: 409, body: { error: 'the game server is already running' } };
    // An operator pressing Start is also saying "stop counting" — otherwise a give-up would survive
    // the fix that resolved it.
    failures = 0;
    const started = startChild();
    if (!started.ok) return { status: 500, body: { error: started.error } };
    return { status: 200, body: { ok: true, pid: started.pid, ...(await statusBody() as object) } };
  }

  if (method === 'POST' && path === '/stop') {
    if (!isRunning(state) && !isPending(state)) {
      return { status: 409, body: { error: 'the game server is not running' } };
    }
    const warning = warningFrom(body);
    const heard = warning ? await announce(warning) : undefined;
    await stopChild();
    state = { t: 'stopped', by: 'operator' };
    failures = 0;
    return { status: 200, body: { ok: true, announced: warning ?? null, heard: heard ?? null } };
  }

  if (method === 'POST' && path === '/restart') {
    const warning = warningFrom(body);
    const heard = warning ? await announce(warning) : undefined;
    if (isRunning(state)) await stopChild();
    cancelBackoff();
    failures = 0;
    const started = startChild();
    if (!started.ok) return { status: 500, body: { error: started.error } };
    restarts++;
    return {
      status: 200,
      body: { ok: true, pid: started.pid, restarts, announced: warning ?? null, heard: heard ?? null },
    };
  }

  return { status: 404, body: { error: `no such supervisor route: ${method} ${path}` } };
}

const PREFIX = '/supervisor/api';
const BODY_MAX = 16 * 1024;

function serve(req: IncomingMessage, res: ServerResponse): void {
  const respond = (reply: Reply): void => {
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  };

  const url = req.url ?? '/';
  if (!url.startsWith(PREFIX)) return respond({ status: 404, body: { error: 'supervisor serves /supervisor/api' } });

  // Layer 1 of §3, checked here as belt and braces against a future bind change rather than trusted
  // from the bind at the bottom of this file.
  const remote = req.socket.remoteAddress;
  if (!remote || !LOOPBACK.has(remote)) {
    return respond({ status: 403, body: { error: 'the supervisor is loopback-only' } });
  }
  const token = req.headers['x-admin-token'];
  if (typeof token !== 'string') {
    // Present before correct: the header is the CSRF defence, the value is only the lock.
    return respond({ status: 401, body: { error: 'x-admin-token header required' } });
  }
  if (requireToken() && token !== ADMIN_TOKEN) {
    return respond({ status: 401, body: { error: 'bad admin token' } });
  }

  const chunks: Buffer[] = [];
  let overflowed = false;
  req.on('data', (chunk: Buffer) => {
    if (overflowed) return;
    chunks.push(chunk);
    if (chunks.reduce((n, c) => n + c.length, 0) > BODY_MAX) overflowed = true;
  });
  req.on('end', () => {
    if (overflowed) return respond({ status: 413, body: { error: 'body too large' } });
    let body: unknown;
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        return respond({ status: 400, body: { error: 'body is not JSON' } });
      }
    }
    const parsed = new URL(url, 'http://supervisor.invalid');
    route(req.method ?? 'GET', parsed.pathname.slice(PREFIX.length) || '/', parsed.searchParams, body)
      .then(respond)
      // A rejected promise here would leave the response unwritten and the panel spinning for ever,
      // which for this surface would look exactly like the outage it is meant to be reporting on.
      .catch((err: unknown) => {
        console.error('[supervisor] route threw:', err);
        respond({ status: 500, body: { error: (err as Error).message ?? 'supervisor route failed' } });
      });
  });
}

/**
 * Whether the token's *value* must match.
 *
 * Optional in dev for the reason in the file header — the argv is fixed, so an unauthorised loopback
 * caller can bounce the game server and nothing else. If this ever binds off loopback the argument
 * expires with the bind, and this is the one place that has to change.
 */
function requireToken(): boolean {
  return ADMIN_TOKEN !== undefined;
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                        */
/* -------------------------------------------------------------------------- */

const server = createServer(serve);

server.on('error', (err) => {
  console.error(`[supervisor] could not listen on ${SUPERVISOR_PORT}: ${err.message}`);
  process.exit(1);
});

// Loopback, explicitly and for the same reason the game server is: this starts processes, and it
// has no business being reachable from the network.
server.listen(SUPERVISOR_PORT, '127.0.0.1', () => {
  console.log(
    `[supervisor] listening on http://127.0.0.1:${SUPERVISOR_PORT}/supervisor/api — ` +
      (ADMIN_TOKEN ? 'GAME_ADMIN_TOKEN required' : 'GAME_ADMIN_TOKEN not set: open on loopback'),
  );
  startChild();
});

// The child must not outlive its supervisor: an orphan holds `GAME_PORT`, and the next supervisor
// would bind a port that is already taken and — on Windows, per gotcha 2 — be told it succeeded.
let leaving = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (leaving) return;
    leaving = true;
    note('supervisor is shutting down — taking the game server with it');
    cancelBackoff();
    void stopChild().then(() => process.exit(0));
  });
}
