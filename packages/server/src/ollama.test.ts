/**
 * The two halves of drafting that can be tested without a model: what gets sent, and what is done
 * with what comes back.
 *
 * The generation itself is one `fetch`, exercised here with a fake so the shape of a failure is
 * pinned — a model that is not installed and a model that is merely slow must not read the same.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPrompt, draftDescription, listModels, tidy, violations, type DraftRequest } from './ollama.ts';

function request(over: Partial<DraftRequest> = {}): DraftRequest {
  return {
    model: 'qwen2.5:14b',
    brief: 'a war room high in the guard tower',
    room: { name: 'Tactical Room', sector: 'inside', zone: 'IceCrag Castle' },
    nearby: [{ name: "Western Guard's Walk", description: 'There is no view to the outside here.', dir: 'north' }],
    samples: [{ name: 'A Table In the Banquet Hall', description: '&+yThis is the main Banquet Hall.&N' }],
    ...over,
  };
}

/** A fetch that answers with whatever is given, so failure shapes can be driven exactly. */
function fakeFetch(answer: { ok?: boolean; status?: number; json?: unknown; text?: string } | Error): typeof fetch {
  return (async () => {
    if (answer instanceof Error) throw answer;
    return {
      ok: answer.ok ?? true,
      status: answer.status ?? 200,
      json: async () => answer.json,
      text: async () => answer.text ?? '',
    } as Response;
  }) as unknown as typeof fetch;
}

describe('the prompt', () => {
  it('shows the style rather than describing it', () => {
    const prompt = buildPrompt(request());
    assert.match(prompt, /EXAMPLES/);
    assert.match(prompt, /This is the main Banquet Hall/);
  });

  it('strips colour codes out of the examples', () => {
    // Left in, they teach the model to emit `&+y` — and a malformed code is not a cosmetic failure,
    // it is a literal ampersand in the middle of a sentence in the game.
    const prompt = buildPrompt(request());
    assert.ok(!prompt.includes('&+y'), 'no colour codes reach the model');
    assert.ok(!prompt.includes('&N'));
  });

  it('forbids the two things a model reaches for unprompted', () => {
    // Measured on the shipped world: 16 of 216 descriptions mention exits, and 1 of 216 says "you".
    // Left unsaid, a model writes "You find yourself in a dark room. Exits: north."
    const prompt = buildPrompt(request());
    assert.match(prompt, /Never write "you"/);
    assert.match(prompt, /Do not list or mention exits/);
  });

  it('puts the brief last, where it will not be diluted', () => {
    const prompt = buildPrompt(request({ brief: 'THE BRIEF' }));
    const briefAt = prompt.indexOf('THE BRIEF');
    assert.ok(briefAt > prompt.indexOf('EXAMPLES'), 'after the examples');
    assert.ok(briefAt > prompt.indexOf('ADJACENT'), 'after the neighbours');
  });

  it('carries the adjacent rooms, so a corner of a hall is a corner of that hall', () => {
    const prompt = buildPrompt(request());
    assert.match(prompt, /north: Western Guard's Walk/);
  });

  it('names a neighbour that has no quotable prose, and quotes one that has', () => {
    // The cascade fix's shape. A neighbour whose text was machine-written arrives here stripped of
    // it — but still named, because the *name* is what places this room: a room beside a Gigantic
    // Duskwood writes about duskwood whether or not anybody has written the duskwood's own prose.
    const prompt = buildPrompt(
      request({
        nearby: [
          { name: 'A Gigantic Duskwood', dir: 'north' },
          { name: 'The West Hall', description: 'A twelve foot tapestry covers the wall.', dir: 'south' },
        ],
      }),
    );
    assert.match(prompt, /north: A Gigantic Duskwood/, 'named even with nothing to quote');
    assert.match(prompt, /twelve foot tapestry/, 'and the quotable one is quoted');
  });

  it('tells the model to place itself by the neighbours rather than copy them', () => {
    // The old wording was "Stay consistent with these", and pointed at freshly-generated prose the
    // model read that as "reproduce these": all 37 rooms of one Stump Bog title came out identical.
    const prompt = buildPrompt(request());
    assert.match(prompt, /Do NOT copy their wording/);
  });

  it('holds together with no samples and no neighbours', () => {
    // The Stag Forest has prose for 0 of 98 rooms — there is nothing to show it, and the first room
    // written in a zone must still be writable.
    const prompt = buildPrompt(request({ samples: [], nearby: [] }));
    assert.ok(!prompt.includes('EXAMPLES'));
    assert.ok(!prompt.includes('ADJACENT'));
    assert.match(prompt, /NOW WRITE THIS ROOM/);
  });
});

describe('tidying a draft', () => {
  it('drops a conversational opener', () => {
    assert.equal(tidy("Here is the description:\n\nStone walls rise."), 'Stone walls rise.');
    assert.equal(tidy('**The Tactical Room**\n\nStone walls rise.'), 'Stone walls rise.');
  });

  it('unwraps the whole answer from quotes', () => {
    assert.equal(tidy('"Stone walls rise."'), 'Stone walls rise.');
  });

  it('removes markdown emphasis that would print as asterisks', () => {
    assert.equal(tidy('The **cold** wind and *old* stone.'), 'The cold wind and old stone.');
  });

  it('normalises punctuation to ASCII, because the world is ASCII', () => {
    // Measured across the 315 real descriptions: 110 straight quotes, zero curly, zero em dashes.
    assert.equal(tidy('IceCrag’s halls — “cold” and still…'), 'IceCrag\'s halls - "cold" and still...');
  });

  it('unwraps hard wrapping but keeps paragraph breaks', () => {
    assert.equal(tidy('A long\nwrapped line.\n\nA second\nparagraph.'), 'A long wrapped line.\n\nA second paragraph.');
  });
});

describe('rules a draft can be caught breaking', () => {
  it('catches the second person, which is the rule models break most', () => {
    // Told six times not to, qwen still wrote "The trunks of ancient oak trees rise around you".
    // Across a 25-room batch that is eight hand-edits, so it is caught rather than hoped about.
    assert.deepEqual(violations('The trunks rise around you.'), ['addresses the reader as "you"']);
    assert.deepEqual(violations('Stone rises on every side.'), []);
  });

  it('catches exits smuggled back in as prose', () => {
    assert.deepEqual(violations('Exits: north and south.'), ['mentions exits or directions']);
    assert.deepEqual(violations('To the east lies a hall.'), ['mentions exits or directions']);
    // A path *in* the room is physical detail and stays: the rule is about where it leads.
    assert.deepEqual(violations('A narrow path winds between the bushes, worn smooth.'), []);
  });
});

describe('talking to Ollama', () => {
  it('retries once when the first draft breaks a rule, and says so', async () => {
    const answers = ['The oaks rise around you.', 'The oaks rise on every side.'];
    let calls = 0;
    const fetchImpl = (async () => {
      const text = answers[calls++];
      return { ok: true, status: 200, json: async () => ({ response: text }), text: async () => '' } as Response;
    }) as unknown as typeof fetch;

    const result = await draftDescription(request(), fetchImpl);
    assert.equal(calls, 2);
    assert.equal(result.ok && result.description, 'The oaks rise on every side.');
    assert.deepEqual(result.ok && result.retriedFor, ['addresses the reader as "you"']);
  });

  it('does not retry a clean draft', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return { ok: true, status: 200, json: async () => ({ response: 'Stone rises.' }), text: async () => '' } as Response;
    }) as unknown as typeof fetch;

    const result = await draftDescription(request(), fetchImpl);
    assert.equal(calls, 1);
    assert.deepEqual(result.ok && result.retriedFor, []);
  });

  it('keeps the second draft even if it also breaks the rule — one retry is the whole budget', async () => {
    const fetchImpl = (async () =>
      ({ ok: true, status: 200, json: async () => ({ response: 'It rises around you.' }), text: async () => '' }) as Response
    ) as unknown as typeof fetch;
    const result = await draftDescription(request(), fetchImpl);
    // Returned rather than failed: a draft is offered for review, and a model that breaks the rule
    // twice has told you this one is worth reading before keeping — which is the default anyway.
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.retriedFor.length, 1);
  });

  it('returns the description when the model answers', async () => {
    const result = await draftDescription(
      request(),
      fakeFetch({ json: { response: '  Stone walls rise.  ' } }),
      (() => { let t = 0; return () => (t += 1200); })(),
    );
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.description, 'Stone walls rise.');
  });

  it('passes Ollama\'s own refusal through, because it names the model', async () => {
    const result = await draftDescription(
      request({ model: 'nosuchmodel' }),
      fakeFetch({ ok: false, status: 404, text: 'model "nosuchmodel" not found' }),
    );
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : '', /not found/);
  });

  it('tells a timeout apart from a refusal, because the advice differs', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const result = await draftDescription(request(), fakeFetch(timeout));
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : '', /cold start|smaller one/);
  });

  it('refuses an empty answer rather than authoring nothing', async () => {
    const result = await draftDescription(request(), fakeFetch({ json: { response: '   ' } }));
    assert.equal(result.ok, false);
  });

  it('reports no models rather than throwing when Ollama is not running', async () => {
    // Not installed is an ordinary state of a machine. The panel should say so calmly, in the place
    // a dropdown would have been.
    assert.deepEqual(await listModels(fakeFetch(new Error('ECONNREFUSED'))), []);
  });
});
