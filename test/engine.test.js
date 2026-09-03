/* Engine tests. No dependencies — uses Node's built-in runner.
 *
 *   node --test test/engine.test.js
 *
 * engine.js is a browser script that hangs itself on `window` and calls
 * `Storage_.newId()`, so both are shimmed before it is loaded. The engine is
 * loaded into THIS realm, not a separate vm context — a separate context gives
 * its arrays a different Array.prototype and deepStrictEqual rejects results
 * that are correct by content. Math.random and Date.now are both replaced so
 * every run is identical and the clock can be moved by hand. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/* ── controllable clock ───────────────────────────────────────────────── */

let clock = 1_000_000;
Date.now = () => clock;
const MIN = 60_000;
function advance(ms) { clock += ms; }

function loadEngine(file) {
  let n = 0;
  globalThis.window = {};
  globalThis.Storage_ = { newId: () => 'g' + (++n) };
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
    id: 's1', startedAt: clock, endedAt: null, courtCount: courts || 1,
    playerIds: ids.slice(), playerMeta: {}, games: [], nextSeq: 1, status: 'active',
  };
}

/* Record a finished game with explicit teams, finished at the current clock. */
function played(sess, teamA, teamB, scoreA, scoreB) {
  sess.games.push({
    id: 'g' + sess.nextSeq, court: 1, seq: sess.nextSeq++,
    teamA, teamB, scoreA: scoreA ?? 11, scoreB: scoreB ?? 7,
    done: true, finishedAt: clock, ratingDeltas: null,
  });
}

function onCourt(game) {
  return game.teamA.concat(game.teamB);
}

/* ── the rule: longest wait first ─────────────────────────────────────── */

test('longest wait wins even against a player with fewer games', () => {
  // A has played 3 games but has been waiting 10 minutes. B has played once
  // and sat down 30 seconds ago. Wait decides; games played does not.
  const byId = players(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  const sess = session(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], 1);
  played(sess, ['A', 'C'], ['D', 'E']);
  played(sess, ['A', 'D'], ['C', 'E']);
  played(sess, ['A', 'E'], ['C', 'D']);            // A now on 3, finished at t0
  advance(10 * MIN);
  played(sess, ['B', 'F'], ['G', 'H']);            // B on 1, finished 10 min later
  advance(30_000);
  // Waiting now: A,C,D,E (10.5 min), B,F,G,H (30 s). Only 4 can play.
  const four = onCourt(Engine.fillCourts(sess, byId)[0]).sort();
  assert.deepEqual(four, ['A', 'C', 'D', 'E'], 'the four who waited longest, regardless of game counts');
});

test('a late joiner goes to the back of the line', () => {
  const byId = players(['A', 'B', 'C', 'D', 'E', 'F', 'N']);
  const sess = session(['A', 'B', 'C', 'D', 'E', 'F']);
  played(sess, ['A', 'B'], ['C', 'D']);
  advance(8 * MIN);
  played(sess, ['E', 'F'], ['A', 'B']);
  advance(2 * MIN);

  Engine.setSessionPlayers(sess, ['A', 'B', 'C', 'D', 'E', 'F', 'N']);
  assert.equal(sess.playerMeta.N.joinedAt, clock, 'wait is clocked from arrival');

  const order = Engine.queueOrder(sess, byId).map((q) => q.id);
  assert.deepEqual(order.slice(0, 2).sort(), ['C', 'D'], 'waiting 10 min');
  assert.deepEqual(order.slice(2, 6).sort(), ['A', 'B', 'E', 'F'], 'waiting 2 min');
  assert.equal(order[6], 'N', 'just arrived — last');

  const four = onCourt(Engine.fillCourts(sess, byId)[0]);
  assert.ok(!four.includes('N'));
});

test('REGRESSION: a newcomer added the old way still cannot jump the line', () => {
  // The pre-fix app added a player with only gamesCredit — no timestamp of
  // any kind. normalizeSession repairs that on load. Against the old engine
  // (no normalizeSession) the raw state stands and this fails, as it should.
  const byId = players(['A', 'B', 'C', 'D', 'E', 'F', 'N']);
  const sess = session(['A', 'B', 'C', 'D', 'E', 'F']);
  played(sess, ['A', 'B'], ['C', 'D']);
  advance(5 * MIN);
  played(sess, ['E', 'F'], ['A', 'B']);
  advance(MIN);

  sess.playerMeta.N = { gamesCredit: 1 };
  sess.playerIds.push('N');
  if (Engine.normalizeSession) Engine.normalizeSession(sess);

  const four = onCourt(Engine.fillCourts(sess, byId)[0]);
  assert.ok(!four.includes('N'), 'the newcomer must not be seated ahead of players already waiting');
});

test('rejoining restarts the clock but keeps earlier credit', () => {
  const byId = players(['A', 'B', 'C', 'D', 'E']);
  const sess = session(['A', 'B', 'C', 'D']);
  played(sess, ['A', 'B'], ['C', 'D']);
  advance(MIN);
  Engine.setSessionPlayers(sess, ['A', 'B', 'C', 'D', 'E']);
  const firstJoin = sess.playerMeta.E.joinedAt;
  Engine.setSessionPlayers(sess, ['A', 'B', 'C', 'D']);          // E leaves
  advance(7 * MIN);
  Engine.setSessionPlayers(sess, ['A', 'B', 'C', 'D', 'E']);     // E is back
  assert.equal(sess.playerMeta.E.gamesCredit, 1, 'credit is not re-granted');
  assert.ok(sess.playerMeta.E.joinedAt > firstJoin, 'but the wait restarts from now');
  assert.equal(sess.playerMeta.E.joinedAt, clock);
});

/* ── real time across courts ──────────────────────────────────────────── */

test('game number is irrelevant — the court that finished later has waited less', () => {
  // Court 1 (game 1) is a long deuce; court 2 (game 2) finishes first.
  const byId = players(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
  const sess = session(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'], 2);
  const g1 = { id: 'x1', court: 1, seq: 1, teamA: ['A', 'B'], teamB: ['C', 'D'], scoreA: null, scoreB: null, done: false };
  const g2 = { id: 'x2', court: 2, seq: 2, teamA: ['E', 'F'], teamB: ['G', 'H'], scoreA: null, scoreB: null, done: false };
  sess.games.push(g1, g2);
  sess.nextSeq = 3;
  // I has been waiting since the start.
  advance(6 * MIN);
  Engine.completeGame(g2, 11, 4);                  // court 2 done first (seq 2)
  advance(3 * MIN);
  Engine.completeGame(g1, 15, 13);                 // court 1 done later (seq 1)
  advance(10_000);

  const order = Engine.queueOrder(sess, byId).map((q) => q.id);
  assert.equal(order[0], 'I', 'waiting since the session started');
  assert.deepEqual(order.slice(1, 5).sort(), ['E', 'F', 'G', 'H'], 'court 2 sat down 3 minutes earlier');
  assert.deepEqual(order.slice(5).sort(), ['A', 'B', 'C', 'D'], 'court 1 finished last despite the lower game number');
});

test('players who have waited beyond the tie window are never skipped', () => {
  // Two courts, ten players, random-length games. After every court fill,
  // nobody left waiting may have been waiting more than a minute longer
  // than someone who was chosen.
  const names = 'ABCDEFGHIJ'.split('');
  const byId = players(names);
  const sess = session(names, 2);
  Engine.fillCourts(sess, byId);

  for (let round = 0; round < 16; round++) {
    const active = Engine.activeGames(sess);
    const g = active[round % active.length];
    advance(2 * MIN + Math.floor(Math.random() * 6 * MIN));
    Engine.completeGame(g, 11, 6);
    const started = Engine.fillCourts(sess, byId);

    started.forEach((game) => {
      const chosen = onCourt(game);
      const latestChosen = Math.max(...chosen.map((id) => Engine.waitSince(sess, id)));
      Engine.waitingPool(sess).forEach((waiter) => {
        const since = Engine.waitSince(sess, waiter);
        assert.ok(since >= latestChosen - Engine.TIE_WINDOW_MS,
          `${waiter} waited since ${since} but ${latestChosen} was chosen (window ${Engine.TIE_WINDOW_MS})`);
      });
    });
  }
});

test('courts finishing five minutes apart do not mix — the earlier court is locked in', () => {
  const byId = players(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
  const sess = session(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'], 1);
  played(sess, ['A', 'B'], ['C', 'D']);            // A,B,C,D free at t0
  advance(5 * MIN);
  played(sess, ['E', 'F'], ['G', 'H']);            // E,F,G,H free at t0+5m
  // I waited since start. Next court: I plus the three... no — I plus A,B,C,D
  // are five people with the longest waits; four must be chosen from
  // I (start) and A,B,C,D (t0). E–H are outside the window and excluded.
  const four = onCourt(Engine.fillCourts(sess, byId)[0]).sort();
  assert.ok(four.includes('I'));
  four.forEach((id) => assert.ok('IABCD'.includes(id), `${id} should not be chosen over an earlier court`));
});

/* ── within the tie window: fewer games, then variety ─────────────────── */

test('within the tie window, fewer games played goes first', () => {
  const byId = players(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  const sess = session(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], 1);
  played(sess, ['A', 'B'], ['C', 'D']);
  played(sess, ['A', 'B'], ['C', 'D']);            // A–D on 2 games
  advance(20_000);
  played(sess, ['E', 'F'], ['G', 'H']);            // E–H on 1 game, 20 s later
  // All eight are inside one 60 s window. Fewer games wins the tiebreak.
  const four = onCourt(Engine.fillCourts(sess, byId)[0]).sort();
  assert.deepEqual(four, ['E', 'F', 'G', 'H']);
});

test('within the tie window, variety can break a repeat-partner deadlock', () => {
  // P,Q,R,S have each partnered every other one. T sat down 20 s after them
  // with the same game count. Any split of P,Q,R,S repeats a partnership
  // (cost >= 100); passing one of them over for T costs 60 and avoids it.
  const byId = players(['P', 'Q', 'R', 'S', 'T', 'X', 'Y', 'Z']);
  const sess = session(['P', 'Q', 'R', 'S', 'T', 'X', 'Y', 'Z'], 1);
  played(sess, ['P', 'Q'], ['R', 'S']);
  played(sess, ['P', 'R'], ['Q', 'S']);
  played(sess, ['P', 'S'], ['Q', 'R']);            // P,Q,R,S: 3 games each, free now
  advance(20_000);
  played(sess, ['T', 'X'], ['Y', 'Z']);
  played(sess, ['T', 'Y'], ['X', 'Z']);
  played(sess, ['T', 'Z'], ['X', 'Y']);            // T,X,Y,Z: 3 games, free 20 s later
  sess.playerIds = ['P', 'Q', 'R', 'S', 'T'];      // X,Y,Z have gone home

  const four = onCourt(Engine.fillCourts(sess, byId)[0]).sort();
  assert.ok(four.includes('T'), 'T is brought in to break the deadlock');
  assert.equal(four.filter((id) => 'PQRS'.includes(id)).length, 3);
});

/* ── timestamps ───────────────────────────────────────────────────────── */

test('completeGame stamps the finish time and the score', () => {
  const g = { teamA: ['A', 'B'], teamB: ['C', 'D'], scoreA: null, scoreB: null, done: false, finishedAt: null };
  advance(MIN);
  Engine.completeGame(g, 11, 8);
  assert.equal(g.done, true);
  assert.equal(g.scoreA, 11);
  assert.equal(g.scoreB, 8);
  assert.equal(g.finishedAt, clock);
});

test('waitSince falls back to the session start for anyone who has not played or joined late', () => {
  const sess = session(['A', 'B', 'C', 'D']);
  assert.equal(Engine.waitSince(sess, 'A'), sess.startedAt);
});

test('normalizeSession gives legacy games and joiners timestamps that preserve their order', () => {
  const sess = session(['A', 'B', 'C', 'D', 'E', 'F']);
  sess.startedAt = 500_000;
  // Pre-timestamp games: seq only.
  sess.games.push({ id: 'l1', seq: 1, teamA: ['A', 'B'], teamB: ['C', 'D'], scoreA: 11, scoreB: 5, done: true });
  sess.games.push({ id: 'l2', seq: 2, teamA: ['E', 'F'], teamB: ['A', 'B'], scoreA: 11, scoreB: 9, done: true });
  sess.games.push({ id: 'l3', seq: 3, teamA: ['C', 'D'], teamB: ['E', 'F'], scoreA: null, scoreB: null, done: false });
  sess.nextSeq = 4;
  // A v7-era late joiner (joinedSeq, no joinedAt) and a v6-era one (neither).
  sess.playerMeta = { N: { gamesCredit: 1, joinedSeq: 3 }, M: { gamesCredit: 1 } };

  assert.equal(Engine.normalizeSession(sess), true);
  assert.equal(sess.games[0].finishedAt, 500_001);
  assert.equal(sess.games[1].finishedAt, 500_002);
  assert.equal(sess.games[2].finishedAt, undefined, 'an unfinished game is not stamped');
  assert.equal(sess.playerMeta.N.joinedAt, 500_003);
  assert.equal(sess.playerMeta.M.joinedAt, 500_004, 'no joinedSeq: treated as joining now (nextSeq)');
  assert.equal(Engine.normalizeSession(sess), false, 'second pass is a no-op');

  // Ordering is preserved: C,D (game 1) waited longer than A,B (game 2), and
  // both waited longer than anything finished from now on.
  assert.ok(Engine.waitSince(sess, 'C') < Engine.waitSince(sess, 'A'));
  advance(MIN);
  const fresh = { teamA: ['X', 'Y'], teamB: ['Z', 'W'], done: false };
  Engine.completeGame(fresh, 11, 2);
  assert.ok(fresh.finishedAt > Engine.waitSince(sess, 'A'), 'legacy waiters rank ahead of anyone finishing post-update');

  const done = session(['A', 'B', 'C', 'D']);
  done.status = 'done';
  done.games.push({ seq: 1, teamA: ['A', 'B'], teamB: ['C', 'D'], done: true });
  assert.equal(Engine.normalizeSession(done), false, 'finished sessions are left alone');
});

/* ── display helpers ──────────────────────────────────────────────────── */

test('queueOrder is stable between renders', () => {
  const byId = players(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
  const sess = session(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
  const first = Engine.queueOrder(sess, byId).map((q) => q.id);
  const second = Engine.queueOrder(sess, byId).map((q) => q.id);
  assert.deepEqual(first, second, 'the displayed order does not shuffle between renders');
});

test('waitBands: longest-waiting group red, newest green, between yellow', () => {
  const t = clock;
  const q = (since) => ({ since });

  // Everyone waited the same: all up next, all red.
  assert.deepEqual(Engine.waitBands([q(t), q(t), q(t)]), ['red', 'red', 'red']);

  // Two groups: the one who waited, and the one who just arrived.
  assert.deepEqual(Engine.waitBands([q(t), q(t + 3 * MIN)]), ['red', 'green']);

  // Three groups — a whole court that finished together shares a band.
  assert.deepEqual(
    Engine.waitBands([q(t), q(t + 5 * MIN), q(t + 5 * MIN), q(t + 5 * MIN), q(t + 5 * MIN), q(t + 9 * MIN)]),
    ['red', 'yellow', 'yellow', 'yellow', 'yellow', 'green']);

  // Two courts finishing 20 s apart are one group, not two.
  assert.deepEqual(Engine.waitBands([q(t), q(t + 20_000), q(t + 4 * MIN)]), ['red', 'red', 'green']);

  // Four groups: only the ends are red and green.
  assert.deepEqual(
    Engine.waitBands([q(t), q(t + 2 * MIN), q(t + 4 * MIN), q(t + 6 * MIN)]),
    ['red', 'yellow', 'yellow', 'green']);

  assert.deepEqual(Engine.waitBands([]), []);
});

/* ── players who leave early ──────────────────────────────────────────── */

test('a player who left early is still in the session results', () => {
  const byId = players(['A', 'B', 'C', 'D', 'E']);
  const sess = session(['A', 'B', 'C', 'D', 'E']);
  played(sess, ['A', 'B'], ['C', 'D'], 11, 3);
  played(sess, ['A', 'E'], ['B', 'C'], 11, 9);
  Engine.setSessionPlayers(sess, ['A', 'B', 'C', 'E']);   // D goes home

  assert.ok(!sess.playerIds.includes('D'), 'D is no longer eligible for new games');
  const stats = Engine.computeStats([sess]);
  assert.ok(stats.D, 'but D played, so D has results');
  assert.equal(stats.D.games, 1);
  assert.equal(stats.D.losses, 1);
  assert.equal(stats.D.pf, 3);

  const who = Engine.sessionParticipants(sess).sort();
  assert.deepEqual(who, ['A', 'B', 'C', 'D', 'E'], 'the session counts everyone who was part of it');
});

/* ── USA Pickleball scoring ───────────────────────────────────────────── */

test('checkScore accepts exactly the scores a game to 11 can finish on', () => {
  assert.equal(Engine.checkScore(11, 9).ok, true);
  assert.equal(Engine.checkScore(11, 0).ok, true);
  assert.equal(Engine.checkScore(0, 11).ok, true, 'order does not matter');
  assert.equal(Engine.checkScore(12, 10).ok, true);
  assert.equal(Engine.checkScore(15, 13).ok, true, 'a long deuce run from 10–10');
});

test('checkScore refuses unfinished games and impossible scores', () => {
  const short = Engine.checkScore(7, 4);
  assert.equal(short.ok, false, 'the group plays to 11 — a short game is not finished');
  assert.match(short.error, /played to 11/);
  assert.equal(Engine.checkScore(11, 10).ok, false);
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
