/* Engine: continuous fair rotation (per-court flow), Elo-style ratings, stats.
   Each court runs independently: as soon as its game is scored, the next game
   starts from the waiting pool. Fairness balances games played and wait time;
   team-making maximizes partner/opponent variety and competitive balance. */
(function () {
  'use strict';

  var SKILL_RATINGS = { '2.5': 1000, '3.0': 1100, '3.5': 1250, '4.0': 1400, '4.5': 1550, '5.0': 1700 };
  var ELO_K = 32;

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

  function lastPlayedSeq(session, id) {
    var last = 0;
    (session.games || []).forEach(function (m) {
      if (m.done && m.seq && (m.teamA.indexOf(id) >= 0 || m.teamB.indexOf(id) >= 0)) {
        last = Math.max(last, m.seq);
      }
    });
    return last;
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
    cost += diff * 0.02;
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
    return best;
  }

  /*
   * Pick the next 4 players for a free court. Fairness rule: fewest games
   * played first (late joiners carry a credit so they slot in evenly),
   * then whoever has been waiting longest; ties break randomly.
   */
  function nextGame(session, playersById) {
    var pool = waitingPool(session).filter(function (id) { return playersById[id]; });
    if (pool.length < 4) return null;
    var counts = sessionCounts(session);
    var scored = shuffle(pool).map(function (id) {
      return { id: id, eff: effectiveGames(session, counts, id), last: lastPlayedSeq(session, id) };
    });
    scored.sort(function (a, b) {
      if (a.eff !== b.eff) return a.eff - b.eff;
      return a.last - b.last;
    });
    var four = scored.slice(0, 4).map(function (s) { return s.id; });
    function ratingOf(id) {
      return (playersById[id] && playersById[id].rating) || 1250;
    }
    var teams = bestSplitOfFour(four, counts, ratingOf);
    return { teamA: teams[0], teamB: teams[1] };
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

  /* Aggregate W/L/points stats from completed matches. */
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

  window.Engine = {
    initialRating: initialRating,
    sessionMatches: sessionMatches,
    activeGames: activeGames,
    waitingPool: waitingPool,
    sessionCounts: sessionCounts,
    effectiveGames: effectiveGames,
    fillCourts: fillCourts,
    migrateSession: migrateSession,
    computeRatingDeltas: computeRatingDeltas,
    applyDeltas: applyDeltas,
    computeStats: computeStats,
    SKILL_LEVELS: ['2.5', '3.0', '3.5', '4.0', '4.5', '5.0']
  };
})();
