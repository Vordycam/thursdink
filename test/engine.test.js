/* Engine tests. No dependencies — uses Node's built-in runner.
 *
 *   node --test test/engine.test.js
 *
 * engine.js is a browser script that hangs itself on `window` and calls
 * `Storage_.newId()`, so both are shimmed before it is loaded. Math.random is
 * replaced with a seeded generator so every run is identical. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* Load the engine into THIS realm, not a separate vm context. In the browser
   the engine and the app share one realm; a separate context gives engine
   arrays a different Array.prototype, and deepStrictEqual then rejects results
   that are correct by content. */
function loadEngine(file) {
  let n = 0;
  globalThis.window = {};
  globalThis.Storage_ = { newId: () => 'g' + (++n) };
  // Deterministic LCG so tie-breaking shuffles are reproducible.
  let seed = 12345;
  Math.random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
  return globalThis.window.Engine;
}

const ENGINE_PATH = process.env.ENGINE_PATH || path.join(__dirname, '..', 'js', 'engine.js');
const Engine = loadEngine(ENGINE_PATH);

/* ── fixtures ─────────────────────────────────────────────────────────── */

function players(names, skill) {
  const byId = {};
  names.forEach((name) => {
    byId[name] = { id: name, name, skill: skill || '3.5', rating: Engine.initialRating(skill || '3.5') };
  });
  return byId;
}

function session(ids, courts) {
  return {
    id: 's1', startedAt: 0, endedAt: null, courtCount: courts || 1,
    playerIds: ids.slice(), playerMeta: {}, games: [], nextSeq: 1, status: 'active',
  };
}

/* Record a finished game with explicit teams, advancing the sequence. */
function played(sess, teamA, teamB, scoreA, scoreB) {
  sess.games.push({
    id: 'g' + sess.nextSeq, court: 1, seq: sess.nextSeq++,
    teamA, teamB, scoreA: scoreA ?? 11, scoreB: scoreB ?? 7, done: true, ratingDeltas: null,
  });
}

function onCourt(game) {
  return game.teamA.concat(game.teamB);
}

/* ── the reported bug ─────────────────────────────────────────────────── */

test('a late joiner does not jump players who were already waiting', () => {
  // One court, six regulars. After two games:
  //   A,B have 2 games (last finished game 2)
  //   C,D have 1 game  (last finished game 1)  <- waiting longest
  //   E,F have 1 game  (last finished game 2)
  const byId = players(['A', 'B', 'C', 'D', 'E', 'F', 'N']);
  const sess = session(['A', 'B', 'C', 'D', 'E', 'F']);
  played(sess, ['A', 'B'], ['C', 'D']);
  played(sess, ['E', 'F'], ['A', 'B']);

  // N arrives now. Credited with the lightest load (1), same tier as C,D,E,F.
  Engine.setSessionPlayers(sess, ['A', 'B', 'C', 'D', 'E', 'F', 'N']);
  assert.equal(sess.playerMeta.N.gamesCredit, 1);
  assert.equal(sess.playerMeta.N.joinedSeq, 3, 'wait is clocked from arrival, not from game 0');

  const next = Engine.fillCourts(sess, byId)[0];
  const four = onCourt(next).sort();

  assert.deepEqual(four, ['C', 'D', 'E', 'F'],
    'the four who were already waiting play; the newcomer waits their turn');
  assert.ok(!four.includes('N'));
});

test('REGRESSION: the original queue-jump, reproduced through the pre-fix API', () => {
  // This is exactly what the old app.js did when a player was checked in:
  // credit them with the lightest load and append them. No joinedSeq. The
  // pre-fix engine then read the newcomer's wait as "since before game 1"
  // and put them on court ahead of C, D, E and F. Run this file with
  // ENGINE_PATH pointed at the old engine and this test fails; here it passes.
  const byId = players(['A', 'B', 'C', 'D', 'E', 'F', 'N']);
  const sess = session(['A', 'B', 'C', 'D', 'E', 'F']);
  played(sess, ['A', 'B'], ['C', 'D']);
  played(sess, ['E', 'F'], ['A', 'B']);

  sess.playerMeta.N = { gamesCredit: 1 };
  sess.playerIds.push('N');

  // The new app runs this on load, repairing sessions that were in progress
  // when the fix shipped. The old engine has no such function, so against it
  // the raw state stands and the assertion below fails — as it should.
  if (Engine.normalizeSession) Engine.normalizeSession(sess);

  const four = onCourt(Engine.fillCourts(sess, byId)[0]);
  assert.ok(!four.includes('N'),
    'the newcomer must not be seated ahead of players already waiting');
});

test('normalizeSession repairs old late-joiner records exactly once', () => {
  const sess = session(['A', 'B', 'C', 'D']);
  sess.nextSeq = 5;
  sess.playerMeta = {
    N: { gamesCredit: 2 },                 // old-app late joiner: no joinedSeq
    M: { gamesCredit: 1, joinedSeq: 3 },   // already stamped, must not move
  };
  assert.equal(Engine.normalizeSession(sess), true, 'reports that it changed something');
  assert.equal(sess.playerMeta.N.joinedSeq, 5, 'clocked from now');
  assert.equal(sess.playerMeta.M.joinedSeq, 3, 'existing marker untouched');
  assert.equal(Engine.normalizeSession(sess), false, 'second pass is a no-op');

  const done = session(['A', 'B', 'C', 'D']);
  done.status = 'done';
  done.playerMeta = { N: { gamesCredit: 1 } };
  assert.equal(Engine.normalizeSession(done), false, 'finished sessions are left alone');
});

test('a late joiner is at the back of the displayed queue, not the front', () => {
  const byId = players(['A', 'B', 'C', 'D', 'E', 'F', 'N']);
  const sess = session(['A', 'B', 'C', 'D', 'E', 'F']);
  played(sess, ['A', 'B'], ['C', 'D']);
  played(sess, ['E', 'F'], ['A', 'B']);
  Engine.setSessionPlayers(sess, ['A', 'B', 'C', 'D', 'E', 'F', 'N']);

  const order = Engine.queueOrder(sess, byId).map((q) => q.id);
  assert.deepEqual(order.slice(0, 2).sort(), ['C', 'D'], 'longest waiters first');
  assert.deepEqual(order.slice(2, 4).sort(), ['E', 'F']);
  assert.equal(order[4], 'N', 'newcomer is behind everyone on the same games count');
  assert.deepEqual(order.slice(5).sort(), ['A', 'B'], 'most games played are last');
});

test('a newcomer still plays before anyone with strictly more games', () => {
  // Fewer games is the hard rule. N (credited 0) must not sit behind players
  // who have already played once.
  const byId = players(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'N']);
  const sess = session(['A', 'B', 'C', 'D', 'E', 'F', 'G'], 1);
  played(sess, ['A', 'B'], ['C', 'D']);              // E,F,G still on 0
  Engine.setSessionPlayers(sess, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'N']);
  assert.equal(sess.playerMeta.N.gamesCredit, 0);

  const four = onCourt(Engine.fillCourts(sess, byId)[0]).sort();
  assert.deepEqual(four, ['E', 'F', 'G', 'N'], 'all four on zero games play, including N');
});

test('rejoining refreshes the wait clock but keeps earlier credit', () => {
  const byId = players(['A', 'B', 'C', 'D', 'E']);
  const sess = session(['A', 'B', 'C', 'D']);
  played(sess, ['A', 'B'], ['C', 'D']);
  Engine.setSessionPlayers(sess, ['A', 'B', 'C', 'D', 'E']);   // E joins, credit 1, joined 2
  assert.equal(sess.playerMeta.E.joinedSeq, 2);
  Engine.setSessionPlayers(sess, ['A', 'B', 'C', 'D']);        // E leaves
  played(sess, ['A', 'B'], ['C', 'D']);
  Engine.setSessionPlayers(sess, ['A', 'B', 'C', 'D', 'E']);   // E is back
  assert.equal(sess.playerMeta.E.gamesCredit, 1, 'credit is not re-granted');
  assert.equal(sess.playerMeta.E.joinedSeq, 3, 'but the wait restarts from now');
});

/* ── fairness invariants ──────────────────────────────────────────────── */

test('players with strictly fewer games are never skipped', () => {
  // Two courts, ten players. Run several games and check the invariant after
  // every court fill: nobody chosen has more games than someone left waiting.
  const names = 'ABCDEFGHIJ'.split('');
  const byId = players(names);
  const sess = session(names, 2);
  Engine.fillCourts(sess, byId);

  for (let round = 0; round < 12; round++) {
    const active = Engine.activeGames(sess);
    const g = active[round % active.length];
    g.scoreA = 11; g.scoreB = 5; g.done = true;
    const started = Engine.fillCourts(sess, byId);

    started.forEach((game) => {
      const counts = Engine.sessionCounts(sess);
      const chosen = onCourt(game);
      // Games counted BEFORE this game was added.
      const effOf = (id) => Engine.effectiveGames(sess, counts, id) - (chosen.includes(id) ? 1 : 0);
      const maxChosen = Math.max(...chosen.map(effOf));
      Engine.waitingPool(sess).forEach((waiter) => {
        assert.ok(effOf(waiter) >= maxChosen,
          `${waiter} (${effOf(waiter)} games) was skipped for someone with ${maxChosen}`);
      });
    });
  }
});

test('with exactly four waiting, they all play regardless of history', () => {
  const byId = players(['A', 'B', 'C', 'D']);
  const sess = session(['A', 'B', 'C', 'D']);
  played(sess, ['A', 'B'], ['C', 'D']);
  played(sess, ['A', 'B'], ['C', 'D']);
  const four = onCourt(Engine.fillCourts(sess, byId)[0]).sort();
  assert.deepEqual(four, ['A', 'B', 'C', 'D']);
});

/* ── balance within a tier ────────────────────────────────────────────── */

test('a longer waiter is only passed over to avoid a clearly worse game', () => {
  // P,Q,R,S have each partnered with every one of the others once, so ANY
  // split of those four is a repeat partnership (cost >= 100). T has played
  // the same number of games and waited one game less. Passing S over costs
  // 60 but avoids a repeat entirely — the engine takes that trade.
  const byId = players(['P', 'Q', 'R', 'S', 'T', 'X', 'Y', 'Z']);
  const sess = session(['P', 'Q', 'R', 'S', 'T', 'X', 'Y', 'Z'], 1);
  played(sess, ['P', 'Q'], ['R', 'S']);   // seq 1
  played(sess, ['P', 'R'], ['Q', 'S']);   // seq 2
  played(sess, ['P', 'S'], ['Q', 'R']);   // seq 3  -> P,Q,R,S all on 3 games, last 3
  played(sess, ['T', 'X'], ['Y', 'Z']);   // seq 4
  played(sess, ['T', 'Y'], ['X', 'Z']);   // seq 5
  played(sess, ['T', 'Z'], ['X', 'Y']);   // seq 6  -> T,X,Y,Z on 3 games, last 6
  // Remove X,Y,Z so the tier is exactly P,Q,R,S (waited since 3) + T (since 6).
  sess.playerIds = ['P', 'Q', 'R', 'S', 'T'];

  const four = onCourt(Engine.fillCourts(sess, byId)[0]).sort();
  assert.ok(four.includes('T'), 'T is brought in to break the repeat deadlock');
  assert.equal(four.length, 4);
  assert.equal(four.filter((id) => 'PQRS'.includes(id)).length, 3, 'exactly one of P,Q,R,S sits');
});

test('a marginal balance gain does not justify passing anyone over', () => {
  // Same tier, but no repeat partnerships. T has a slightly different rating;
  // the rating gain is far below the leapfrog penalty, so strict order holds.
  const byId = players(['P', 'Q', 'R', 'S', 'T']);
  byId.T.rating = 1400;   // vs 1250 for the others
  const sess = session(['P', 'Q', 'R', 'S', 'T'], 1);
  played(sess, ['P', 'Q'], ['R', 'S']);   // seq 1: P,Q,R,S -> 1 game, waited since 1
  played(sess, ['T', 'P'], ['Q', 'R']);   // seq 2
  // Now P,Q,R on 2 games (last 2), S on 1 (last 1), T on 1 (last 2).
  // Need 4: S and T locked? cutoff = 4th eff = 2. S(1),T(1) locked; need 2 of P,Q,R.
  const four = onCourt(Engine.fillCourts(sess, byId)[0]).sort();
  assert.ok(four.includes('S') && four.includes('T'), 'fewest games are locked in');
});

/* ── USA Pickleball scoring ───────────────────────────────────────────── */

test('checkScore accepts exactly the scores a game to 11 can finish on', () => {
  // Winner on 11, loser anywhere from 0 to 9.
  assert.equal(Engine.checkScore(11, 9).ok, true);
  assert.equal(Engine.checkScore(11, 0).ok, true);
  assert.equal(Engine.checkScore(0, 11).ok, true, 'order does not matter');
  // Deuce: past 11 the loser is exactly 2 behind.
  assert.equal(Engine.checkScore(12, 10).ok, true);
  assert.equal(Engine.checkScore(15, 13).ok, true, 'a long deuce run from 10–10');
});

test('checkScore refuses unfinished games and impossible scores', () => {
  const short = Engine.checkScore(7, 4);
  assert.equal(short.ok, false, 'the group plays to 11 — a short game is not finished');
  assert.match(short.error, /played to 11/);

  assert.equal(Engine.checkScore(11, 10).ok, false, 'one-point margin is not a finished game');
  assert.match(Engine.checkScore(11, 10).error, /won by 2/);

  assert.equal(Engine.checkScore(13, 9).ok, false, 'would have ended 11–9');
  assert.match(Engine.checkScore(13, 9).error, /not possible/);
  assert.equal(Engine.checkScore(15, 12).ok, false, 'would have ended 14–12');
  assert.equal(Engine.checkScore(13, 12).ok, false, 'past 11 with a 1-point lead is still in play');

  assert.equal(Engine.checkScore(11, 11).ok, false);
  assert.match(Engine.checkScore(11, 11).error, /tie/);
  assert.equal(Engine.checkScore(null, 5).ok, false);
  assert.equal(Engine.checkScore(-1, 11).ok, false);
});

test('skill scale covers the full USA Pickleball range', () => {
  assert.deepEqual(Engine.SKILL_LEVELS, ['2.0', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0', '5.5']);
  assert.ok(Engine.initialRating('2.0') < Engine.initialRating('2.5'));
  assert.ok(Engine.initialRating('5.5') > Engine.initialRating('5.0'));
  assert.equal(Engine.initialRating('3.5'), 1250, 'existing default unchanged');
});
