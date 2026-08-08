/**
 * Server — the lifecycle section, and the only one that talks to the supervisor.
 *
 * Everything else in this panel is a client of the game server, so everything else goes blank when
 * the game server does. This section is the exception by construction: it reaches
 * `127.0.0.1:8790` instead, which is a process that stays up precisely so that *is the server
 * down, why, and bring it back* has somewhere to be answered. See `server/src/supervisor.ts`.
 *
 * Three things the presentation takes seriously:
 *
 * 1. **A restart drops every player, and the count comes from the game rather than from here.**
 *    The confirm names how many people are online — read off the server's own `/health` — because
 *    "restart?" with no number is a question an operator answers wrongly at four in the afternoon.
 * 2. **`gave-up` reads differently from `stopped`.** Both mean nothing is running; only one means
 *    go and read the log before pressing Start. It is the one state painted in the bad colour.
 * 3. **The log pane is a tail, not a console.** It polls, it is capped, and it says when lines have
 *    fallen out of the back of the ring — a truncated tail that does not admit it is truncated is
 *    how somebody concludes a crash had no cause.
 */

import { callSupervisor, type SupervisorBody, type SupervisorLogBody } from '../api.ts';
import { duration, el, render } from '../dom.ts';

let timer: number | undefined;

/** How many lines to ask for. The ring holds 1,000; this is what fits a pane worth scrolling. */
const TAIL = 300;

export const supervisorSection = {
  slug: 'server',
  title: 'Server',
  mount(root: HTMLElement): void {
    const flash = el('p', { class: 'flash' });
    const statusCard = el('div', { class: 'card' });
    const logPane = el('pre', { class: 'sup-log' }, 'reading…');
    const logNote = el('p', { class: 'note' }, '');
    const start = el('button', {}, 'Start') as HTMLButtonElement;
    const stop = el('button', { class: 'danger' }, 'Stop') as HTMLButtonElement;
    const restart = el('button', { class: 'danger' }, 'Restart') as HTMLButtonElement;
    /** Held so a poll landing mid-scroll does not yank the pane back to the bottom. */
    let pinned = true;
    let latest: SupervisorBody | undefined;

    logPane.addEventListener('scroll', () => {
      pinned = logPane.scrollTop + logPane.clientHeight >= logPane.scrollHeight - 24;
    });

    const say = (text: string, tone: 'ok' | 'err' | '' = ''): void => {
      flash.className = tone ? `flash ${tone}` : 'flash';
      flash.textContent = text;
    };

    /** How many people a stop is about to disconnect, in words, or undefined when nobody is on. */
    const cost = (): string | undefined => {
      const players = latest?.game.players ?? 0;
      if (!latest?.game.reachable || players <= 0) return undefined;
      return `${players} player${players === 1 ? ' is' : 's are'} online and will be disconnected`;
    };

    const act = async (verb: 'start' | 'stop' | 'restart'): Promise<void> => {
      if (verb !== 'start') {
        const warning = cost();
        // A confirm rather than the world section's two-gesture arm: this is not a rule that stays
        // thrown, it is a one-shot with an immediate and obvious effect, and the thing worth
        // pausing on is the head count rather than the click.
        const question = warning
          ? `${verb === 'stop' ? 'Stop' : 'Restart'} the game server?\n\n${warning}.`
          : `${verb === 'stop' ? 'Stop' : 'Restart'} the game server?\n\nNobody is online.`;
        if (!window.confirm(question)) return;
      }
      for (const button of [start, stop, restart]) button.disabled = true;
      say(`${verb}…`);
      const result = await callSupervisor<{ heard?: number | null; announced?: string | null; pid?: number }>(
        'POST',
        `/${verb}`,
      );
      if (!result.ok) {
        say(result.error ?? `${verb} failed`, 'err');
      } else {
        const heard = result.body?.heard;
        const told = typeof heard === 'number' && heard > 0 ? ` · ${heard} player${heard === 1 ? '' : 's'} were warned` : '';
        say(`${verb} accepted${result.body?.pid ? ` · pid ${result.body.pid}` : ''}${told}`, 'ok');
      }
      await refresh();
    };

    start.addEventListener('click', () => void act('start'));
    stop.addEventListener('click', () => void act('stop'));
    restart.addEventListener('click', () => void act('restart'));

    const paintStatus = (body: SupervisorBody): void => {
      latest = body;
      const { server, supervisor, game } = body;
      const running = server.state === 'up' || server.state === 'starting';
      start.disabled = running;
      stop.disabled = !running && server.state !== 'backoff';
      restart.disabled = false;

      render(
        statusCard,
        el('h3', {}, 'Game server'),
        el(
          'p',
          { class: server.state === 'gave-up' ? 'note warn' : 'note' },
          el('span', { class: `dot ${running ? 'on' : 'off'}` }),
          ` ${server.detail}`,
        ),
        el('div', { class: 'row' }, start, stop, restart),
        flash,
        el(
          'dl',
          { class: 'kv' },
          el('dt', {}, 'state'), el('dd', {}, server.state),
          el('dt', {}, 'pid'), el('dd', {}, server.pid === null ? '—' : String(server.pid)),
          el('dt', {}, 'uptime'), el('dd', {}, server.uptimeMs === null ? '—' : duration(server.uptimeMs)),
          el('dt', {}, 'came up in'), el('dd', {}, server.readyMs === null ? '—' : `${server.readyMs} ms`),
          el('dt', {}, 'restarts'), el('dd', {}, String(server.restarts)),
          el(
            'dt',
            {},
            'crashes in a row',
          ),
          el('dd', {}, `${server.failures} of ${supervisor.giveUpAfter} before it gives up`),
          el('dt', {}, 'last exit'),
          el(
            'dd',
            {},
            server.lastExit
              ? `${server.lastExit.text} — after ${duration(server.lastExit.ranMs)}`
              : el('span', { class: 'muted' }, 'has not exited this session'),
          ),
          el('dt', {}, 'players online'),
          el('dd', {}, game.reachable ? String(game.players ?? 0) : el('span', { class: 'muted' }, 'not answering')),
          el('dt', {}, 'game port'), el('dd', {}, String(supervisor.gamePort)),
        ),
        server.state === 'backoff' && server.backoffUntil
          ? el(
              'p',
              { class: 'note' },
              `Restarting on its own in ${Math.max(0, Math.round((server.backoffUntil - Date.now()) / 1000))}s — ` +
                `attempt ${server.attempt} of ${supervisor.giveUpAfter}. The wait doubles each time, so a server ` +
                'that cannot boot fails slowly and legibly instead of hammering.',
            )
          : null,
        server.state === 'gave-up'
          ? el(
              'p',
              { class: 'note warn' },
              'The supervisor has stopped trying. Read the log below for the first crash — it is the one with ' +
                'the real cause above it — then press Start.',
            )
          : null,
      );
    };

    const paintLog = (body: SupervisorLogBody): void => {
      logPane.textContent = body.lines.length
        ? body.lines
            .map((line) => `${line.stream === 'sup' ? '»' : line.stream === 'err' ? '!' : ' '} ${line.text}`)
            .join('\n')
        : 'nothing yet';
      logNote.textContent = body.dropped
        ? `${body.total} lines since the supervisor started · ${body.dropped} have fallen out of the ring`
        : `${body.total} lines since the supervisor started`;
      if (pinned) logPane.scrollTop = logPane.scrollHeight;
    };

    const refresh = async (): Promise<void> => {
      const [status, tail] = await Promise.all([
        callSupervisor<SupervisorBody>('GET', '/status'),
        callSupervisor<SupervisorLogBody>('GET', `/log?limit=${TAIL}`),
      ]);
      if (status.ok && status.body) {
        paintStatus(status.body);
      } else {
        render(
          statusCard,
          el('h3', {}, 'Game server'),
          el('p', { class: 'flash err' }, status.error ?? 'the supervisor is not answering'),
          el(
            'p',
            { class: 'note' },
            'This section talks to the supervisor on 8790, not to the game server — so this message means the ' +
              'supervisor itself is not running. Start it with `npm run supervisor`, or run the whole stack with ' +
              '`npm run dev:supervised`.',
          ),
        );
        start.disabled = stop.disabled = restart.disabled = true;
      }
      if (tail.ok && tail.body) paintLog(tail.body);
    };

    render(
      root,
      el('h2', {}, 'Server'),
      el(
        'p',
        { class: 'note' },
        'Start, stop and restart the game server, and read what it is saying. This is the one section served by ' +
          'the supervisor rather than by the game — which is why it still answers when everything else here ' +
          'does not.',
      ),
      statusCard,
      el(
        'div',
        { class: 'card' },
        el('h3', {}, 'Recent output'),
        el(
          'p',
          { class: 'note' },
          'The last lines of the game server’s console, with the supervisor’s own notes marked ». Errors are ' +
            'marked !. A tail, not an archive — mutating admin operations are audited separately in ' +
            'data/admin-audit.jsonl.',
        ),
        logPane,
        logNote,
      ),
    );

    void refresh();
    // Faster than the dashboard's 5s: this is the pane somebody watches *during* a restart, and a
    // five-second poll makes a 500 ms boot look like a hang.
    timer = window.setInterval(() => void refresh(), 1500);
  },
  unmount(): void {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
  },
};
