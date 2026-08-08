/**
 * The command table, the parser, and target resolution.
 *
 * ## Why the *server* parses the text
 *
 * The client sends the line the player typed, not a command it resolved itself. That is still an
 * intent — "I want to open east", never "the door is now open" — and it has to be this way round for
 * three reasons that are all the same reason:
 *
 * - **Which command `sa` means is a game rule.** Abbreviation is resolved by table order (below), so
 *   two clients that each held a copy would eventually disagree, and the disagreement would show up
 *   as one player's muscle memory silently doing something else.
 * - **Target resolution is gated on visibility**, which only the server knows. A client resolving
 *   `orc` to an entity id is either guessing or reading something it was never told.
 * - **The pre-dispatch gauntlet is server business.** Position legality, and later the stealth
 *   allowlist, sit at the one point every command passes through — see `dispatch` in `index.ts`.
 *
 * Everything here is pure: no sockets, no simulation, no world. The handlers live in `index.ts`
 * because they need all three, and the split is the same one `act.ts` makes.
 */

import { DIRECTIONS, type Direction, type Requirement } from '@mygame/shared';

/* -------------------------------------------------------------------------- */
/* The table                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every command, **in priority order**.
 *
 * The order is the entire mechanism, and it is not alphabetical, not grouped by theme, and not
 * arbitrary. A typed word is matched exact-first and then by leftmost prefix, and **the first row
 * that matches wins** — so `n` is north because north is above every other `n` word, `e` is east
 * rather than exits, `s` is south rather than say, and `w` is west rather than who. Every Diku
 * descendant behaves this way and every player of one has it in their fingers.
 *
 * Sorting this list, or replacing the scan with a hash map, breaks all of that **invisibly**: every
 * command still works when typed in full, and every abbreviation quietly means something else. The
 * relative order of the commands we share with Duris is its own (`interp.c`, `const char *command[]`);
 * ours are appended rather than interleaved, so the inherited part stays comparable.
 */
export const COMMANDS = [
  'north',
  'east',
  'south',
  'west',
  'up',
  'down',
  'exits',
  'kill',
  'look',
  'say',
  // Phase 21's channels. After `say`, `sit` and friends, so no existing abbreviation moves: `g`
  // stays `get`, `t` was nobody's, and `gs`/`go`/`re`/`te` are the shortest paths to the four.
  'gossip',
  'gsay',
  'tell',
  'reply',
  'help',
  'who',
  'stand',
  'sit',
  'rest',
  'sleep',
  'wake',
  'kneel',
  // Below here are ours. Duris has open/close far down its own table; nothing we ship abbreviates
  // into them, so appending keeps the inherited prefixes above untouched.
  'open',
  'close',
  // After `open`, which is where `interp.c`'s own array puts it. Nothing above begins with `f`, so `f`
  // is flee — which is what a player under pressure will actually type.
  'flee',
  'stop',
  // Duris has no `affects` command — it prints the same list inside `score`, which we do not have
  // because the HUD is the score sheet. Appended rather than placed at `score`'s slot for the usual
  // reason: nothing above starts with `a`, so `a` becomes `affects` and not one existing abbreviation
  // moves.
  'affects',
  // Appended, and the position is load-bearing: table order is the abbreviation tie-break, so putting
  // `loot` *after* `look` leaves `l` and `lo` meaning look — which is what a Diku player's fingers
  // expect — and `loo` is the shortest thing that reaches this. Placing it above `look` would silently
  // rebind the most-used command in the game.
  'loot',
  // Phase 15b. All five appended, and every one of them lands on the abbreviation a Diku player
  // already has in their fingers — which is worth checking rather than assuming, because it falls out
  // of what is *above* them here:
  //   `g`   → get        (nothing above starts with g)
  //   `d`   → down, `dr` → drop      (down is above, and `d` is down in every Diku)
  //   `w`   → west, `wea` → wear     (west and who are above)
  //   `r`   → rest, `rem` → remove   (rest is above)
  //   `i`   → inventory  (nothing above starts with i)
  // Moving any of these above the commands they sit under would rebind a movement key.
  'get',
  'drop',
  'wear',
  'remove',
  'inventory',
  // 15c. `p` is free — nothing above starts with it — so `put` lands on its own initial, which is
  // what Diku gives it too.
  'put',
  // 15c, and it costs no prefix anybody was using: `w` is west and `wea` is wear, both above, so
  // `wie` is the shortest thing that reaches this — which is what Diku gives it as well.
  'wield',
  // Phase 17. Four appended, and each lands where a Diku player's fingers already are — which falls
  // out of what is above rather than being arranged:
  //   `b`   → buy       (nothing above starts with b)
  //   `li`  → list      (`l` and `lo` stay look, which is the most-used command in the game)
  //   `se`  → sell      (south, say, sit, sleep, stand and stop are all above; none is `se`)
  //   `v`   → value     (nothing above starts with v)
  'buy',
  'list',
  'sell',
  'value',
  // Owner's ask (2026-08-05), the moment V3's first bubble went up: *"we will need a whisper option
  // so we can talk to just one person in the room… so we aren't all just talking over each other and
  // filling the room with speech bubbles."* Appended, and `whi` is the shortest thing that reaches
  // it: `w` is west and `wh` is who, both above, and neither moves.
  'whisper',
  // Owner's ask (2026-08-05): *"some other kind of command other than drop that will just destroy an
  // item so it isn't dropped, it is just gone."* The source has it — `do_junk`, `actobj.c:1630` — and
  // `j` is free, since nothing above starts with one. A single letter reaching a destructive verb
  // would be alarming anywhere else; here it is safe by construction, because `junk` never destroys
  // anything on its own. It asks, and the answer is a second line.
  'junk',
  // Phase 18. Appended, and it costs no prefix anybody was using: `f` is flee and `fl` is flee, both
  // above, so `fo` is the shortest thing that reaches this — which is what Diku gives it too.
  'follow',
  // Phase 18's second half. Four appended, and every one lands on a free prefix — checked against the
  // rows above rather than assumed, because table order is the whole mechanism:
  //   `co`  → consent   (`c` and `cl` stay close; nothing above is `co`)
  //   `gr`  → group     (`g` and `ge` stay get)
  //   `gs`  → gsay      (and `gr`/`gs` do not collide with each other)
  //   `di`  → disband   (`d` and `do` stay down, `dr` stays drop)
  // Not one existing abbreviation moves, which is the bar every appended command has to clear.
  'consent',
  'group',
  'gsay',
  'disband',
  // Phase 19. `s` is south and `sa`/`si`/`sl`/`st` are say, sit, sleep and stand/stop — all above — so
  // `sk` is the shortest thing that reaches this, and nothing moves. Duris spells it `skills` too.
  'skills',
  // Phase 19 slice 3. `b` is buy and `ba` reaches nothing above, so `ba` is bash; `k` is kill — the one
  // letter nobody would want moved — and `ki` still reaches kill, so kick needs `kic`. Duris gives both
  // the same shortest forms for the same reason.
  'bash',
  'kick',
  // Phase 19 slice 4. `rest` and `remove` sit above — `r` and `re` are rest, `rem` is remove — so
  // `resc` is the shortest thing that reaches this, which is what Duris' own table gives it too.
  'rescue',
  // Owner's report, 2026-08-07: `inventory` was printing the worn kit under the carried list, and a
  // dressed character with an empty bag read it as the wrong answer. Diku's own split: `inventory`
  // carries, `equipment` wears. `e` is east and `ex` is exits, both above, so `eq` is the shortest
  // thing that reaches this — the abbreviation every Diku player's fingers already use.
  'equipment',
  // Phase 20 slice 2. In Duris' own table `cast` sits high enough that `c` reaches it; our inherited
  // block froze with `close` above, so `ca` is the shortest thing that reaches this and `c` stays
  // close. A caster's fingers will grumble; moving `close` would rebind a door key mid-game, which
  // is the worse trade. Revisit if Phase 21 makes casters the common case.
  'cast',
  // Phase 20 slice 4. `r`/`re` are rest, `rem` is remove and `resc` is rescue, all above, so `rec`
  // is the shortest thing that reaches this — Duris' own shortest form, for the same reason.
  'recite',
  // Owner's ask, 2026-08-07, beside `skills` in spirit. Nothing above begins with `sp` — south,
  // say, sit, sleep, sell, skills, stand and stop all branch elsewhere by their second letter — so
  // `sp` is the shortest thing that reaches this, and not one existing abbreviation moves.
  'spells',
  // Owner's ask, 2026-08-07: potions. Nothing in the table starts with `q` but `junk`'s neighbour
  // — nothing at all, in fact — so `q` alone is quaff, which is what a Diku player's fingers reach
  // for mid-fight, spill risk and all.
  'quaff',
  // The meal beside the bottle, same evening. **It takes all three letters**: `e` and `ea` are
  // east — the prefix scan reaches 'east' first, and the drive that assumed otherwise walked the
  // taster two rooms up the trail — so only the exact word lands here, which is Diku's own
  // situation for exactly the same reason.
  'eat',
  // The last of the owner's three typed-command asks, same evening. `r` and `re` are rest, `rem`
  // is remove, `rec` is recite and `resc` is rescue, all above — so `rea` is the shortest thing
  // that reaches this. In the source `read` is one line: `do_look(ch, "at <arg>")` — reading IS
  // looking at an extra description, and ours transcribes the same search order.
  'read',
] as const;

export type Command = (typeof COMMANDS)[number];

/**
 * Resolves a typed word to a command: exact match first, then leftmost prefix, table order winning.
 *
 * Two full passes rather than one, and the order of the passes matters. A single prefix pass would
 * let a longer command sitting higher in the table swallow a shorter one below it — type the shorter
 * command's full name and get the other. Duris does the same two passes for the same reason
 * (`old_search_block`, mode 2).
 *
 * An empty word matches nothing. Duris' own helper treats a zero-length argument as "already found"
 * and returns the first row, which would make a bare Enter walk you north.
 */
export function lookupCommand(word: string): Command | undefined {
  const key = word.trim().toLowerCase();
  if (!key) return undefined;
  for (const name of COMMANDS) if (name === key) return name;
  for (const name of COMMANDS) if (name.startsWith(key)) return name;
  return undefined;
}

/** Splits a typed line into its first word and everything after it, both trimmed. */
export function splitCommand(line: string): { readonly word: string; readonly rest: string } {
  const trimmed = line.trim();
  const space = trimmed.search(/\s/);
  if (space === -1) return { word: trimmed, rest: '' };
  return { word: trimmed.slice(0, space), rest: trimmed.slice(space + 1).trim() };
}

/** The six directions, as commands. Movement is the only command family that is also a direction. */
const DIRECTION_COMMANDS = new Set<string>(DIRECTIONS);

export function directionOf(command: Command): Direction | undefined {
  return DIRECTION_COMMANDS.has(command) ? (command as Direction) : undefined;
}

/* -------------------------------------------------------------------------- */
/* What each command needs of the body                                         */
/* -------------------------------------------------------------------------- */

/**
 * The minimum posture and status each command requires, transcribed from the real command table.
 *
 * Every row here is `interp.c`'s own, read off the `CMD_Y`/`CMD_N` registration rather than guessed —
 * for example `CMD_Y(CMD_WAKE, STAT_SLEEPING + POS_PRONE, ...)` and
 * `CMD_Y(CMD_HIT, STAT_NORMAL + POS_STANDING, ...)`. The interesting ones are worth reading:
 *
 * - **`help` and `who` require `dead`** — the floor of the status ladder, so they always work. You can
 *   read the help while your corpse is cooling, which is exactly right for anything that is interface
 *   rather than action.
 * - **`wake` requires `sleeping`** — it is the *only* command a sleeper can issue, and the reason
 *   `sleep` is not a trap.
 * - **`exits`, `open` and `close` need to be sitting up.** Reaching a door handle from the floor is
 *   the kind of small physical honesty that makes posture feel like a body rather than a stat.
 * - **`look` and `say` need only `prone`.** Lying on the floor you can still see and still talk, which
 *   is what makes the dying window playable rather than a blackout.
 *
 * Movement is the one divergence: Duris asks `STAT_NORMAL + POS_PRONE`, and we ask for standing. See
 * `Simulation.canMove` for why — Duris had no continuous movement to make a seated glide look absurd.
 */
export const COMMAND_REQUIREMENTS: Readonly<Record<Command, Requirement>> = {
  // `inCombat: false` is `CMD_N` in `interp.c`. Absent means allowed. See `DESIGN-engagement.md` §6, from
  // which every one of these rows is transcribed rather than chosen — and note the four that are more
  // interesting than the rule they state: posture yes but status no, `open` yes but `close` no, and `who`
  // refused though it works while dead.
  north: { status: 'normal', posture: 'standing', inCombat: false },
  east: { status: 'normal', posture: 'standing', inCombat: false },
  south: { status: 'normal', posture: 'standing', inCombat: false },
  west: { status: 'normal', posture: 'standing', inCombat: false },
  up: { status: 'normal', posture: 'standing', inCombat: false },
  down: { status: 'normal', posture: 'standing', inCombat: false },

  exits: { status: 'resting', posture: 'sitting' },
  kill: { status: 'normal', posture: 'standing' },
  look: { status: 'resting', posture: 'prone' },
  say: { status: 'resting', posture: 'prone' },
  // Phase 21's channels share say's own gate: a resting body can talk, a sleeping one cannot.
  gossip: { status: 'resting', posture: 'prone' },
  tell: { status: 'resting', posture: 'prone' },
  reply: { status: 'resting', posture: 'prone' },
  help: { status: 'dead', posture: 'prone' },
  // Refused mid-fight though it is pure interface and works while *dead*. The source's judgement is that a
  // global out-of-world scan is not a thing you do mid-swing; followed rather than argued with.
  who: { status: 'dead', posture: 'prone', inCombat: false },

  // Posture yes, status no: you can be knocked about and get back up, but you cannot opt out of
  // consciousness mid-fight.
  stand: { status: 'resting', posture: 'prone' },
  sit: { status: 'resting', posture: 'prone' },
  rest: { status: 'resting', posture: 'prone', inCombat: false },
  sleep: { status: 'sleeping', posture: 'prone', inCombat: false },
  wake: { status: 'sleeping', posture: 'prone' },
  kneel: { status: 'resting', posture: 'prone' },

  // You may flee through a door. You may not slam it behind you.
  open: { status: 'resting', posture: 'sitting' },
  close: { status: 'resting', posture: 'sitting', inCombat: false },
  // `CMD_Y(CMD_FLEE, STAT_NORMAL + POS_PRONE, ...)`, and the posture floor is the interesting half: you
  // may try from the floor, and the attempt is then spent scrambling to your feet rather than refused
  // (`do_flee`). Allowed in combat for the obvious reason — §5 makes it the only voluntary way out.
  flee: { status: 'normal', posture: 'prone' },
  // Ours: cancelling a walk you are no longer taking should never be refused.
  stop: { status: 'dead', posture: 'prone' },
  // Interface rather than action, so it sits at the floor with `help` and `who`. Reading what is
  // wrong with you is exactly what you want to be able to do while it is killing you.
  affects: { status: 'dead', posture: 'prone' },
  // `loot` is `get` applied to a body — the source has no separate command for it, you type
  // `get all from corpse` — so it takes `get`'s row exactly: `CMD_Y(CMD_GET, STAT_RESTING +
  // POS_SITTING, ...)`. **Allowed in combat**, which corrects what this row said in Phase 14: the
  // comment claimed the source refused `get` mid-fight, and `CMD_Y` means the opposite. Snatching
  // something off the floor while swinging is a real MUD tactic and the source permits it.
  loot: { status: 'resting', posture: 'sitting' },

  // Phase 15b, transcribed from `interp.c` rather than chosen — and the pattern is worth reading,
  // because four of the five are `CMD_Y` and the odd one out is the interesting one:
  //
  //   CMD_Y(CMD_GET,       STAT_RESTING + POS_SITTING)
  //   CMD_Y(CMD_DROP,      STAT_RESTING + POS_PRONE)
  //   CMD_N(CMD_WEAR,      STAT_RESTING + POS_SITTING)   ← the only refusal
  //   CMD_Y(CMD_REMOVE,    STAT_RESTING + POS_SITTING)
  //   CMD_Y(CMD_INVENTORY, STAT_RESTING + POS_PRONE)
  //
  // **You may take armour off mid-fight but not put it on.** That is not an inconsistency: shedding a
  // thing is one motion and donning it is several, and the asymmetry is what stops a fight being
  // paused to re-kit. Followed rather than argued with.
  get: { status: 'resting', posture: 'sitting' },
  // Prone, and allowed in combat: dropping what you are carrying is the classic thing a cornered
  // character does, and refusing it from the floor would take that away exactly when it matters.
  drop: { status: 'resting', posture: 'prone' },
  wear: { status: 'resting', posture: 'sitting', inCombat: false },
  remove: { status: 'resting', posture: 'sitting' },
  // Interface rather than action, and prone like `affects`: reading what you are carrying while it is
  // killing you is precisely when you want to.
  inventory: { status: 'resting', posture: 'prone' },
  // `CMD_N(CMD_PUT, STAT_RESTING + POS_SITTING, do_put, 0, TRUE)` — refused in combat, and it sits
  // beside `wear` as the other thing you do not do mid-swing. Rummaging in a bag while something is
  // hitting you is the same kind of several-motions act that donning armour is.
  put: { status: 'resting', posture: 'sitting', inCombat: false },
  // **`CMD_Y(CMD_WIELD, STAT_RESTING + POS_PRONE, do_wield, 0, TRUE)` — and the contrast with `wear`
  // two rows up is the whole reason `wield` is a separate verb rather than an alias.** The source
  // refuses `wear` in combat and allows `wield`, at *prone* rather than sitting: drawing a weapon is
  // one motion you can manage flat on your back with something standing over you, and buckling on a
  // breastplate is not. Transcribed rather than reasoned to, and it happens to be the distinction that
  // makes the split earn its keep.
  //
  // It takes nothing away that `remove` did not already allow: shedding gear mid-fight is legal (§15b
  // read `interp.c` for exactly this), so a two-hander displacing a shield in combat is a thing the
  // player could have done in two commands anyway.
  wield: { status: 'resting', posture: 'prone' },

  // Phase 17, and the transcription is more interesting than it looks. All four are `CMD_TRIG` in
  // `interp.c`, which is the macro for *"reserved keywords that don't DO anything, but are used to
  // trigger specials"* — their default handler is `do_not_here` and the shopkeeper's own routine is
  // what intercepts them. That macro sets `minimum_position = STAT_DEAD + POS_PRONE` and
  // `in_battle = TRUE` on every one, so the **command table imposes nothing at all**: it is the
  // keeper who refuses, not the parser.
  //
  // Followed rather than tidied. The temptation is to write `inCombat: false` because shopping
  // mid-swing sounds absurd — but that would be inventing a rule at the wrong layer, and the right
  // one is a keeper declining to serve somebody who is fighting *it*, which is a fact about the
  // keeper and lives in `shops.ts`.
  buy: { status: 'dead', posture: 'prone' },
  list: { status: 'dead', posture: 'prone' },
  sell: { status: 'dead', posture: 'prone' },
  value: { status: 'dead', posture: 'prone' },

  // `CMD_N(CMD_WHISPER, STAT_RESTING + POS_SITTING, …)` — and it is deliberately *stricter than
  // `say`* on both axes, which is the interesting part of the row. Speaking aloud works flat on your
  // back and mid-fight; leaning in to murmur to one person needs you upright enough to lean, and is
  // not something the source lets you do while swinging. Transcribed, not chosen.
  whisper: { status: 'resting', posture: 'sitting', inCombat: false },
  // `CMD_CNF_N(CMD_JUNK, STAT_RESTING + POS_SITTING, do_junk, 56)` — transcribed, and the two halves
  // of `CMD_CNF_N` are both here. `_N` is the refusal in combat, which puts it beside `wear` and `put`
  // as a thing you do not do mid-swing; `CNF` is the confirmation, which is not a *requirement* at all
  // and so does not live in this table — it is a pre-dispatch state, exactly as `interp.c:1343` has it.
  //
  // The level column reads 56, and it is **deliberately not transcribed**: `do_junk`'s own body
  // contradicts itself about `IS_TRUSTED` (an early return demands it, a later branch tests for its
  // absence), and whatever that resolves to in Duris, a verb whose whole purpose is letting a player
  // tidy their own bag has no business being restricted here. Ours is available to everybody.
  junk: { status: 'resting', posture: 'sitting', inCombat: false },
  // `CMD_Y(CMD_FOLLOW, STAT_RESTING + POS_SITTING, do_follow, 0, TRUE)` — transcribed, and the `_Y`
  // is the interesting half: **deciding who to walk behind is allowed mid-fight.** That reads
  // permissive until you notice it is the only way to arrange a retreat with somebody while the
  // fight that makes you want one is still going on. Walking is still refused — `stepRoom` gates on
  // the engagement, and `flee` is still the way out.
  follow: { status: 'resting', posture: 'sitting' },
  // Phase 18's four, and the interesting part is that they are all four different rows — which is
  // exactly the sort of thing that would have been flattened to one if they had been reasoned about
  // instead of read off `interp.c`:
  //
  //   CMD_Y(CMD_CONSENT, STAT_DEAD     + POS_PRONE)
  //   CMD_Y(CMD_GROUP,   STAT_RESTING  + POS_PRONE)
  //   CMD_Y(CMD_GSAY,    STAT_RESTING  + POS_PRONE)
  //   CMD_Y(CMD_DISBAND, STAT_SLEEPING + POS_PRONE)
  //
  // **`consent` works while you are dead**, which puts it with `help` and `who` at the floor of the
  // ladder — and unlike those two it is not interface, it is an act. It reads oddly until you notice
  // what consent is *for* in the source: it also drops your saving throws against that person's
  // spells, so the one moment you most need to be able to give it is while somebody is trying to
  // resurrect your corpse. Transcribed.
  //
  // **`disband` works while asleep** and `group` does not. Dissolving a party is one word said in your
  // sleep; reading a roster and enrolling people is not.
  consent: { status: 'dead', posture: 'prone' },
  group: { status: 'resting', posture: 'prone' },
  gsay: { status: 'resting', posture: 'prone' },
  disband: { status: 'sleeping', posture: 'prone' },
  // Interface rather than action, so it sits with `help`, `who`, `affects` and `inventory` at the floor
  // of the ladder: reading what you are good at while something is killing you is exactly when you want
  // to. Duris has no `skills` command to transcribe — proficiency is printed inside `practice` at a
  // guild — and inventing the row is the same call `affects` made for the same reason.
  skills: { status: 'dead', posture: 'prone' },
  // The same row for the same reason: what magic exists is interface, not action.
  spells: { status: 'dead', posture: 'prone' },
  // `CMD_Y(CMD_BASH, STAT_NORMAL + POS_STANDING, …)` and the same for kick — transcribed, and both halves
  // matter. **Standing**: you cannot kick from the floor, which is what makes a bash worth landing. And
  // **allowed in combat**, which is the whole point: these are things you do *during* a fight, and they are
  // the first verbs in the game that are.
  bash: { status: 'normal', posture: 'standing' },
  kick: { status: 'normal', posture: 'standing' },
  // `CMD_Y(CMD_RESCUE, STAT_NORMAL + POS_STANDING, …)` — bash and kick's row exactly, and for the same
  // reason: you cannot pull a fight onto yourself from the floor, and mid-combat is when it matters.
  rescue: { status: 'normal', posture: 'standing' },
  // `CMD_Y(CMD_EQUIPMENT, STAT_SLEEPING + POS_PRONE, …)` — readable while *asleep*, which is laxer than
  // inventory's resting: checking what you are wearing is interface, and the source treats it as such.
  equipment: { status: 'sleeping', posture: 'prone' },
  // The source registers `cast` at STAT_RESTING + POS_SITTING and then demands standing once per
  // second inside the wind-up, with a ground-casting skill roll as the sitting exception. We have no
  // ground-casting skill yet, so a seated start would only ever break on its first beat — requiring
  // standing up front is the same outcome said politely, and the skill arrives as its own row later.
  // Allowed in combat, which is most of the point.
  cast: { status: 'normal', posture: 'standing' },
  // Phase 20 slice 4, and both halves are the source's own registration
  // (`CMD_N(CMD_RECITE, STAT_RESTING + POS_PRONE, ...)`): recitable flat on your back — a scroll
  // asks nothing of the body, which is the whole classless point — and **refused mid-fight**, the
  // `CMD_N` half. A scroll is an opener and a utility, not combat spam; reciting an attack scroll
  // *starts* the fight (`IS_AGG_CMD` lists recite), and then you are in one and cannot recite again.
  recite: { status: 'resting', posture: 'prone', inCombat: false },
  // `CMD_Y(CMD_QUAFF, STAT_RESTING + POS_SITTING, ...)` — sitting up, and **allowed mid-fight**,
  // which is the whole reason the spill chance exists: drinking under a sword is legal and risky,
  // where reciting under one is simply refused. The asymmetry is the source's own and it reads
  // right — tipping a vial down your throat is one motion; an incantation is a paragraph.
  quaff: { status: 'resting', posture: 'sitting' },
  // `CMD_N(CMD_EAT, STAT_RESTING + POS_PRONE, ...)` — a meal can be taken lying down, and there is
  // no dinner under a sword: where the potion is one motion and worth a spill roll, a meal is a
  // sitting still, and the source refuses it in combat outright.
  eat: { status: 'resting', posture: 'prone', inCombat: false },
  // `CMD_N(CMD_READ, STAT_RESTING + POS_PRONE, ...)` (`interp.c:2598`) — readable flat on your
  // back like the scroll it is not, and refused mid-fight: nobody studies an inscription under a
  // sword. `look` beside it needs only `prone` and stays combat-legal; the difference is the
  // source's own, and it reads right — a glance is free, reading is attention.
  read: { status: 'resting', posture: 'prone', inCombat: false },
};

/* -------------------------------------------------------------------------- */
/* Target resolution                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A reference to something in the world: which keyword, and which one of them.
 *
 * `2.orc` is the second thing matching "orc". A bare `orc` is the first.
 */
export interface TargetRef {
  readonly keyword: string;
  /** 1-based. */
  readonly ordinal: number;
}

/**
 * Parses `2.orc` into an ordinal and a keyword — Duris' `get_number`.
 *
 * Three cases worth stating, because two of them are deliberate refusals rather than fallbacks:
 *
 * - No dot: ordinal 1.
 * - Digits before the dot: that ordinal, and the rest is the keyword.
 * - **Anything else before the dot**: `undefined`, meaning *nothing can match*. `get_number` returns
 *   0 here and every caller treats 0 as "no match" rather than as "try 1". So `foo.orc` and `.orc`
 *   find nothing, which is right: they are typos, and silently searching for `orc` instead would
 *   have the player attack whatever happened to be first.
 *
 * An ordinal of 0 is refused for the same reason — there is no zeroth orc.
 */
export function parseTargetRef(argument: string): TargetRef | undefined {
  const arg = argument.trim();
  if (!arg) return undefined;

  const dot = arg.indexOf('.');
  if (dot === -1) return { keyword: arg.toLowerCase(), ordinal: 1 };

  const prefix = arg.slice(0, dot);
  const keyword = arg.slice(dot + 1).trim().toLowerCase();
  if (!keyword) return undefined;
  if (!/^\d+$/.test(prefix)) return undefined;

  const ordinal = Number(prefix);
  if (ordinal < 1) return undefined;
  return { keyword, ordinal };
}

/**
 * Whether `keyword` matches one of the space-separated names in `namelist` — Duris' `isname`.
 *
 * **Whole word, no abbreviation, case-insensitive.** This is the rule that surprises people, and it
 * is the right one: commands abbreviate freely, *content keywords do not*. `kill or` does not find an
 * orc, because if it did then every ambiguous fragment a player typed in a hurry would resolve to
 * something, and the something would be whatever the room happened to list first.
 */
export function isName(keyword: string, namelist: readonly string[]): boolean {
  const key = keyword.trim().toLowerCase();
  if (!key) return false;
  return namelist.some((name) => name.toLowerCase() === key);
}

/**
 * Picks the `ordinal`th candidate whose keywords match, or nothing.
 *
 * `candidates` must already be in the order the game means to search. Duris fixes that order in
 * `generic_find` — characters in the room, then inventory, then equipment, then objects in the room —
 * and the ordering is a gameplay decision rather than an implementation detail: it is what makes
 * `wear ring` take yours rather than the one lying on the floor. Ours is the same idea with the
 * lists we actually have; the caller composes it, so the rule stays in one readable place at the
 * call site rather than being buried here.
 */
export function findTarget<T>(
  ref: TargetRef,
  candidates: readonly T[],
  keywordsOf: (candidate: T) => readonly string[],
): T | undefined {
  let seen = 0;
  for (const candidate of candidates) {
    if (!isName(ref.keyword, keywordsOf(candidate))) continue;
    if (++seen === ref.ordinal) return candidate;
  }
  return undefined;
}

/**
 * The words a thing answers to, derived from its display name.
 *
 * **The stopgap's end date arrived, and the field won — but as a union, not a replacement.** The
 * authored lists are read now (`keywords.ts`), and the measurement is why this function survives
 * beside them rather than being deleted as originally promised: authored-only would strip a working
 * name word from 6,121 items and 129 mobs, and leave 8 mobs answering to no word on screen at all —
 * "a bored soldier" is authored only as `guard`. So the name-split is the floor, the authored list
 * is the ceiling, and everything player-facing matches against both.
 *
 * Still the *whole* answer for what has no template: players, and corpses. The shared twin
 * (`wordsFromName`) differs only in stripping colour first; this one predates colour reaching names.
 */
const NOISE_WORDS = new Set(['a', 'an', 'the', 'of', 'some', 'and']);

export function keywordsFromName(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[\s,]+/)
    .map((word) => word.replace(/^[^\w-]+|[^\w-]+$/g, ''))
    .filter((word) => word.length > 0 && !NOISE_WORDS.has(word));
}

/* -------------------------------------------------------------------------- */
/* Flood control                                                               */
/* -------------------------------------------------------------------------- */

/**
 * How many commands a connection may run in a burst, and how fast the allowance refills.
 *
 * Duris dequeues **one command per 250 ms pulse** per descriptor, which is both a fairness rule and
 * the reason you cannot macro-spam a MUD. We are not building that here: a real input queue belongs
 * with the event scheduler in roadmap Phase 5, and half of one — a queue with no scheduler to drain
 * it — is worse than none. This is the other half of what the pulse buys, the flood guard, at the
 * same sustained rate.
 *
 * The bucket is generous on the burst and strict on the average, because those are two different
 * questions: a player who types three commands quickly is playing, and one who sends sixty a second
 * is not a player. The server is unauthenticated, so this is a real defence rather than a nicety.
 */
export const COMMAND_BURST = 6;
export const COMMAND_REFILL_MS = 250;

export interface CommandBudget {
  tokens: number;
  lastRefillMs: number;
}

export function newCommandBudget(nowMs: number): CommandBudget {
  return { tokens: COMMAND_BURST, lastRefillMs: nowMs };
}

/**
 * Spends one command from the budget, refilling it first. Answers whether the command may run.
 *
 * Time is passed in rather than read here so this stays pure and testable: a rate limiter tested
 * against the wall clock is a test that is slow when it passes and flaky when it fails.
 */
export function spendCommand(budget: CommandBudget, nowMs: number): boolean {
  const elapsed = Math.max(0, nowMs - budget.lastRefillMs);
  const refilled = Math.floor(elapsed / COMMAND_REFILL_MS);
  if (refilled > 0) {
    budget.tokens = Math.min(COMMAND_BURST, budget.tokens + refilled);
    // Advance by whole tokens only, so the remainder carries and a stream of sub-interval commands
    // cannot refill forever by resetting the clock each time.
    budget.lastRefillMs += refilled * COMMAND_REFILL_MS;
  }
  if (budget.tokens <= 0) return false;
  budget.tokens--;
  return true;
}
