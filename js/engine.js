/* Engine: continuous fair rotation (per-court flow), Elo-style ratings, stats.
   Each court runs independently: as soon as its game is scored, the next game
   starts from the waiting pool. Fairness is longest wait first, measured by
   the clock; team-making maximizes partner/opponent variety and competitive
   balance among players who have waited the same length of time. */
(function () {
  'use strict';

  /* USA Pickleball skill scale, 2.0 through 5.5, mapped onto a rating ladder. */
  var SKILL_RATINGS = { '2.0': 900, '2.5': 1000, '3.0': 1100, '3.5': 1250, '4.0': 1400, '4.5': 1550, '5.0': 1700, '5.5': 1850 };
  var ELO_K = 32;

  /* Rec games are played to 11, win by 2 (USA Pickleball rule 12.A). */
  var GAME_TARGET = 11;

  /* Team-making weights. Repeat partners and opponents dominate; the rating
     term keeps games competitive without overriding variety. */
  var RATING_WEIGHT = 0.1;

  /*
   * Who plays next is decided by how long each person has been waiting.
   * Players whose waits began within TIE_WINDOW_MS of each other are treated
   * as having waited equally long — two courts finishing twenty seconds apart
   * should not force the same four back on together when mixing the eight
   * gives everyone a fresh game. Anyone who has waited longer than that
   * window is locked in and can never be skipped.
   *
   * Within a tie, fewer games played goes first. The engine may then look a
   * little past that order to avoid a bad court, but each person passed over
   * costs LEAPFROG_PENALTY, so it only happens when the alternative is clearly
   * worse (a third repeat partnership, a badly lopsided game).
   */
  var TIE_WINDOW_MS = 60 * 1000;
  var LEAPFROG_PENALTY = 60;
  var TIER_WINDOW = 2;

  function initialRating(skill) {
    return SKILL_RATINGS[skill] || 1250;
  }

  function pairKey(a, b) {
    return a < b ? a + '|' + b : b + '|' + a;
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* All matches of a session, whichever storage shape it uses
     (legacy round-based sessions keep rounds[]; current ones use games[]). */
  function sessionMatches(session) {
    var out = [];
    (session.rounds || []).forEach(function (r) {
      out = out.concat(r.matches);
    });
    return out.concat(session.games || []);
  }

  function activeGames(session) {
    return (session.games || []).filter(function (g) { return !g.done; });
  }

  /* Players in the session who are not on a court right now. */
  function waitingPool(session) {
    var busy = {};
    activeGames(session).forEach(function (g) {
      g.teamA.concat(g.teamB).forEach(function (id) { busy[id] = true; });
    });
    return session.playerIds.filter(function (id) { return !busy[id]; });
  }

  /* Tallies over every match created this session (active games count as
     played so the load stays balanced while they are in progress). */
  function sessionCounts(session) {
    var partners = {}, opponents = {}, games = {};
    sessionMatches(session).forEach(function (m) {
      m.teamA.concat(m.teamB).forEach(function (id) { games[id] = (games[id] || 0) + 1; });
      partners[pairKey(m.teamA[0], m.teamA[1])] = (partners[pairKey(m.teamA[0], m.teamA[1])] || 0) + 1;
      partners[pairKey(m.teamB[0], m.teamB[1])] = (partners[pairKey(m.teamB[0], m.teamB[1])] || 0) + 1;
      m.teamA.forEach(function (a) {
        m.teamB.forEach(function (b) {
          opponents[pairKey(a, b)] = (opponents[pairKey(a, b)] || 0) + 1;
        });
      });
    });
    return { partners: partners, opponents: opponents, games: games };
  }

  function effectiveGames(session, counts, id) {
    var meta = session.playerMeta || {};
    return (counts.games[id] || 0) + ((meta[id] && meta[id].gamesCredit) || 0);
  }

  /*
   * Cost of one court's grouping (4 players split into two teams).
   * Heavily penalize repeat partners, moderately penalize repeat opponents,
   * lightly prefer teams with similar combined ratings (competitive games).
   */
  function pairingCost(t1, t2, counts, ratingOf) {
    var cost = 0;
    cost += (counts.partners[pairKey(t1[0], t1[1])] || 0) * 100;
    cost += (counts.partners[pairKey(t2[0], t2[1])] || 0) * 100;
    t1.forEach(function (a) {
      t2.forEach(function (b) {
        cost += (counts.opponents[pairKey(a, b)] || 0) * 20;
      });
    });
    var diff = Math.abs((ratingOf(t1[0]) + ratingOf(t1[1])) - (ratingOf(t2[0]) + ratingOf(t2[1])));
    cost += diff * RATING_WEIGHT;
    return cost;
  }

  function bestSplitOfFour(four, counts, ratingOf) {
    var a = four[0], b = four[1], c = four[2], d = four[3];
    var options = [
      [[a, b], [c, d]],
      [[a, c], [b, d]],
      [[a, d], [b, c]]
    ];
    var best = null, bestCost = Infinity;
    options.forEach(function (opt) {
      var cost = pairingCost(opt[0], opt[1], counts, ratingOf);
      if (cost < bestCost) { bestCost = cost; best = opt; }
    });
    return { teams: best, cost: bestCost };
  }

  /*
   * The moment a player's current wait began, as a timestamp: when their
   * last game was scored, when they arrived, or the start of the session —
   * whichever is latest.
   *
   * Real clock time, not game numbers. With two courts, game 5 can finish
   * after game 6 if it goes to a long deuce; its players sat down later and
   * have waited less, and only a timestamp gets that right.
   */
  function waitSince(session, id) {
    var since = session.startedAt || 0;
    var meta = (session.playerMeta || {})[id];
    if (meta && meta.joinedAt) since = Math.max(since, meta.joinedAt);
    (session.games || []).forEach(function (m) {
      if (m.done && m.finishedAt && (m.teamA.indexOf(id) >= 0 || m.teamB.indexOf(id) >= 0)) {
        since = Math.max(since, m.finishedAt);
      }
    });
    return since;
  }

  /* Record a final score. The timestamp is what the wait order runs on, so
     it is set here and nowhere else — editing a score later must not touch it. */
  function completeGame(game, scoreA, scoreB) {
    game.scoreA = scoreA;
    game.scoreB = scoreB;
    game.done = true;
    game.finishedAt = Date.now();
    return game;
  }

  /*
   * Set the session's player list. Newcomers are credited with the lightest
   * current load (used only to break ties among equal waits) and their wait
   * is clocked from now, so they join the back of the line. Rejoining
   * restarts the clock but keeps any earlier credit.
   */
  function setSessionPlayers(session, ids) {
    var counts = sessionCounts(session);
    var meta = session.playerMeta || (session.playerMeta = {});
    var effs = session.playerIds.map(function (id) { return effectiveGames(session, counts, id); });
    var minEff = effs.length ? Math.min.apply(null, effs) : 0;
    ids.forEach(function (id) {
      if (session.playerIds.indexOf(id) >= 0) return;
      if (!meta[id]) meta[id] = { gamesCredit: minEff };
      meta[id].joinedAt = Date.now();
    });
    session.playerIds = ids;
  }

  /* Waiting players in the order they are entitled to play: longest wait
     first, then fewest games. `randomize` breaks exact ties by chance (used
     when actually picking a game); otherwise roster order keeps the displayed
     list from shuffling between renders. */
  function rankPool(session, playersById, randomize) {
    var pool = waitingPool(session).filter(function (id) { return playersById[id]; });
    var counts = sessionCounts(session);
    var order = randomize ? shuffle(pool) : pool;
    var scored = order.map(function (id) {
      return { id: id, eff: effectiveGames(session, counts, id), since: waitSince(session, id) };
    });
    scored.sort(function (a, b) {
      if (a.since !== b.since) return a.since - b.since;
      return a.eff - b.eff;
    });
    return { scored: scored, counts: counts };
  }

  function queueOrder(session, playersById) {
    return rankPool(session, playersById, false).scored;
  }

  /*
   * Colour bands for a waiting list already in queue order. People whose
   * waits began within TIE_WINDOW_MS of each other share a band — a whole
   * court's worth of players who finished together is one group. The group
   * that has waited longest is red, the most recent to sit down or arrive is
   * green, anything between is yellow. One group means everyone is red: they
   * have all waited equally and are all up next.
   */
  function waitBands(queue) {
    var groups = [];
    queue.forEach(function (q) {
      var g = groups[groups.length - 1];
      if (g && q.since - g.since <= TIE_WINDOW_MS) g.count++;
      else groups.push({ since: q.since, count: 1 });
    });
    var bands = [];
    groups.forEach(function (g, gi) {
      var band = gi === 0 ? 'red' : gi === groups.length - 1 ? 'green' : 'yellow';
      for (var i = 0; i < g.count; i++) bands.push(band);
    });
    return bands;
  }

  /* All k-sized subsets of a short list. Bounded by TIER_WINDOW, so at most
     C(6,4) = 15 combinations are ever evaluated. */
  function combos(items, k) {
    var out = [];
    (function rec(start, acc) {
      if (acc.length === k) { out.push(acc.slice()); return; }
      for (var i = start; i < items.length; i++) {
        acc.push(items[i]);
        rec(i + 1, acc);
        acc.pop();
      }
    })(0, []);
    return out;
  }

  /* Is `other` more entitled to play than `chosen` within one tie tier? */
  function outranks(other, chosen) {
    if (other.eff !== chosen.eff) return other.eff < chosen.eff;
    return other.since < chosen.since;
  }

  /*
   * Pick the next 4 players for a free court.
   *
   * Longest wait is the hard constraint. Anyone whose wait began more than
   * TIE_WINDOW_MS before the fourth-ranked player's is locked in and cannot
   * be skipped. Everyone within the window of that fourth player forms a
   * tie; among them, fewer games goes first, and the engine may look up to
   * TIER_WINDOW places past that to avoid a clearly worse court, paying
   * LEAPFROG_PENALTY for each person it passes over.
   */
  function nextGame(session, playersById) {
    var ranked = rankPool(session, playersById, true);
    var scored = ranked.scored, counts = ranked.counts;
    if (scored.length < 4) return null;

    function ratingOf(id) {
      return (playersById[id] && playersById[id].rating) || 1250;
    }

    var pivot = scored[3].since;
    var locked = [], tier = [];
    scored.forEach(function (s) {
      if (s.since < pivot - TIE_WINDOW_MS) locked.push(s);
      else if (s.since <= pivot + TIE_WINDOW_MS) tier.push(s);
    });
    tier.sort(function (a, b) {
      if (a.eff !== b.eff) return a.eff - b.eff;
      return a.since - b.since;
    });
    var need = 4 - locked.length;
    var candidates = tier.slice(0, need + TIER_WINDOW);

    var best = null, bestCost = Infinity;
    combos(candidates, need).forEach(function (pick) {
      var four = locked.concat(pick).map(function (s) { return s.id; });
      var split = bestSplitOfFour(four, counts, ratingOf);
      var cost = split.cost;
      pick.forEach(function (chosen) {
        candidates.forEach(function (other) {
          if (pick.indexOf(other) < 0 && outranks(other, chosen)) cost += LEAPFROG_PENALTY;
        });
      });
      if (cost < bestCost) { bestCost = cost; best = split; }
    });
    return { teamA: best.teams[0], teamB: best.teams[1] };
  }

  /*
   * Validate a final score against USA Pickleball rule 12.A for a game to 11.
   * The first side to reach 11 with a two-point lead wins; tied at 10–10 or
   * later, play continues until one side leads by exactly 2. So a finished
   * game is always either 11 to 9-or-less, or a winner past 11 with the loser
   * exactly 2 behind. Anything else is unfinished or mistyped, and refused.
   */
  function checkScore(a, b) {
    if (a === null || b === null || a === undefined || b === undefined || isNaN(a) || isNaN(b)) {
      return { ok: false, error: 'Enter both scores.' };
    }
    if (a < 0 || b < 0) return { ok: false, error: 'Scores cannot be negative.' };
    if (a === b) return { ok: false, error: 'Pickleball games cannot end in a tie.' };
    var hi = Math.max(a, b), lo = Math.min(a, b);
    if (hi < GAME_TARGET) {
      return { ok: false,
        error: 'Games are played to ' + GAME_TARGET + '. ' + hi + '–' + lo + ' is not a finished game.' };
    }
    if (hi - lo < 2) {
      return { ok: false,
        error: 'A game must be won by 2 points. ' + hi + '–' + lo + ' is not a finished game.' };
    }
    if (hi > GAME_TARGET && hi - lo !== 2) {
      return { ok: false,
        error: 'Past ' + GAME_TARGET + ' a game ends as soon as one side leads by 2, so ' +
          hi + '–' + lo + ' is not possible. Check the scores.' };
    }
    return { ok: true, error: null };
  }

  /* Start a game on every free court that has enough waiting players.
     Returns the games that were started. */
  function fillCourts(session, playersById) {
    var started = [];
    for (var c = 1; c <= session.courtCount; c++) {
      var taken = activeGames(session).some(function (g) { return g.court === c; });
      if (taken) continue;
      var next = nextGame(session, playersById);
      if (!next) break;
      var game = {
        id: Storage_.newId(),
        court: c,
        seq: session.nextSeq++,
        teamA: next.teamA,
        teamB: next.teamB,
        scoreA: null,
        scoreB: null,
        done: false,
        finishedAt: null,
        ratingDeltas: null
      };
      session.games.push(game);
      started.push(game);
    }
    return started;
  }

  /* One-time upgrade of a legacy round-based ACTIVE session to the
     continuous model. Finished sessions keep their shape (read-only). */
  function migrateSession(session) {
    if (session.status !== 'active' || session.games) return false;
    session.games = [];
    session.nextSeq = 1;
    session.playerMeta = session.playerMeta || {};
    Object.keys(session.playerMeta).forEach(function (id) {
      if (session.playerMeta[id].gamesCredit === undefined) session.playerMeta[id].gamesCredit = 0;
    });
    var rounds = session.rounds || [];
    rounds.forEach(function (r, i) {
      r.matches.forEach(function (m) {
        // Unscored games in past rounds were skipped under the old model
        if (!m.done && i < rounds.length - 1) return;
        m.seq = session.nextSeq++;
        session.games.push(m);
      });
    });
    session.rounds = [];
    return true;
  }

  /*
   * One-time repair for a session that is already running when an update
   * ships. Games scored before timestamps existed get a synthetic finishedAt
   * a few milliseconds after the session start, in sequence order — earlier
   * than any game scored from now on, which is correct: those players did
   * become available first. Late joiners recorded without joinedAt get one on
   * the same synthetic scale. Returns whether anything changed, so the caller
   * knows to save.
   */
  function normalizeSession(session) {
    if (session.status !== 'active') return false;
    var base = session.startedAt || 0;
    var changed = false;

    (session.games || []).forEach(function (m) {
      if (m.done && !m.finishedAt) {
        m.finishedAt = base + (m.seq || 0);
        changed = true;
      }
    });

    // A joiner with no recorded arrival time is assumed to have arrived just
    // after the most recent finished game. Anything earlier could rank them
    // ahead of people already waiting — the very bug this app was fixed for.
    var latest = base;
    (session.games || []).forEach(function (m) {
      if (m.done && m.finishedAt) latest = Math.max(latest, m.finishedAt);
    });
    var meta = session.playerMeta || {};
    Object.keys(meta).forEach(function (id) {
      if (meta[id] && !meta[id].joinedAt) {
        var bySeq = base + (meta[id].joinedSeq || session.nextSeq || 1);
        meta[id].joinedAt = Math.max(bySeq, latest + 1);
        changed = true;
      }
    });
    return changed;
  }

  /* Elo update for a completed doubles game; returns {playerId: delta}. */
  function computeRatingDeltas(match, playersById) {
    function avg(team) {
      return team.reduce(function (s, id) {
        return s + ((playersById[id] && playersById[id].rating) || 1250);
      }, 0) / team.length;
    }
    var ra = avg(match.teamA), rb = avg(match.teamB);
    var expectedA = 1 / (1 + Math.pow(10, (rb - ra) / 400));
    var actualA = match.scoreA > match.scoreB ? 1 : 0;
    var deltaA = Math.round(ELO_K * (actualA - expectedA));
    var deltas = {};
    match.teamA.forEach(function (id) { deltas[id] = deltaA; });
    match.teamB.forEach(function (id) { deltas[id] = -deltaA; });
    return deltas;
  }

  /* Apply (or revert, with sign -1) rating deltas to players. */
  function applyDeltas(deltas, playersById, sign) {
    Object.keys(deltas).forEach(function (id) {
      var p = playersById[id];
      if (!p) return;
      p.rating += sign * deltas[id];
      if (sign > 0) {
        p.ratingHistory = p.ratingHistory || [];
        p.ratingHistory.push({ t: Date.now(), r: p.rating });
      }
    });
  }

  /* Aggregate W/L/points stats from completed matches. Anyone who finished
     a game is included, whether or not they are still in the session — a
     player who left early still played. */
  function computeStats(sessions) {
    var stats = {}; // id -> {games, wins, losses, pf, pa}
    function ensure(id) {
      if (!stats[id]) stats[id] = { games: 0, wins: 0, losses: 0, pf: 0, pa: 0 };
      return stats[id];
    }
    sessions.forEach(function (session) {
      sessionMatches(session).forEach(function (m) {
        if (!m.done) return;
        var aWon = m.scoreA > m.scoreB;
        m.teamA.forEach(function (id) {
          var s = ensure(id);
          s.games++; s.pf += m.scoreA; s.pa += m.scoreB;
          if (aWon) s.wins++; else s.losses++;
        });
        m.teamB.forEach(function (id) {
          var s = ensure(id);
          s.games++; s.pf += m.scoreB; s.pa += m.scoreA;
          if (aWon) s.losses++; else s.wins++;
        });
      });
    });
    return stats;
  }

  /* Everyone who was part of a session: still checked in, or finished a game
     before leaving. Used for the "N players" figure and the standings. */
  function sessionParticipants(session) {
    var seen = {};
    (session.playerIds || []).forEach(function (id) { seen[id] = true; });
    sessionMatches(session).forEach(function (m) {
      if (!m.done) return;
      m.teamA.concat(m.teamB).forEach(function (id) { seen[id] = true; });
    });
    return Object.keys(seen);
  }

  window.Engine = {
    initialRating: initialRating,
    sessionMatches: sessionMatches,
    activeGames: activeGames,
    waitingPool: waitingPool,
    sessionCounts: sessionCounts,
    effectiveGames: effectiveGames,
    waitSince: waitSince,
    waitBands: waitBands,
    completeGame: completeGame,
    setSessionPlayers: setSessionPlayers,
    queueOrder: queueOrder,
    fillCourts: fillCourts,
    checkScore: checkScore,
    migrateSession: migrateSession,
    normalizeSession: normalizeSession,
    computeRatingDeltas: computeRatingDeltas,
    applyDeltas: applyDeltas,
    computeStats: computeStats,
    sessionParticipants: sessionParticipants,
    GAME_TARGET: GAME_TARGET,
    TIE_WINDOW_MS: TIE_WINDOW_MS,
    SKILL_LEVELS: ['2.0', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0', '5.5']
  };
})();
