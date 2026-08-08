/**
 * The supervisor's decisions, tested without a process.
 *
 * These are the rules a live drive cannot exercise cheaply: proving the give-up threshold means
 * crashing a real server six times, and proving the healthy-run reset means waiting a minute
 * between two of them. The whole reason `supervisor-policy.ts` holds no I/O is so that both are
 * three lines here instead.
 *
 * The two that matter most are the crash-loop pair — that a fast crash *escalates* and a crash
 * after a healthy run *does not* — because getting the second one wrong produces a supervisor that
 * gives up on a server which has been running fine for a week, and it would take a week to notice.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BACKOFF_MS,
  GIVE_UP_AFTER,
  HEALTHY_MS,
  LOOPBACK,
  LogRing,
  describeExit,
  isPending,
  isRunning,
  nextFailureCount,
  restartDecision,
} from './supervisor-policy.ts';

describe('reading an exit', () => {
  it('calls the operator’s own stop a stop, whatever the code says', () => {
    // The graceful path exits 0 and the escalated one exits on a signal. Neither is a crash when it
    // was the operator who asked, or every Stop button press would be followed by a restart.
    assert.deepEqual(describeExit(0, null, true).reason, { t: 'stopped' });
    assert.equal(describeExit(0, null, true).crashed, false);
    assert.equal(describeExit(null, 'SIGKILL', true).crashed, false);
    assert.equal(describeExit(1, null, true).crashed, false);
  });

  it('treats a non-zero code as a crash and names the number', () => {
    const verdict = describeExit(1, null, false);
    assert.deepEqual(verdict.reason, { t: 'failed', code: 1 });
    assert.equal(verdict.crashed, true);
    assert.match(verdict.text, /exit code 1/);
  });

  it('treats an unasked-for kill as a crash', () => {
    // This is the live-drive case: an operator kills the child by pid and the supervisor must bring
    // it back rather than read the death as intentional.
    const verdict = describeExit(null, 'SIGTERM', false);
    assert.deepEqual(verdict.reason, { t: 'signalled', signal: 'SIGTERM' });
    assert.equal(verdict.crashed, true);
    assert.match(verdict.text, /SIGTERM/);
  });

  it('does not restart a server that exited cleanly on its own', () => {
    // The supervisor cannot tell a deliberate shutdown from a quiet fall-over, and of the two
    // mistakes available, fighting an operator who meant it is the worse one.
    const verdict = describeExit(0, null, false);
    assert.deepEqual(verdict.reason, { t: 'clean' });
    assert.equal(verdict.crashed, false);
  });

  it('survives a null code with no signal rather than reporting NaN', () => {
    assert.deepEqual(describeExit(null, null, false).reason, { t: 'failed', code: -1 });
  });

  it('renders Windows’ forced-kill code beside its hex, and leaves small codes alone', () => {
    // `Stop-Process -Force` and Task Manager both arrive as an unsigned 0xffffffff, which as a
    // decimal says nothing to the person reading the status card. Measured in the live drive.
    const verdict = describeExit(4_294_967_295, null, false);
    assert.match(verdict.text, /4294967295 \(0xffffffff\)/);
    assert.equal(verdict.reason.t === 'failed' ? verdict.reason.code : -1, 4_294_967_295);
    assert.equal(describeExit(1, null, false).text, 'crashed with exit code 1');
  });
});

describe('counting consecutive failures', () => {
  it('clears the count on anything that is not a crash', () => {
    assert.equal(nextFailureCount(4, 10, false), 0, 'an operator stop is not a strike');
  });

  it('escalates while the child keeps dying quickly', () => {
    let failures = 0;
    for (const expected of [1, 2, 3, 4, 5]) {
      failures = nextFailureCount(failures, 200, true);
      assert.equal(failures, expected);
    }
  });

  it('starts again at one when the child had been healthy', () => {
    // The point of the whole rule: four earlier crashes must not be charged against a build that
    // has just proved it boots and runs.
    assert.equal(nextFailureCount(4, HEALTHY_MS, true), 1);
    assert.equal(nextFailureCount(4, HEALTHY_MS + 60_000, true), 1);
  });

  it('holds the count for a crash one millisecond short of healthy', () => {
    assert.equal(nextFailureCount(4, HEALTHY_MS - 1, true), 5, 'the boundary is inclusive');
  });
});

describe('when to try again', () => {
  it('walks the ladder in order', () => {
    const delays = [1, 2, 3, 4, 5].map((n) => {
      const decision = restartDecision(n);
      assert.equal(decision.t, 'restart');
      return decision.t === 'restart' ? decision.delayMs : -1;
    });
    assert.deepEqual(delays, [...BACKOFF_MS]);
  });

  it('gives up past the threshold rather than restarting for ever', () => {
    const decision = restartDecision(GIVE_UP_AFTER + 1);
    assert.equal(decision.t, 'give-up');
    assert.equal(decision.t === 'give-up' ? decision.attempts : -1, GIVE_UP_AFTER);
  });

  it('reports the attempt number, which is what the panel counts down', () => {
    const decision = restartDecision(3);
    assert.equal(decision.t === 'restart' ? decision.attempt : -1, 3);
  });

  it('clamps at the ladder’s last rung rather than walking off the end', () => {
    // Unreachable while the threshold equals the ladder's length; here so that raising one alone
    // cannot index past the array and hand `setTimeout` an undefined delay.
    const decision = restartDecision(BACKOFF_MS.length);
    assert.equal(decision.t === 'restart' ? decision.delayMs : -1, BACKOFF_MS[BACKOFF_MS.length - 1]);
  });
});

describe('the ring of recent output', () => {
  const ringAt = (capacity: number) => {
    let clock = 1_000;
    return new LogRing({ capacity, now: () => ++clock });
  };

  it('splits a chunk into lines and keeps them in order', () => {
    const ring = ringAt(10);
    ring.write('out', '[server] listening\n[world] 4 zones\n');
    assert.deepEqual(ring.tail().map((l) => l.text), ['[server] listening', '[world] 4 zones']);
  });

  it('holds a partial line until the newline that finishes it arrives', () => {
    // A pipe delivers whatever was in the buffer, so splitting each chunk on its own would shred
    // every stack trace into fragments — the exact output worth reading.
    const ring = ringAt(10);
    ring.write('out', '[server] listen');
    assert.deepEqual(ring.tail(), [], 'nothing complete yet');
    ring.write('out', 'ing on 8899\n');
    assert.deepEqual(ring.tail().map((l) => l.text), ['[server] listening on 8899']);
  });

  it('keeps the two streams’ partials apart', () => {
    // Interleaved stdout and stderr would otherwise splice one line into the middle of another.
    const ring = ringAt(10);
    ring.write('out', 'hello ');
    ring.write('err', 'Error: bad');
    ring.write('out', 'world\n');
    ring.write('err', ' zone\n');
    assert.deepEqual(ring.tail().map((l) => `${l.stream}:${l.text}`), ['out:hello world', 'err:Error: bad zone']);
  });

  it('publishes the last unterminated line when the stream closes', () => {
    // A process that dies mid-write leaves no trailing newline, and that line usually names the cause.
    const ring = ringAt(10);
    ring.write('err', 'FATAL: out of memo');
    ring.close('err');
    assert.deepEqual(ring.tail().map((l) => l.text), ['FATAL: out of memo']);
  });

  it('closing twice does not repeat the line', () => {
    const ring = ringAt(10);
    ring.write('err', 'half');
    ring.close('err');
    ring.close('err');
    assert.equal(ring.tail().length, 1);
  });

  it('strips the carriage return Windows output arrives with', () => {
    const ring = ringAt(10);
    ring.write('out', 'listening\r\n');
    assert.deepEqual(ring.tail().map((l) => l.text), ['listening']);
  });

  it('drops the oldest lines past capacity and says how many', () => {
    const ring = ringAt(3);
    for (let i = 1; i <= 5; i++) ring.write('out', `line ${i}\n`);
    assert.deepEqual(ring.tail().map((l) => l.text), ['line 3', 'line 4', 'line 5']);
    assert.equal(ring.dropped, 2, 'so a truncated tail can say it is truncated');
    assert.equal(ring.total, 5, 'the sequence counts everything ever admitted');
  });

  it('interleaves the supervisor’s own voice with the child’s', () => {
    const ring = ringAt(10);
    ring.note('starting the game server');
    ring.write('out', '[server] listening\n');
    assert.deepEqual(ring.tail().map((l) => l.stream), ['sup', 'out']);
  });

  it('answers “only what I have not seen” by sequence', () => {
    const ring = ringAt(10);
    ring.write('out', 'a\nb\nc\n');
    const seen = ring.tail()[1]!.seq;
    assert.deepEqual(ring.tail(200, seen).map((l) => l.text), ['c']);
  });

  it('bounds the tail to the limit asked for, newest last', () => {
    const ring = ringAt(10);
    for (let i = 1; i <= 6; i++) ring.write('out', `line ${i}\n`);
    assert.deepEqual(ring.tail(2).map((l) => l.text), ['line 5', 'line 6']);
  });

  it('stamps every line with the clock it was given', () => {
    const ring = ringAt(10);
    ring.write('out', 'one\ntwo\n');
    const [first, second] = ring.tail();
    assert.ok(first && second && second.at > first.at);
  });
});

describe('what a state means', () => {
  it('knows which states have a process behind them', () => {
    assert.equal(isRunning({ t: 'up', pid: 42, since: 0 }), true);
    assert.equal(isRunning({ t: 'starting' }), true);
    assert.equal(isRunning({ t: 'backoff', until: 0, attempt: 1 }), false);
    assert.equal(isRunning({ t: 'stopped', by: 'operator' }), false);
    assert.equal(isRunning({ t: 'gave-up', attempts: 5 }), false);
  });

  it('separates “nothing is running” from “nothing is coming back”', () => {
    // The distinction the panel draws: only one of these means go and read the log first.
    assert.equal(isPending({ t: 'backoff', until: 0, attempt: 2 }), true);
    assert.equal(isPending({ t: 'gave-up', attempts: 5 }), false);
    assert.equal(isPending({ t: 'stopped', by: 'operator' }), false);
  });
});

describe('the loopback set', () => {
  it('carries the three spellings a local socket reports', () => {
    // Node reports an IPv4 loopback as `::ffff:127.0.0.1` when the listener is dual-stack, and a
    // gate that knew only `127.0.0.1` would refuse the operator's own browser.
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.ok(LOOPBACK.has(address));
    assert.equal(LOOPBACK.has('10.0.0.4'), false);
  });
});
