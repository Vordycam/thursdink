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
  assert.deepEqual(Engine.SKILL_LEVELS.slice(2), ['2.0', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0', '5.5'], 'the original rungs, in order');
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

/* ── skill categories ─────────────────────────────────────────────────── */

test('skill categories: Beginner 1.0-2.5, Novice 3.0-3.5, Intermediate 4.0-4.5, Expert 5.0-5.5', () => {
  assert.deepEqual(Engine.SKILL_LEVELS, ['1.0', '1.5', '2.0', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0', '5.5']);
  assert.deepEqual(Engine.SKILL_CATEGORIES.map((c) => c.name), ['Beginner', 'Novice', 'Intermediate', 'Expert']);
  const byLevel = {};
  Engine.SKILL_LEVELS.forEach((s) => { byLevel[s] = Engine.skillCategory(s); });
  assert.deepEqual(byLevel, {
    '1.0': 'Beginner', '1.5': 'Beginner', '2.0': 'Beginner', '2.5': 'Beginner',
    '3.0': 'Novice', '3.5': 'Novice',
    '4.0': 'Intermediate', '4.5': 'Intermediate',
    '5.0': 'Expert', '5.5': 'Expert',
  });
  assert.equal(Engine.skillCategory('6.0'), '', 'off the scale');
  assert.equal(Engine.skillCategory(undefined), '', 'a player saved without a level');
  // The ladder keeps climbing below 2.0 and the existing rungs are untouched.
  assert.ok(Engine.initialRating('1.0') < Engine.initialRating('1.5'));
  assert.ok(Engine.initialRating('1.5') < Engine.initialRating('2.0'));
  assert.equal(Engine.initialRating('2.0'), 900);
  assert.equal(Engine.initialRating('3.5'), 1250);
  assert.equal(Engine.initialRating('5.5'), 1850);
});

/* ── match by skill ───────────────────────────────────────────────────── */

/* Players with explicit levels: { A: '3.0', B: '4.5', ... } */
function levelled(table) {
  const byId = {};
  Object.keys(table).forEach((name) => {
    byId[name] = { id: name, name, skill: table[name], rating: Engine.initialRating(table[name]) };
  });
  return byId;
}

function levelsOf(game, byId) {
  return onCourt(game).map((id) => byId[id].skill).sort();
}

test('match by skill is off unless the session turns it on', () => {
  const sess = session(['A', 'B', 'C', 'D']);
  assert.equal(Engine.matchBySkill(sess), false, 'sessions saved before this option have no flag');
  sess.matchBySkill = true;
  assert.equal(Engine.matchBySkill(sess), true);
});

test('match by skill: courts are made of players at the same level', () => {
  // Four 3.0s and four 4.5s, two courts, everyone tied at the start. Each
  // court comes out at a single level.
  const byId = levelled({ A: '3.0', B: '3.0', C: '3.0', D: '3.0', E: '4.5', F: '4.5', G: '4.5', H: '4.5' });
  const sess = session(Object.keys(byId), 2);
  sess.matchBySkill = true;
  const started = Engine.fillCourts(sess, byId);
  assert.equal(started.length, 2);
  const courts = started.map((g) => levelsOf(g, byId).join(' ')).sort();
  assert.deepEqual(courts, ['3.0 3.0 3.0 3.0', '4.5 4.5 4.5 4.5']);
});

test('match by skill: the longest wait always plays, with the closest-rated players around them', () => {
  // A, a 5.0, has waited ten minutes. Everyone else just sat down: four
  // 3.0s and one 4.5. A is far from everyone but goes on regardless, and
  // the 4.5 is seated with A because that makes the more even game.
  const byId = levelled({ A: '5.0', B: '3.0', C: '3.0', D: '3.0', E: '3.0', F: '4.5', X: '3.5', Y: '3.5', Z: '3.5' });
  const sess = session(['A', 'B', 'C', 'D', 'E', 'F'], 1);
  sess.matchBySkill = true;
  played(sess, ['A', 'X'], ['Y', 'Z']);                  // A free at t0
  advance(10 * MIN);
  played(sess, ['B', 'C'], ['D', 'E']);
  played(sess, ['F', 'X'], ['Y', 'Z']);                  // the rest free now
  const game = Engine.fillCourts(sess, byId)[0];
  const four = onCourt(game);
  assert.ok(four.includes('A'), 'the longest wait is never skipped');
  assert.ok(four.includes('F'), 'the 4.5 is brought on with the 5.0');
});

test('match by skill: a long wait is not skipped for half a level', () => {
  // A (3.5) has waited longest and is up. B (4.0) sat down two minutes
  // after A; C, D, E (3.5) eight minutes after that. Leaving B out would
  // make a perfectly level court, but B has waited eight minutes longer than
  // the 3.5s and half a level is not reason enough to pass B over.
  const byId = levelled({ A: '3.5', B: '4.0', C: '3.5', D: '3.5', E: '3.5', X: '3.5', Y: '3.5', Z: '3.5' });
  const sess = session(['A', 'B', 'C', 'D', 'E'], 1);
  sess.matchBySkill = true;
  played(sess, ['A', 'X'], ['Y', 'Z']);
  advance(2 * MIN);
  played(sess, ['B', 'X'], ['Y', 'Z']);
  advance(8 * MIN);
  played(sess, ['C', 'D'], ['E', 'X']);
  const four = onCourt(Engine.fillCourts(sess, byId)[0]);
  assert.ok(four.includes('A') && four.includes('B'), `A and B both play: ${four}`);
});

test('match by skill: a level and a half can pass a long wait over once; then they go first', () => {
  // Same shape, but B is a 4.5 among 3.0s. B is left out this time for an
  // even court - and is then first for the next one, which is built around B.
  const byId = levelled({ A: '3.0', B: '4.5', C: '3.0', D: '3.0', E: '3.0', X: '3.0', Y: '3.0', Z: '3.0' });
  const sess = session(['A', 'B', 'C', 'D', 'E'], 1);
  sess.matchBySkill = true;
  played(sess, ['A', 'X'], ['Y', 'Z']);
  advance(2 * MIN);
  played(sess, ['B', 'X'], ['Y', 'Z']);
  advance(8 * MIN);
  played(sess, ['C', 'D'], ['E', 'X']);
  const first = Engine.fillCourts(sess, byId)[0];
  assert.deepEqual(onCourt(first).sort(), ['A', 'C', 'D', 'E'], 'B sits this one out');
  assert.deepEqual(Engine.waitingPool(sess), ['B']);

  advance(12 * MIN);
  Engine.completeGame(first, 11, 4);
  const second = Engine.fillCourts(sess, byId)[0];
  assert.ok(onCourt(second).includes('B'), 'B has waited longest and cannot be skipped again');
});

test('the same scenario with match by skill off: the old lock stands and B plays', () => {
  const byId = levelled({ A: '3.0', B: '4.5', C: '3.0', D: '3.0', E: '3.0', X: '3.0', Y: '3.0', Z: '3.0' });
  const sess = session(['A', 'B', 'C', 'D', 'E'], 1);
  played(sess, ['A', 'X'], ['Y', 'Z']);
  advance(2 * MIN);
  played(sess, ['B', 'X'], ['Y', 'Z']);
  advance(8 * MIN);
  played(sess, ['C', 'D'], ['E', 'X']);
  const four = onCourt(Engine.fillCourts(sess, byId)[0]);
  assert.ok(four.includes('A') && four.includes('B'), 'both locked in, as before');
});

test('match by skill: a fixed pair stays together and counts as two ratings on the court', () => {
  // P & Q (3.0s) are a pair and have waited longest. R, S (3.0) and T, U
  // (4.5) just sat down. The court is the pair plus the two 3.0s.
  const byId = levelled({ P: '3.0', Q: '3.0', R: '3.0', S: '3.0', T: '4.5', U: '4.5', X: '3.0', Y: '3.0' });
  const sess = session(['P', 'Q', 'R', 'S', 'T', 'U'], 1);
  sess.matchBySkill = true;
  sess.pairs = [['P', 'Q']];
  played(sess, ['P', 'Q'], ['X', 'Y']);
  advance(10 * MIN);
  played(sess, ['R', 'T'], ['S', 'U']);
  const game = Engine.fillCourts(sess, byId)[0];
  assert.deepEqual(onCourt(game).sort(), ['P', 'Q', 'R', 'S']);
  assert.ok(sameTeam(game, 'P', 'Q'));
});

test('match by skill: a lone single with only pairs behind them gives way, and stays first', () => {
  const byId = levelled({ S: '3.5', A: '3.5', B: '3.5', C: '3.5', D: '3.5', X: '3.5', Y: '3.5', Z: '3.5' });
  const sess = session(['S', 'A', 'B', 'C', 'D'], 1);
  sess.matchBySkill = true;
  sess.pairs = [['A', 'B'], ['C', 'D']];
  played(sess, ['S', 'X'], ['Y', 'Z']);
  advance(10 * MIN);
  played(sess, ['A', 'B'], ['C', 'D']);
  const game = Engine.fillCourts(sess, byId)[0];
  assert.deepEqual(onCourt(game).sort(), ['A', 'B', 'C', 'D'], 'the court is not left empty');
  assert.deepEqual(Engine.waitingPool(sess), ['S']);
});

test('match by skill: nobody waits beyond the line length - the longest wait is seated every time', () => {
  // Twelve players across all four categories, two courts, random game
  // lengths. Every court that starts must include whoever had waited
  // longest at that moment (within the tie window).
  const table = {};
  'ABCDEFGHIJKL'.split('').forEach((n, i) => { table[n] = ['1.5', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0', '5.5', '3.0', '3.5', '4.0', '4.5'][i]; });
  const byId = levelled(table);
  const sess = session(Object.keys(table), 2);
  sess.matchBySkill = true;
  Engine.fillCourts(sess, byId);
  for (let round = 0; round < 30; round++) {
    const active = Engine.activeGames(sess);
    const g = active[round % active.length];
    advance(2 * MIN + Math.floor(Math.random() * 6 * MIN));
    Engine.completeGame(g, 11, 6);
    const pool = Engine.waitingPool(sess);
    const longest = Math.min(...pool.map((id) => Engine.waitSince(sess, id)));
    const started = Engine.fillCourts(sess, byId);
    assert.equal(started.length, 1);
    const chosen = onCourt(started[0]).map((id) => Engine.waitSince(sess, id));
    assert.ok(Math.min(...chosen) <= longest + Engine.TIE_WINDOW_MS, `round ${round}: the longest wait was skipped`);
  }
});

/* ── start over ───────────────────────────────────────────────────────── */

test('resetProgress deletes every session and returns each player to their starting rating', () => {
  const data = {
    version: 1,
    players: [
      { id: 'A', name: 'Ann', skill: '3.5', rating: 1312, ratingHistory: [{ t: 1, r: 1280 }, { t: 2, r: 1312 }], archived: false },
      { id: 'B', name: 'Ben', skill: '4.5', rating: 1490, ratingHistory: [{ t: 1, r: 1490 }], archived: true },
      { id: 'C', name: 'Cal', skill: '2.0', rating: 940 },            // saved before ratingHistory existed
    ],
    sessions: [session(['A', 'B', 'C', 'D']), session(['A', 'B', 'C', 'D'])],
  };
  data.sessions[0].status = 'done';
  data.sessions[1].status = 'done';

  const r = Engine.resetProgress(data);
  assert.deepEqual(r, { sessions: 2, players: 3 });
  assert.deepEqual(data.sessions, []);
  assert.equal(data.players.length, 3, 'the roster is kept');
  assert.deepEqual(data.players.map((p) => [p.name, p.skill, p.archived]),
    [['Ann', '3.5', false], ['Ben', '4.5', true], ['Cal', '2.0', undefined]], 'names, levels and archived flags untouched');
  assert.deepEqual(data.players.map((p) => p.rating), [1250, 1550, 900], 'each back to the rating their level starts at');
  data.players.forEach((p) => assert.deepEqual(p.ratingHistory, [], p.name + ' has no history'));
  assert.deepEqual(Engine.computeStats(data.sessions), {}, 'no stats remain');

  assert.deepEqual(Engine.resetProgress({ players: [], sessions: [] }), { sessions: 0, players: 0 }, 'an empty store is fine');
  assert.deepEqual(Engine.resetProgress({}), { sessions: 0, players: 0 }, 'so is a bare object');
});

/* ── player progression ───────────────────────────────────────────────── */

test('playerProgression walks the rating back through each session, oldest first', () => {
  const p = { id: 'A', name: 'Ann', skill: '3.5', rating: 1290 };
  const s1 = session(['A', 'B', 'C', 'D']); s1.id = 's1'; s1.status = 'done'; s1.startedAt = 100;
  s1.games.push({ seq: 1, teamA: ['A', 'B'], teamB: ['C', 'D'], scoreA: 11, scoreB: 5, done: true, ratingDeltas: { A: 16, B: 16, C: -16, D: -16 } });
  s1.games.push({ seq: 2, teamA: ['A', 'C'], teamB: ['B', 'D'], scoreA: 7, scoreB: 11, done: true, ratingDeltas: { A: -12, C: -12, B: 12, D: 12 } });
  const s2 = session(['B', 'C', 'D', 'E']); s2.id = 's2'; s2.status = 'done'; s2.startedAt = 200;   // Ann not there
  s2.games.push({ seq: 1, teamA: ['B', 'C'], teamB: ['D', 'E'], scoreA: 11, scoreB: 5, done: true, ratingDeltas: { B: 10, C: 10, D: -10, E: -10 } });
  const s3 = session(['A', 'B', 'C', 'D']); s3.id = 's3'; s3.startedAt = 300;                        // tonight, still running
  s3.games.push({ seq: 1, teamA: ['A', 'B'], teamB: ['C', 'D'], scoreA: 11, scoreB: 9, done: true, ratingDeltas: { A: 36, B: 36, C: -36, D: -36 } });
  s3.games.push({ seq: 2, teamA: ['A', 'C'], teamB: ['B', 'D'], scoreA: null, scoreB: null, done: false, ratingDeltas: null });

  const prog = Engine.playerProgression(p, [s1, s2, s3]);
  assert.equal(prog.start, 1250, 'the rating before her first game: 1290 - 36 - (16 - 12)');
  assert.deepEqual(prog.rows.map((r) => [r.id, r.wins, r.losses, r.diff, r.ratingAfter, r.ratingChange, r.active]), [
    ['s1', 1, 1, 2, 1254, 4, false],
    ['s3', 1, 0, 2, 1290, 36, true],
  ], 'a night she missed is left out; the unscored game counts for nothing');

  // A legacy game saved without deltas moves nothing; no games means no rows.
  const legacy = session(['A', 'B', 'C', 'D']); legacy.id = 'l'; legacy.status = 'done';
  legacy.games.push({ seq: 1, teamA: ['A', 'B'], teamB: ['C', 'D'], scoreA: 11, scoreB: 1, done: true });
  assert.deepEqual(Engine.playerProgression(p, [legacy]).rows.map((r) => [r.ratingAfter, r.ratingChange]), [[1290, 0]]);
  assert.deepEqual(Engine.playerProgression({ id: 'Z', rating: 1100 }, [s1, s2, s3]), { rows: [], start: 1100 });
});

/* ── tournament ───────────────────────────────────────────────────────── */

function categoriesOf(game, byId) {
  return onCourt(game).map((id) => Engine.skillCategory(byId[id].skill));
}

test('tournament is off unless the session turns it on', () => {
  const sess = session(['A', 'B', 'C', 'D']);
  assert.equal(Engine.tournament(sess), false, 'sessions saved before this option have no flag');
  sess.tournament = true;
  assert.equal(Engine.tournament(sess), true);
  assert.equal(Engine.divisionLabel('Novice'), 'Novice');
  assert.equal(Engine.divisionLabel(''), 'Unrated', 'a level off the scale forms a division of its own');
});

test('tournament: every game is within one division, over a long night of mixed levels', () => {
  // 4 Beginners, 5 Novices, 4 Intermediates on two courts with random game
  // lengths. No court ever mixes divisions, every game is tagged with its
  // division, and everyone gets a fair share of games.
  const table = {
    A: '1.5', B: '2.0', C: '2.5', D: '2.5',
    E: '3.0', F: '3.0', G: '3.5', H: '3.5', I: '3.5',
    J: '4.0', K: '4.0', L: '4.5', M: '4.5',
  };
  const byId = levelled(table);
  const sess = session(Object.keys(table), 2);
  sess.tournament = true;
  assert.equal(Engine.fillCourts(sess, byId).length, 2, 'both courts fill');
  for (let round = 0; round < 40; round++) {
    const active = Engine.activeGames(sess);
    const g = active[round % active.length];
    advance(2 * MIN + Math.floor(Math.random() * 6 * MIN));
    Engine.completeGame(g, 11, Math.floor(Math.random() * 11));
    Engine.fillCourts(sess, byId);
  }
  assert.ok(sess.games.length >= 40);
  sess.games.forEach((g) => {
    const cats = categoriesOf(g, byId);
    assert.ok(cats.every((c) => c === cats[0]), `mixed court: ${g.teamA} v ${g.teamB} (${cats})`);
    assert.equal(g.category, cats[0], 'the game records its division');
  });
  const counts = Engine.sessionCounts(sess).games;
  Object.keys(table).forEach((id) => assert.ok(counts[id] >= 6, `${id} played only ${counts[id]} games`));
});

test('tournament: a division with three players never gets a court, and never borrows a fourth', () => {
  const table = { A: '5.0', B: '5.0', C: '5.5', D: '3.0', E: '3.0', F: '3.5', G: '3.5', H: '3.5' };
  const byId = levelled(table);
  const sess = session(Object.keys(table), 2);
  sess.tournament = true;
  const started = Engine.fillCourts(sess, byId);
  assert.equal(started.length, 1, 'only the Novices can fill a court');
  assert.deepEqual(categoriesOf(started[0], byId), ['Novice', 'Novice', 'Novice', 'Novice']);
  const pool = Engine.waitingPool(sess);
  assert.deepEqual(pool.filter((id) => 'ABC'.includes(id)).sort(), ['A', 'B', 'C'], 'the three Experts wait');
  assert.equal(pool.length, 4, 'with the fifth Novice - whichever one the tie-break left out');
  advance(30 * MIN);
  Engine.completeGame(started[0], 11, 3);
  const next = Engine.fillCourts(sess, byId);
  assert.equal(next.length, 1);
  assert.deepEqual(categoriesOf(next[0], byId), ['Novice', 'Novice', 'Novice', 'Novice'],
    'half an hour on, the Experts still cannot play: nobody is pulled in to make four');
});

test('tournament: the court goes to the division of the longest wait, if four of them are ready', () => {
  const table = { A: '2.0', B: '2.0', C: '2.5', D: '2.5', E: '4.0', F: '4.0', G: '4.5', H: '4.5' };
  const byId = levelled(table);
  const sess = session(Object.keys(table), 1);
  sess.tournament = true;
  played(sess, ['A', 'B'], ['C', 'D']);            // Beginners free at t0
  advance(10 * MIN);
  played(sess, ['E', 'F'], ['G', 'H']);            // Intermediates free ten minutes later
  const g = Engine.fillCourts(sess, byId)[0];
  assert.deepEqual(onCourt(g).sort(), ['A', 'B', 'C', 'D'], 'the Beginners waited longer');
  assert.equal(g.category, 'Beginner');
});

test('tournament: a long wait in a division that cannot fill a court does not block the others', () => {
  // Two Experts have waited twenty minutes; four Novices just sat down. The
  // Experts cannot play (needs 4), so the court goes to the Novices.
  const table = { P: '5.0', Q: '5.5', A: '3.0', B: '3.0', C: '3.5', D: '3.5', X: '5.0', Y: '5.0' };
  const byId = levelled(table);
  const sess = session(['P', 'Q', 'A', 'B', 'C', 'D'], 1);
  sess.tournament = true;
  played(sess, ['P', 'X'], ['Q', 'Y']);
  advance(20 * MIN);
  played(sess, ['A', 'B'], ['C', 'D']);
  const g = Engine.fillCourts(sess, byId)[0];
  assert.deepEqual(onCourt(g).sort(), ['A', 'B', 'C', 'D']);
  assert.equal(g.category, 'Novice');
});

test('tournament: within a division the usual order holds - longest wait first, fewest games on ties', () => {
  const table = { A: '3.0', B: '3.5', C: '3.0', D: '3.0', E: '3.5', F: '3.5' };
  const byId = levelled(table);
  const sess = session(Object.keys(table), 1);
  sess.tournament = true;
  played(sess, ['A', 'B'], ['C', 'D']);            // all four free at t0
  played(sess, ['C', 'D'], ['E', 'F']);            // C, D on two games
  advance(10 * MIN);
  played(sess, ['C', 'E'], ['D', 'F']);            // C, D, E, F free now; C, D on three
  const four = onCourt(Engine.fillCourts(sess, byId)[0]);
  assert.ok(four.includes('A') && four.includes('B'), `A and B waited longest: ${four}`);
  assert.ok(four.includes('E') && four.includes('F'), `E and F have fewer games than C and D: ${four}`);
});

test('tournament: fixed pairs stay together, must share a division, and a straddling pair is never seated', () => {
  const table = { A: '3.0', B: '3.5', C: '3.0', D: '3.0', E: '3.5', F: '3.5', G: '4.0', H: '4.0', I: '4.5', J: '4.5' };
  const byId = levelled(table);
  const sess = session(Object.keys(table), 2);
  sess.tournament = true;
  sess.pairs = [];
  assert.equal(Engine.setPair(sess, 'A', 'B', byId).ok, true, 'two Novices can pair');
  const cross = Engine.setPair(sess, 'C', 'G', byId);
  assert.equal(cross.ok, false, 'a Novice and an Intermediate cannot');
  assert.match(cross.error, /same division/);
  assert.equal(Engine.setPair(sess, 'C', 'G').ok, true, 'without the players the engine cannot tell - as before');
  Engine.clearPair(sess, 'C');
  const plain = session(['C', 'G', 'H', 'I']);
  assert.equal(Engine.setPair(plain, 'C', 'G', byId).ok, true, 'outside a tournament any two can pair');

  Engine.fillCourts(sess, byId);
  for (let round = 0; round < 20; round++) {
    const active = Engine.activeGames(sess);
    const g = active[round % active.length];
    advance(3 * MIN);
    Engine.completeGame(g, 11, 5);
    Engine.fillCourts(sess, byId);
    Engine.activeGames(sess).forEach((game) => {
      const cats = categoriesOf(game, byId);
      assert.ok(cats.every((c) => c === cats[0]), `mixed court: ${game.teamA} v ${game.teamB}`);
      if (onCourt(game).includes('A') || onCourt(game).includes('B')) assert.ok(sameTeam(game, 'A', 'B'));
    });
  }

  // B's level is edited up to Intermediate while still paired with A. The
  // pair now straddles two divisions: it is reported, and never seated.
  Engine.activeGames(sess).forEach((g) => Engine.completeGame(g, 11, 2));
  byId.B.skill = '4.0';
  const unit = Engine.queueUnits(sess, byId).find((u) => u.ids.includes('A'));
  assert.deepEqual(unit.ids.slice().sort(), ['A', 'B']);
  assert.equal(Engine.unitCategory(unit, byId), null);
  const started = Engine.fillCourts(sess, byId);
  assert.equal(started.length, 2, 'the other eight still fill both courts');
  started.forEach((g) => assert.ok(!onCourt(g).includes('A') && !onCourt(g).includes('B'), 'the straddling pair sits'));
});

test('tournament: games carry their division, so a level edited later does not move results', () => {
  const table = { A: '3.0', B: '3.0', C: '3.5', D: '3.5', E: '4.0', F: '4.0', G: '4.5', H: '4.5', N: '2.0' };
  const byId = levelled(table);
  const sess = session(Object.keys(table), 2);
  sess.tournament = true;
  const started = Engine.fillCourts(sess, byId);
  assert.equal(started.length, 2);
  started.forEach((g) => Engine.completeGame(g, 11, 6));
  let divs = Engine.tournamentDivisions(sess, byId);
  assert.deepEqual(divs.map((d) => d.label), ['Beginner', 'Novice', 'Intermediate']);
  assert.deepEqual(divs.find((d) => d.name === 'Beginner').ids, ['N'], 'N has not played: current level');
  assert.deepEqual(divs.find((d) => d.name === 'Novice').ids.sort(), ['A', 'B', 'C', 'D']);
  assert.deepEqual(divs.find((d) => d.name === 'Intermediate').ids.sort(), ['E', 'F', 'G', 'H']);

  byId.A.skill = '5.0';                            // edited after the night
  divs = Engine.tournamentDivisions(sess, byId);
  assert.ok(divs.find((d) => d.name === 'Novice').ids.includes('A'), 'A played as a Novice and stays there');
  assert.ok(!divs.find((d) => d.name === 'Expert'));

  const plain = session(['A', 'B', 'C', 'D']);
  Engine.fillCourts(plain, byId);
  assert.equal(plain.games[0].category, undefined, 'a regular game is not tagged');
});

test('tournament: a late joiner goes to the back of the line in their own division', () => {
  const table = { A: '3.0', B: '3.0', C: '3.5', D: '3.5', E: '3.5', F: '3.0', G: '3.0' };
  const byId = levelled(table);
  const sess = session(['A', 'B', 'C', 'D', 'E'], 1);
  sess.tournament = true;
  played(sess, ['A', 'B'], ['C', 'D']);
  advance(5 * MIN);
  Engine.setSessionPlayers(sess, ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
  const g = Engine.fillCourts(sess, byId)[0];
  const four = onCourt(g);
  assert.ok(!four.includes('F') && !four.includes('G'), `the newcomers wait behind the five who were here: ${four}`);
  assert.ok(four.includes('E'), 'E has waited since the start with no games');
  assert.equal(g.category, 'Novice');
});

/* ── tournament: mixed-level pairs ────────────────────────────────────── */

test('mixed-level pairs are off unless the tournament turns them on', () => {
  const sess = session(['A', 'B', 'C', 'D']);
  sess.tournament = true;
  assert.equal(Engine.mixedPairs(sess), false, 'tournaments saved before this option have no flag');
  sess.mixedPairs = true;
  assert.equal(Engine.mixedPairs(sess), true);
});

test('mixed-level pairs: setPair allows partners of different levels only when the host turns it on', () => {
  const table = { A: '3.0', B: '4.0', C: '3.5', D: '3.5', E: '4.0', F: '4.5' };
  const byId = levelled(table);
  const sess = session(Object.keys(table));
  sess.tournament = true;
  sess.pairs = [];
  const refused = Engine.setPair(sess, 'A', 'B', byId);
  assert.equal(refused.ok, false, 'off: a Novice and an Intermediate cannot pair');
  assert.match(refused.error, /same division/);
  sess.mixedPairs = true;
  assert.equal(Engine.setPair(sess, 'A', 'B', byId).ok, true, 'on: they can');
  assert.deepEqual(sess.pairs, [['A', 'B']]);
  assert.equal(Engine.setPair(sess, 'C', 'D', byId).ok, true, 'same-division pairs still pair');
});

test('mixed-level pairs: a pair of different levels is in the higher division, and only when allowed', () => {
  const table = { A: '2.0', B: '3.5', C: '4.5', U: 'x' };   // U is off the scale
  const byId = levelled(table);
  const unit = { ids: ['A', 'B'] };
  assert.equal(Engine.unitCategory(unit, byId), null, 'without a session, as before: cannot be seated');
  assert.equal(Engine.unitCategory(unit, byId, { tournament: true }), null, 'off: cannot be seated');
  assert.equal(Engine.unitCategory(unit, byId, { tournament: true, mixedPairs: true }), 'Novice', 'on: the pair plays up');
  assert.equal(Engine.unitCategory({ ids: ['C', 'A'] }, byId, { mixedPairs: true }), 'Intermediate', 'order does not matter');
  assert.equal(Engine.unitCategory({ ids: ['U', 'A'] }, byId, { mixedPairs: true }), 'Beginner',
    'an unrated partner plays in the rated partner\'s division');
  assert.equal(Engine.unitCategory({ ids: ['B', 'B'] }, byId, { mixedPairs: true }), 'Novice', 'a same-division unit is unchanged');
  assert.equal(Engine.unitCategory({ ids: ['B'] }, byId, { mixedPairs: true }), 'Novice');
});

test('mixed-level pairs: playerDivision is the pair\'s division for a partner playing up, else their own level', () => {
  const table = { A: '3.0', B: '4.0', C: '3.5', D: '4.5' };
  const byId = levelled(table);
  const sess = session(Object.keys(table));
  sess.tournament = true;
  sess.pairs = [['A', 'B']];
  assert.equal(Engine.playerDivision(sess, byId, 'A'), 'Novice', 'off: the straddling pair cannot be seated, so A is read by level');
  assert.equal(Engine.playerDivision(sess, byId, 'C'), 'Novice');
  sess.mixedPairs = true;
  assert.equal(Engine.playerDivision(sess, byId, 'A'), 'Intermediate', 'on: A plays up with B');
  assert.equal(Engine.playerDivision(sess, byId, 'B'), 'Intermediate');
  assert.equal(Engine.playerDivision(sess, byId, 'C'), 'Novice', 'a single is unchanged');
  sess.pairs = [['C', 'D']];
  assert.equal(Engine.playerDivision(sess, byId, 'A'), 'Novice', 'unpaired again');
});

test('mixed-level pairs: the pair plays every game together in the higher division, courts otherwise unmixed', () => {
  // A (Novice) pairs with B (Intermediate), so they play as Intermediates.
  // Four other Novices, four other Intermediates and four Beginners on two
  // courts, over a long night of random game lengths.
  const table = {
    A: '3.0', B: '4.0',
    C: '3.0', D: '3.5', E: '3.5', F: '3.5',
    G: '4.0', H: '4.0', I: '4.5', J: '4.5',
    K: '1.5', L: '2.0', M: '2.5', N: '2.5',
  };
  const byId = levelled(table);
  const sess = session(Object.keys(table), 2);
  sess.tournament = true;
  sess.mixedPairs = true;
  sess.pairs = [['A', 'B']];
  Engine.fillCourts(sess, byId);
  for (let round = 0; round < 40; round++) {
    const active = Engine.activeGames(sess);
    const g = active[round % active.length];
    advance(2 * MIN + Math.floor(Math.random() * 6 * MIN));
    Engine.completeGame(g, 11, Math.floor(Math.random() * 11));
    Engine.fillCourts(sess, byId);
  }
  let pairGames = 0;
  sess.games.forEach((g) => {
    const four = onCourt(g);
    if (four.includes('A') || four.includes('B')) {
      pairGames++;
      assert.ok(sameTeam(g, 'A', 'B'), `the pair is split: ${g.teamA} v ${g.teamB}`);
      assert.equal(g.category, 'Intermediate', 'the pair plays up');
      four.filter((id) => id !== 'A' && id !== 'B').forEach((id) => {
        assert.equal(Engine.skillCategory(byId[id].skill), 'Intermediate', `${id} is not an Intermediate`);
      });
    } else {
      const cats = categoriesOf(g, byId);
      assert.ok(cats.every((c) => c === cats[0]), `mixed court: ${g.teamA} v ${g.teamB} (${cats})`);
      assert.equal(g.category, cats[0]);
    }
  });
  assert.ok(pairGames >= 5, `the pair played only ${pairGames} games`);
  const counts = Engine.sessionCounts(sess).games;
  Object.keys(table).forEach((id) => assert.ok(counts[id] >= 5, `${id} played only ${counts[id]} games`));
});

test('mixed-level pairs: standings list the partner playing up in the higher division, and a result stays put', () => {
  const table = { A: '3.0', B: '4.0', C: '3.0', D: '3.5', E: '3.5', F: '3.5', G: '4.0', H: '4.5' };
  const byId = levelled(table);
  const sess = session(Object.keys(table), 1);
  sess.tournament = true;
  sess.mixedPairs = true;
  sess.pairs = [['A', 'B']];
  let divs = Engine.tournamentDivisions(sess, byId);
  assert.deepEqual(divs.find((d) => d.name === 'Intermediate').ids.sort(), ['A', 'B', 'G', 'H'], 'before any game: by pair');
  assert.deepEqual(divs.find((d) => d.name === 'Novice').ids.sort(), ['C', 'D', 'E', 'F']);

  sess.games.push({
    id: 'x1', court: 1, seq: sess.nextSeq++, teamA: ['A', 'B'], teamB: ['G', 'H'],
    scoreA: 11, scoreB: 4, done: true, finishedAt: clock, ratingDeltas: null, category: 'Intermediate',
  });
  sess.pairs = [];
  sess.mixedPairs = false;
  divs = Engine.tournamentDivisions(sess, byId);
  assert.ok(divs.find((d) => d.name === 'Intermediate').ids.includes('A'), 'A played as an Intermediate: the result stays there');
  assert.ok(!divs.find((d) => d.name === 'Novice').ids.includes('A'));
});

test('mixed-level pairs: a Beginner paired with a Novice plays in Novice; the other three Beginners still wait', () => {
  const table = { P: '2.0', Q: '3.0', A: '2.0', B: '2.5', C: '2.5', D: '3.0', E: '3.5', F: '3.5' };
  const byId = levelled(table);
  const sess = session(Object.keys(table), 2);
  sess.tournament = true;
  sess.mixedPairs = true;
  sess.pairs = [['P', 'Q']];
  const started = Engine.fillCourts(sess, byId);
  assert.equal(started.length, 1, 'only the Novice court fills: P plays up, leaving three Beginners');
  const four = onCourt(started[0]);
  assert.ok(four.includes('P') && four.includes('Q') && sameTeam(started[0], 'P', 'Q'), `the pair plays together: ${four}`);
  assert.equal(started[0].category, 'Novice');
  four.filter((id) => id !== 'P' && id !== 'Q').forEach((id) => assert.equal(Engine.skillCategory(byId[id].skill), 'Novice'));
  const pool = Engine.waitingPool(sess);
  assert.ok(['A', 'B', 'C'].every((id) => pool.includes(id)), 'three Beginners cannot fill a court');

  // Turned off again mid-tournament: the pair can no longer be seated, and
  // with it gone neither division has four.
  advance(10 * MIN);
  Engine.completeGame(started[0], 11, 3);
  sess.mixedPairs = false;
  const unit = Engine.queueUnits(sess, byId).find((u) => u.ids.includes('P'));
  assert.equal(Engine.unitCategory(unit, byId, sess), null);
  assert.equal(Engine.fillCourts(sess, byId).length, 0);
});

test('mixed-level pairs: a level edited apart mid-tournament moves the pair up instead of stranding it', () => {
  const table = { A: '3.0', B: '3.5', C: '3.0', D: '3.5', E: '4.0', F: '4.0', G: '4.5' };
  const byId = levelled(table);
  const sess = session(Object.keys(table), 1);
  sess.tournament = true;
  sess.pairs = [['A', 'B']];
  const g1 = Engine.fillCourts(sess, byId)[0];
  assert.equal(g1.category, 'Novice', 'the four Novices fill the court; three Intermediates cannot');
  advance(5 * MIN);
  Engine.completeGame(g1, 11, 6);
  byId.B.skill = '4.0';
  assert.equal(Engine.fillCourts(sess, byId).length, 0, 'off: the pair straddles and nobody can fill a court');
  sess.mixedPairs = true;
  const g2 = Engine.fillCourts(sess, byId)[0];
  assert.equal(g2.category, 'Intermediate');
  assert.ok(sameTeam(g2, 'A', 'B'));
  onCourt(g2).filter((id) => id !== 'A' && id !== 'B').forEach((id) => {
    assert.equal(Engine.skillCategory(byId[id].skill), 'Intermediate', `${id} is not an Intermediate`);
  });
});

/* ── tournament: two groups ───────────────────────────────────────────── */

/* A two-group tournament: `table` maps id -> group (0 or 1); everyone is a
   3.5 unless `skills` says otherwise. */
function grouped(table, courts, skills) {
  const ids = Object.keys(table);
  const byId = {};
  ids.forEach((id) => {
    const skill = (skills && skills[id]) || '3.5';
    byId[id] = { id, name: id, skill, rating: Engine.initialRating(skill) };
  });
  const sess = session(ids, courts || 1);
  sess.tournament = true;
  sess.groups = { names: ['Reds', 'Blues'], of: Object.assign({}, table) };
  return { byId, sess };
}

function groupsOf(game, sess) {
  return [game.teamA.map((id) => Engine.playerGroup(sess, id)), game.teamB.map((id) => Engine.playerGroup(sess, id))];
}

test('two groups: off unless the tournament sets them; names and membership read safely', () => {
  const sess = session(['A', 'B', 'C', 'D']);
  assert.equal(Engine.groupPlay(sess), false, 'a regular session');
  sess.tournament = true;
  assert.equal(Engine.groupPlay(sess), false, 'a tournament by division, as saved before this option');
  assert.equal(Engine.playerGroup(sess, 'A'), -1);
  assert.equal(Engine.groupLabel(sess, 0), 'Group A', 'default names');
  assert.equal(Engine.groupLabel(sess, 1), 'Group B');
  sess.groups = { names: ['Sales', 'Marketing'], of: { A: 0, B: 0, C: 1, D: 1 } };
  assert.equal(Engine.groupPlay(sess), true);
  assert.equal(Engine.playerGroup(sess, 'A'), 0);
  assert.equal(Engine.playerGroup(sess, 'D'), 1);
  assert.equal(Engine.playerGroup(sess, 'Z'), -1, 'no group');
  assert.equal(Engine.groupLabel(sess, 1), 'Marketing');
  assert.equal(Engine.unitGroup(sess, { ids: ['A', 'B'] }), 0);
  assert.equal(Engine.unitGroup(sess, { ids: ['A', 'C'] }), -1, 'a pair across the groups cannot be seated');
  assert.equal(Engine.unitGroup(sess, { ids: ['Z'] }), -1);
  const plain = session(['A', 'B', 'C', 'D']);
  plain.groups = sess.groups;
  assert.equal(Engine.groupPlay(plain), false, 'groups mean nothing outside a tournament');
});

test('two groups: every game is two from one group against two from the other, over a long night', () => {
  // Ten against ten on three courts with random game lengths. Team A is
  // always the first group and team B the second, nobody ever partners or
  // faces their own group, and everyone gets a fair share of games.
  const table = {};
  'ABCDEFGHIJ'.split('').forEach((id) => { table[id] = 0; });
  'KLMNOPQRST'.split('').forEach((id) => { table[id] = 1; });
  const { byId, sess } = grouped(table, 3);
  assert.equal(Engine.fillCourts(sess, byId).length, 3, 'all three courts fill');
  for (let round = 0; round < 60; round++) {
    // Courts finish in no particular order, as on a real night.
    const active = Engine.activeGames(sess);
    const g = active[Math.floor(Math.random() * active.length)];
    advance(2 * MIN + Math.floor(Math.random() * 6 * MIN));
    Engine.completeGame(g, 11, Math.floor(Math.random() * 11));
    const started = Engine.fillCourts(sess, byId);
    // Longest wait first holds within each group: nobody left waiting has
    // waited more than the tie window longer than a group-mate who went on.
    started.forEach((game) => {
      [game.teamA, game.teamB].forEach((team, grp) => {
        const latestChosen = Math.max(...team.map((id) => Engine.waitSince(sess, id)));
        Engine.waitingPool(sess).filter((id) => table[id] === grp).forEach((waiter) => {
          assert.ok(Engine.waitSince(sess, waiter) >= latestChosen - Engine.TIE_WINDOW_MS,
            `${waiter} waited since ${Engine.waitSince(sess, waiter)} but ${latestChosen} was chosen`);
        });
      });
    });
  }
  assert.ok(sess.games.length >= 60);
  sess.games.forEach((g) => {
    assert.deepEqual(groupsOf(g, sess), [[0, 0], [1, 1]], `${g.teamA} v ${g.teamB}`);
    assert.deepEqual(g.groups, [0, 1], 'the game records its groups');
    assert.equal(g.category, undefined, 'and no division');
  });
  const counts = Engine.sessionCounts(sess).games;
  const played = Object.keys(table).map((id) => counts[id] || 0);
  assert.ok(Math.min(...played) >= 9, `someone played only ${Math.min(...played)} games`);
  // Longest wait first is the guarantee (asserted above); with random game
  // lengths the counts still stay close, as on a regular night.
  assert.ok(Math.max(...played) - Math.min(...played) <= 6, `uneven share: ${played}`);
});

test('two groups: a court is never filled from one group alone', () => {
  // Five Reds and one Blue: nobody can play. A second Blue arrives: one court.
  const { byId, sess } = grouped({ A: 0, B: 0, C: 0, D: 0, E: 0, K: 1, L: 1 }, 2);
  sess.playerIds = ['A', 'B', 'C', 'D', 'E', 'K'];           // L has not arrived yet
  assert.equal(Engine.fillCourts(sess, byId).length, 0, 'one Blue cannot make a side');
  advance(10 * MIN);
  assert.equal(Engine.fillCourts(sess, byId).length, 0, 'however long the Reds wait');
  Engine.setSessionPlayers(sess, ['A', 'B', 'C', 'D', 'E', 'K', 'L']);
  const started = Engine.fillCourts(sess, byId);
  assert.equal(started.length, 1, 'two Blues: one court; the other stays free');
  assert.deepEqual(started[0].teamB.slice().sort(), ['K', 'L']);
  assert.deepEqual(groupsOf(started[0], sess), [[0, 0], [1, 1]]);
  assert.equal(Engine.waitingPool(sess).length, 3, 'three Reds wait');
});

test('two groups: uneven groups still play, the smaller group more often and evenly', () => {
  const { byId, sess } = grouped({ A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, K: 1, L: 1, M: 1 }, 2);
  Engine.fillCourts(sess, byId);
  for (let round = 0; round < 30; round++) {
    const active = Engine.activeGames(sess);
    const g = active[round % active.length];
    advance(5 * MIN);
    Engine.completeGame(g, 11, 5);
    Engine.fillCourts(sess, byId);
  }
  sess.games.forEach((g) => assert.deepEqual(groupsOf(g, sess), [[0, 0], [1, 1]]));
  const counts = Engine.sessionCounts(sess).games;
  const reds = ['A', 'B', 'C', 'D', 'E', 'F'].map((id) => counts[id]);
  const blues = ['K', 'L', 'M'].map((id) => counts[id]);
  assert.ok(Math.min(...blues) > Math.max(...reds), `Blues ${blues} should play more than Reds ${reds}`);
  assert.ok(Math.max(...blues) - Math.min(...blues) <= 1, `Blues share evenly: ${blues}`);
  assert.ok(Math.max(...reds) - Math.min(...reds) <= 1, `Reds share evenly: ${reds}`);
});

test('two groups: within a group, longest wait first', () => {
  const { byId, sess } = grouped({ A: 0, B: 0, C: 0, D: 0, K: 1, L: 1, M: 1, N: 1 }, 1);
  played(sess, ['A', 'B'], ['K', 'L']);            // A, B, K, L free at t0
  advance(10 * MIN);
  played(sess, ['C', 'D'], ['M', 'N']);            // C, D, M, N free ten minutes later
  const g = Engine.fillCourts(sess, byId)[0];
  assert.deepEqual(g.teamA.slice().sort(), ['A', 'B'], 'the Reds who waited longest');
  assert.deepEqual(g.teamB.slice().sort(), ['K', 'L'], 'the Blues who waited longest');
  advance(5 * MIN);
  Engine.completeGame(g, 11, 2);                   // C, D, M, N have now waited five minutes longer
  const g2 = Engine.fillCourts(sess, byId)[0];
  assert.deepEqual(g2.teamA.slice().sort(), ['C', 'D']);
  assert.deepEqual(g2.teamB.slice().sort(), ['M', 'N']);
  advance(5 * MIN);
  Engine.completeGame(g2, 11, 2);
  const g3 = Engine.fillCourts(sess, byId)[0];
  assert.deepEqual(g3.teamA.slice().sort(), ['A', 'B'], 'and back again');
  assert.deepEqual(g3.teamB.slice().sort(), ['K', 'L']);
});

test('two groups: on equal waits, fewer games goes first', () => {
  const { byId, sess } = grouped({ A: 0, B: 0, C: 0, K: 1, L: 1, M: 1 }, 1);
  played(sess, ['A', 'B'], ['K', 'L']);
  played(sess, ['A', 'C'], ['K', 'M']);            // A and K on two games, the rest on one, all free now
  const g = Engine.fillCourts(sess, byId)[0];
  assert.deepEqual(g.teamA.slice().sort(), ['B', 'C'], `A has played more: ${g.teamA}`);
  assert.deepEqual(g.teamB.slice().sort(), ['L', 'M'], `K has played more: ${g.teamB}`);
});

test('two groups: fixed partners play together, must share a group, and a straddling pair is never seated', () => {
  const { byId, sess } = grouped({ A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, K: 1, L: 1, M: 1, N: 1, O: 1, P: 1 }, 2);
  sess.pairs = [];
  assert.equal(Engine.setPair(sess, 'A', 'B', byId).ok, true, 'two Reds can pair');
  const cross = Engine.setPair(sess, 'C', 'K', byId);
  assert.equal(cross.ok, false, 'a Red and a Blue cannot');
  assert.match(cross.error, /same group/);
  assert.equal(Engine.setPair(sess, 'C', 'K').ok, false, 'with or without the players');
  assert.equal(Engine.setPair(sess, 'C', 'D', byId).ok, true);
  Engine.clearPair(sess, 'C');
  assert.deepEqual(sess.pairs, [['A', 'B']]);

  Engine.fillCourts(sess, byId);
  for (let round = 0; round < 24; round++) {
    const active = Engine.activeGames(sess);
    const g = active[round % active.length];
    advance(3 * MIN);
    Engine.completeGame(g, 11, 5);
    Engine.fillCourts(sess, byId);
  }
  let pairGames = 0;
  sess.games.forEach((g) => {
    assert.deepEqual(groupsOf(g, sess), [[0, 0], [1, 1]]);
    if (onCourt(g).includes('A') || onCourt(g).includes('B')) {
      pairGames++;
      assert.ok(sameTeam(g, 'A', 'B'), `the pair is split: ${g.teamA} v ${g.teamB}`);
    }
  });
  assert.ok(pairGames >= 4, `the pair played only ${pairGames} games`);

  // B is moved to the Blues while still paired with A: the pair straddles
  // the groups and sits out; the other ten carry on.
  Engine.activeGames(sess).forEach((g) => Engine.completeGame(g, 11, 2));
  sess.groups.of.B = 1;
  const unit = Engine.queueUnits(sess, byId).find((u) => u.ids.includes('A'));
  assert.deepEqual(unit.ids.slice().sort(), ['A', 'B']);
  assert.equal(Engine.unitGroup(sess, unit), -1);
  const started = Engine.fillCourts(sess, byId);
  assert.equal(started.length, 2, 'the other ten still fill both courts');
  started.forEach((g) => assert.ok(!onCourt(g).includes('A') && !onCourt(g).includes('B'), 'the straddling pair sits'));
});

test('two groups: a lone single with only a pair behind them gives way, and is first for the next court', () => {
  const { byId, sess } = grouped({ X: 0, Y: 0, Z: 0, K: 1, L: 1, M: 1, W: 0 }, 1);
  sess.playerIds = ['X', 'Y', 'Z', 'K', 'L', 'M'];
  sess.pairs = [['Y', 'Z']];
  advance(5 * MIN);
  played(sess, ['Y', 'Z'], ['K', 'L']);            // X has waited five minutes longer than anyone
  const g = Engine.fillCourts(sess, byId)[0];
  assert.deepEqual(g.teamA.slice().sort(), ['Y', 'Z'], 'X alone cannot make a side with a pair: the pair plays');
  assert.ok(!onCourt(g).includes('X'));
  advance(5 * MIN);
  Engine.completeGame(g, 11, 4);
  Engine.setSessionPlayers(sess, ['X', 'Y', 'Z', 'K', 'L', 'M', 'W']);   // another Red arrives
  const g2 = Engine.fillCourts(sess, byId)[0];
  assert.deepEqual(g2.teamA.slice().sort(), ['W', 'X'], 'X, still first in line, plays with the newcomer');
});

test('two groups: the score between the groups, and a board per group', () => {
  const { byId, sess } = grouped({ A: 0, B: 0, C: 0, K: 1, L: 1, M: 1 }, 1);
  played(sess, ['A', 'B'], ['K', 'L'], 11, 7);
  played(sess, ['A', 'C'], ['K', 'M'], 9, 11);
  played(sess, ['B', 'C'], ['L', 'M'], 11, 3);
  sess.games.push({ id: 'live', court: 1, seq: 9, teamA: ['A', 'B'], teamB: ['K', 'L'], scoreA: null, scoreB: null, done: false });
  assert.deepEqual(Engine.groupScore(sess), { wins: [2, 1], points: [31, 21], games: 3 }, 'a game in progress does not count');
  Engine.setSessionPlayers(sess, ['A', 'B', 'K', 'L']);   // C and M go home
  const groups = Engine.tournamentGroups(sess);
  assert.deepEqual(groups.map((g) => g.label), ['Reds', 'Blues']);
  assert.deepEqual(groups.map((g) => g.index), [0, 1]);
  assert.deepEqual(groups[0].ids.slice().sort(), ['A', 'B', 'C'], 'C left but played, and keeps their group');
  assert.deepEqual(groups[1].ids.slice().sort(), ['K', 'L', 'M']);
  const stats = Engine.computeStats([sess]);
  const reds = Engine.rankStandings(stats, byId, groups[0].ids);
  assert.deepEqual(reds.ranked.map((r) => r.id), ['B', 'C', 'A'], 'B 2-0; C and A 1-1, C on point difference');
  const blues = Engine.rankStandings(stats, byId, groups[1].ids);
  assert.deepEqual(blues.ranked.map((r) => r.id), ['K', 'M', 'L'], 'K and M 1-1, K on point difference; L 0-2');
});

/* ── game clocks ──────────────────────────────────────────────────────── */

test('game clocks: every new game is stamped when it starts; its length is known once scored', () => {
  const byId = players(['A', 'B', 'C', 'D', 'E']);
  const sess = session(['A', 'B', 'C', 'D', 'E'], 1);
  const g = Engine.fillCourts(sess, byId)[0];
  assert.equal(g.startedAt, clock, 'a regular game carries its start time');
  assert.equal(g.groups, undefined, 'and no groups');
  assert.equal(Engine.gameDuration(g), null, 'not finished: no length yet');
  advance(13 * MIN + 20_000);
  Engine.completeGame(g, 11, 8);
  assert.equal(Engine.gameDuration(g), 13 * MIN + 20_000);
  const legacy = { teamA: ['A', 'B'], teamB: ['C', 'D'], done: true, finishedAt: clock, scoreA: 11, scoreB: 1 };
  assert.equal(Engine.gameDuration(legacy), null, 'a game from before clocks has no length');
  assert.equal(Engine.gameDuration({ startedAt: 10, finishedAt: 5 }), null, 'a clock that runs backwards is ignored');

  const table = { P: '3.0', Q: '3.0', R: '3.5', S: '3.5' };
  const tById = levelled(table);
  const tsess = session(Object.keys(table));
  tsess.tournament = true;
  const tg = Engine.fillCourts(tsess, tById)[0];
  assert.equal(tg.startedAt, clock, 'a division game too');
  assert.equal(tg.category, 'Novice');
  assert.equal(tg.groups, undefined);
});

test('game clocks: play times average each player\'s timed games; untimed games are left out', () => {
  const byId = players(['A', 'B', 'C', 'D']);
  const sess = session(['A', 'B', 'C', 'D'], 1);
  assert.deepEqual(Engine.playTimes(sess), {}, 'nothing played');
  const g1 = Engine.fillCourts(sess, byId)[0];
  advance(10 * MIN);
  Engine.completeGame(g1, 11, 0);
  const g2 = Engine.fillCourts(sess, byId)[0];
  advance(20 * MIN);
  Engine.completeGame(g2, 11, 0);
  played(sess, ['A', 'B'], ['C', 'D']);            // recorded without a clock
  const live = Engine.fillCourts(sess, byId)[0];  // in progress: not counted either
  assert.ok(live && !live.done);
  const times = Engine.playTimes(sess);
  ['A', 'B', 'C', 'D'].forEach((id) => {
    assert.equal(times[id].games, 2, `${id}: two timed games`);
    assert.equal(times[id].total, 30 * MIN);
    assert.equal(times[id].avg, 15 * MIN);
  });
  assert.equal(Engine.fmtDuration(0), '0s');
  assert.equal(Engine.fmtDuration(45_000), '45s');
  assert.equal(Engine.fmtDuration(13 * MIN + 20_000), '13m 20s');
  assert.equal(Engine.fmtDuration(62 * MIN + 5_000), '1h 02m');
});

test('game clocks: standings notes report the average game time when the play times are given', () => {
  const byId = players(['A', 'B', 'C', 'D', 'E']);
  const sess = session(['A', 'B', 'C', 'D', 'E'], 1);
  const g1 = { id: 'c1', court: 1, seq: 1, startedAt: clock, teamA: ['A', 'B'], teamB: ['C', 'D'], scoreA: null, scoreB: null, done: false };
  sess.games.push(g1);
  advance(12 * MIN + 30_000);
  Engine.completeGame(g1, 11, 4);
  played(sess, ['A', 'E'], ['C', 'D'], 11, 9);     // E's only game has no clock
  const stats = Engine.computeStats([sess]);
  const plain = Engine.rankStandings(stats, byId, null);
  plain.ranked.concat(plain.mentions).forEach((r) => {
    assert.doesNotMatch(r.note, /Average game time/, 'without the times, notes read as before');
    assert.equal(r.avgGame, null);
  });
  const timed = Engine.rankStandings(stats, byId, null, Engine.playTimes(sess));
  const rows = timed.ranked.concat(timed.mentions);
  assert.equal(rows.length, 5);
  rows.forEach((r) => {
    if (r.id === 'E') {
      assert.equal(r.avgGame, null, 'no timed game: no average');
      assert.doesNotMatch(r.note, /Average game time/);
    } else {
      assert.equal(r.avgGame, 12 * MIN + 30_000);
      assert.match(r.note, / Average game time: 12m 30s\.$/);
    }
    assert.ok(/^[\x20-\x7e]+$/.test(r.note), `PDF-safe: ${r.note}`);
  });
  assert.deepEqual(
    Engine.rankStandings(stats, byId, null, Engine.playTimes(sess)).ranked.map((r) => [r.id, r.note]),
    rows.filter((r) => r.rank).map((r) => [r.id, r.note]),
    'same input, same output');
});
