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

/* ── standings ────────────────────────────────────────────────────────── */

function statsOf(table) {
  // { Name: [games, wins, losses, pf, pa] } -> Engine.computeStats shape
  const out = {};
  Object.keys(table).forEach((id) => {
    const [games, wins, losses, pf, pa] = table[id];
    out[id] = { games, wins, losses, pf, pa };
  });
  return out;
}

test('standings: most wins takes the board, not the best percentage', () => {
  // The reported problem: a 1-0 night sat above 7-1. And a 4-0 must not
  // outrank 7-1 either - wins decide, percentage only breaks ties.
  const byId = players(['Ace', 'Bea', 'Cal', 'Dee']);
  const stats = statsOf({
    Ace: [8, 7, 1, 88, 60],
    Bea: [4, 4, 0, 44, 20],
    Cal: [8, 4, 4, 80, 78],
    Dee: [1, 1, 0, 11, 3],
  });
  const b = Engine.rankStandings(stats, byId);
  assert.equal(b.maxGames, 8);
  assert.equal(b.minGames, 4, 'half of the busiest player');
  assert.deepEqual(b.ranked.map((r) => r.id), ['Ace', 'Bea', 'Cal'], '7 wins, then 4 wins at 100%, then 4 wins at 50%');
  assert.deepEqual(b.ranked.map((r) => r.rank), [1, 2, 3]);
  assert.deepEqual(b.mentions.map((r) => r.id), ['Dee'], 'one game is under the threshold');
});

test('standings: ties on wins fall to win rate, point difference, then name', () => {
  const byId = players(['Zed', 'Amy', 'Bob']);
  const stats = statsOf({
    Zed: [6, 4, 2, 66, 50],   // 4 wins, 67%, +16
    Amy: [8, 4, 4, 88, 70],   // 4 wins, 50%, +18
    Bob: [6, 4, 2, 66, 50],   // identical to Zed
  });
  const b = Engine.rankStandings(stats, byId);
  assert.deepEqual(b.ranked.map((r) => r.id), ['Bob', 'Zed', 'Amy'],
    'Bob and Zed tie on everything and fall to name; Amy has the lower rate');
});

test('standings: everyone ranks while the session is young', () => {
  const byId = players(['A', 'B', 'C', 'D']);
  const stats = statsOf({ A: [1, 1, 0, 11, 4], B: [1, 1, 0, 11, 4], C: [1, 0, 1, 4, 11], D: [1, 0, 1, 4, 11] });
  const b = Engine.rankStandings(stats, byId);
  assert.equal(b.minGames, 1);
  assert.equal(b.ranked.length, 4);
  assert.equal(b.mentions.length, 0);
});

test('standings: undefeated but under the threshold is a special mention, not the champion', () => {
  const byId = players(['Vet', 'New']);
  const stats = statsOf({ Vet: [8, 7, 1, 88, 60], New: [3, 3, 0, 33, 15] });
  const b = Engine.rankStandings(stats, byId);
  assert.deepEqual(b.ranked.map((r) => r.id), ['Vet']);
  assert.deepEqual(b.mentions.map((r) => r.id), ['New']);
  assert.match(b.mentions[0].note, /Unbeaten, 3-0 in 3 games/);
});

test('standings: every row carries a note, podium notes are fixed, and all notes are PDF-safe', () => {
  const byId = players(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  const stats = statsOf({
    A: [8, 7, 1, 88, 60], B: [8, 6, 2, 80, 62], C: [8, 5, 3, 75, 70],
    D: [8, 4, 4, 70, 70], E: [8, 2, 6, 55, 80], F: [8, 0, 8, 30, 88], G: [2, 1, 1, 15, 15],
  });
  const b = Engine.rankStandings(stats, byId);
  assert.match(b.ranked[0].note, /^Top of the board/);
  assert.match(b.ranked[1].note, /^Runner-up/);
  assert.match(b.ranked[2].note, /^Podium/);
  b.ranked.concat(b.mentions).forEach((r) => {
    assert.ok(r.note.length > 10, `${r.id} has a note`);
    assert.ok([...r.note].every((ch) => ch.charCodeAt(0) < 128), `${r.id} note is ASCII: ${r.note}`);
  });
  // Bottom of the board still gets an encouraging line, not silence.
  assert.match(b.ranked[b.ranked.length - 1].note, /See you Thursday/);
});

test('standings: same input, same output - screen and PDF cannot disagree', () => {
  const byId = players(['A', 'B', 'C']);
  const stats = statsOf({ A: [5, 3, 2, 50, 45], B: [5, 3, 2, 50, 45], C: [5, 2, 3, 45, 50] });
  const one = JSON.stringify(Engine.rankStandings(stats, byId));
  const two = JSON.stringify(Engine.rankStandings(stats, byId));
  assert.equal(one, two);
});

test('standings: unknown players and zero-game entries are left out', () => {
  const byId = players(['A']);
  const stats = statsOf({ A: [3, 2, 1, 30, 25], Ghost: [4, 4, 0, 44, 10], Z: [0, 0, 0, 0, 0] });
  const b = Engine.rankStandings(stats, byId);
  assert.deepEqual(b.ranked.map((r) => r.id), ['A']);
  assert.equal(b.mentions.length, 0);
});

/* ── USA Pickleball scoring ───────────────────────────────────────────── */

test('checkScore accepts exactly the scores first-to-11 can finish on', () => {
  assert.equal(Engine.checkScore(11, 10).ok, true, '11-10 ends the game - no win-by-2');
  assert.equal(Engine.checkScore(11, 9).ok, true);
  assert.equal(Engine.checkScore(11, 0).ok, true);
  assert.equal(Engine.checkScore(0, 11).ok, true, 'order does not matter');
  assert.equal(Engine.checkScore(10, 11).ok, true);
});

test('checkScore refuses unfinished games and scores past 11', () => {
  const short = Engine.checkScore(7, 4);
  assert.equal(short.ok, false, 'a short game is not finished');
  assert.match(short.error, /played to 11/);
  assert.equal(Engine.checkScore(10, 9).ok, false, 'nobody reached 11 yet');

  assert.equal(Engine.checkScore(12, 10).ok, false, 'the game ended at 11-10');
  assert.match(Engine.checkScore(12, 10).error, /ends at 11/);
  assert.equal(Engine.checkScore(15, 13).ok, false, 'no deuce in this format');
  assert.equal(Engine.checkScore(13, 9).ok, false, 'would have ended 11-9');
  assert.match(Engine.checkScore(13, 9).error, /not possible/);

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

/* ── fixed partners ───────────────────────────────────────────────────── */

function sameTeam(game, a, b) {
  return (game.teamA.includes(a) && game.teamA.includes(b)) ||
    (game.teamB.includes(a) && game.teamB.includes(b));
}

test('fixed partners are always on the same team and are never split', () => {
  // Ten players, two courts, random-length games. A and B are a pair for
  // the night: whenever either is on a court, the other is beside them.
  const names = 'ABCDEFGHIJ'.split('');
  const byId = players(names);
  const sess = session(names, 2);
  sess.pairs = [['A', 'B']];
  Engine.fillCourts(sess, byId);

  let pairGames = 0;
  for (let round = 0; round < 24; round++) {
    const active = Engine.activeGames(sess);
    const g = active[round % active.length];
    advance(2 * MIN + Math.floor(Math.random() * 6 * MIN));
    Engine.completeGame(g, 11, 6);
    Engine.fillCourts(sess, byId);
    Engine.activeGames(sess).forEach((game) => {
      const four = onCourt(game);
      if (four.includes('A') || four.includes('B')) {
        assert.ok(sameTeam(game, 'A', 'B'), `A and B split on court ${game.court}: ${game.teamA} v ${game.teamB}`);
      }
    });
  }
  sess.games.forEach((g) => { if (g.done && sameTeam(g, 'A', 'B')) pairGames++; });
  assert.ok(pairGames >= 3, `the pair still gets a fair share of games (${pairGames})`);
});

test('a partner whose other half is on court is held; once both are free they wait as one unit', () => {
  const byId = players(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  const sess = session(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], 2);
  sess.pairs = [['A', 'B']];
  const g = { id: 'x1', court: 1, seq: 1, teamA: ['B', 'C'], teamB: ['D', 'E'], scoreA: null, scoreB: null, done: false, finishedAt: null };
  sess.games.push(g);
  sess.nextSeq = 2;

  // Waiting: A (partner on court), F, G, H. Court 2 is free, but only three
  // people are actually available - A sits until B is done.
  assert.equal(Engine.fillCourts(sess, byId).length, 0, 'A cannot go on without B');
  const held = Engine.queueUnits(sess, byId).find((u) => u.ids.includes('A'));
  assert.deepEqual(held.ids, ['A']);
  assert.equal(held.waitingFor, 'B');
  assert.equal(Engine.queueOrder(sess, byId).find((q) => q.id === 'A').waitingFor, 'B');

  advance(10 * MIN);
  Engine.completeGame(g, 11, 5);
  const unit = Engine.queueUnits(sess, byId).find((u) => u.ids.includes('A'));
  assert.deepEqual(unit.ids.slice().sort(), ['A', 'B'], 'one unit of two');
  assert.equal(unit.since, g.finishedAt, 'the pair has waited only since B sat down, not since A did');
  assert.equal(unit.waitingFor, null);
  const flat = Engine.queueOrder(sess, byId);
  assert.equal(flat.find((q) => q.id === 'A').pairWith, 'B');
  assert.equal(flat.find((q) => q.id === 'B').pairWith, 'A');

  // Both courts fill. F, G, H waited ten minutes longer and are locked in;
  // they take one single. The pair goes on the other court, together.
  const started = Engine.fillCourts(sess, byId);
  assert.equal(started.length, 2);
  const withPair = started.find((game) => onCourt(game).includes('A'));
  assert.ok(withPair, 'the pair got a court');
  assert.ok(sameTeam(withPair, 'A', 'B'));
  const other = started.find((game) => game !== withPair);
  assert.deepEqual(onCourt(other).filter((id) => 'FGH'.includes(id)).sort(), ['F', 'G', 'H']);
});

test('a fixed pair is not penalised for playing together again', () => {
  // Singles A-D have each partnered every other one; the pair P and Q have
  // played three games together (against X and Y, since gone home). All six
  // are free at the same moment with three games each. P&Q against two
  // singles repeats one partnership (100). Four singles repeats two (200)
  // and every opponent pairing twice (160). If the pair's own repeat counted
  // it would add 300 to their court and the engine would leave them sitting.
  const byId = players(['A', 'B', 'C', 'D', 'P', 'Q', 'X', 'Y']);
  const sess = session(['A', 'B', 'C', 'D', 'P', 'Q'], 1);
  sess.pairs = [['P', 'Q']];
  played(sess, ['A', 'B'], ['C', 'D']);
  played(sess, ['A', 'C'], ['B', 'D']);
  played(sess, ['A', 'D'], ['B', 'C']);
  played(sess, ['P', 'Q'], ['X', 'Y']);
  played(sess, ['P', 'Q'], ['X', 'Y']);
  played(sess, ['P', 'Q'], ['X', 'Y']);

  const game = Engine.fillCourts(sess, byId)[0];
  const four = onCourt(game);
  assert.ok(four.includes('P') && four.includes('Q'), `the pair plays: ${four}`);
  assert.ok(sameTeam(game, 'P', 'Q'));
});

test('three locked singles and only a pair waiting: the court still fills, and the weakest claim gives way', () => {
  const byId = players(['A', 'B', 'C', 'D', 'P', 'Q', 'X', 'Y']);
  const sess = session(['A', 'B', 'C', 'P', 'Q'], 1);
  sess.pairs = [['P', 'Q']];
  played(sess, ['C', 'D'], ['X', 'Y']);            // C has an extra game
  played(sess, ['A', 'B'], ['C', 'D']);            // A, B, C free at t0
  advance(5 * MIN);
  played(sess, ['P', 'Q'], ['X', 'Y']);            // the pair free five minutes later
  // A, B, C are locked in but only one seat is left and the pair needs two.
  // Nobody fits, so the locked single with the most games (C) gives way.
  const started = Engine.fillCourts(sess, byId);
  assert.equal(started.length, 1, 'the court is not left empty');
  const four = onCourt(started[0]).sort();
  assert.deepEqual(four, ['A', 'B', 'P', 'Q']);
  assert.ok(sameTeam(started[0], 'P', 'Q'));
  assert.deepEqual(Engine.waitingPool(sess), ['C'], 'C is still first in line for the next court');
});

test('a late-joining partner puts the whole pair at the back of the line', () => {
  const byId = players(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  const sess = session(['A', 'C', 'D', 'E', 'F']);   // A waiting since the start
  played(sess, ['C', 'D'], ['E', 'F']);
  advance(8 * MIN);
  Engine.setSessionPlayers(sess, ['A', 'C', 'D', 'E', 'F', 'B', 'G']);   // B and G arrive
  assert.equal(Engine.setPair(sess, 'A', 'B').ok, true);

  const units = Engine.queueUnits(sess, byId);
  const pair = units.find((u) => u.ids.length === 2);
  assert.deepEqual(pair.ids.slice().sort(), ['A', 'B']);
  assert.equal(pair.since, clock, 'the pair has waited only since B arrived');
  assert.ok(units.indexOf(pair) >= 4, 'behind the four who finished a game eight minutes ago');
  const four = onCourt(Engine.fillCourts(sess, byId)[0]).sort();
  assert.deepEqual(four, ['C', 'D', 'E', 'F'], 'A alone would have been first in line; as a pair they wait');
});

test('setPair, clearPair and check-out keep at most one pair per player', () => {
  const sess = session(['A', 'B', 'C', 'D', 'E']);
  assert.equal(Engine.setPair(sess, 'A', 'B').ok, true);
  assert.equal(Engine.setPair(sess, 'A', 'A').ok, false, 'a player cannot partner themselves');
  assert.equal(Engine.setPair(sess, 'A', 'Z').ok, false, 'both must be in the session');
  assert.deepEqual(Engine.fixedPairs(sess), { A: 'B', B: 'A' });

  Engine.setPair(sess, 'B', 'C');                  // B moves on: the A-B pair is replaced
  assert.deepEqual(sess.pairs, [['B', 'C']]);
  assert.equal(Engine.fixedPairs(sess).A, undefined);

  Engine.setSessionPlayers(sess, ['A', 'B', 'D', 'E']);   // C leaves
  assert.deepEqual(sess.pairs, [], 'the pair goes with them');

  Engine.setPair(sess, 'D', 'E');
  assert.equal(Engine.clearPair(sess, 'E'), true);
  assert.equal(Engine.clearPair(sess, 'E'), false);
  assert.deepEqual(sess.pairs, []);

  const legacy = session(['A', 'B', 'C', 'D']);   // sessions saved before pairs existed
  delete legacy.pairs;
  assert.deepEqual(Engine.fixedPairs(legacy), {});
  assert.equal(Engine.setPair(legacy, 'A', 'B').ok, true);
  assert.deepEqual(legacy.pairs, [['A', 'B']]);
});

test('waitBands treat a pair as one entry', () => {
  const t = clock;
  const bands = Engine.waitBands([{ ids: ['A', 'B'], since: t }, { ids: ['C'], since: t + 5 * MIN }]);
  assert.deepEqual(bands, ['red', 'green']);
});
