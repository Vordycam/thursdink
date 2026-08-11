/* Engine: fair round-robin doubles rotation, Elo-style ratings, stats. */
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

  /* Tallies from rounds played so far in this session. */
  function sessionCounts(session) {
    var sitOuts = {}, partners = {}, opponents = {}, games = {};
    session.playerIds.forEach(function (id) {
      sitOuts[id] = 0;
      games[id] = 0;
    });
    session.rounds.forEach(function (round) {
      round.sitOuts.forEach(function (id) {
        sitOuts[id] = (sitOuts[id] || 0) + 1;
      });
      round.matches.forEach(function (m) {
        var all = m.teamA.concat(m.teamB);
        all.forEach(function (id) { games[id] = (games[id] || 0) + 1; });
        partners[pairKey(m.teamA[0], m.teamA[1])] = (partners[pairKey(m.teamA[0], m.teamA[1])] || 0) + 1;
        partners[pairKey(m.teamB[0], m.teamB[1])] = (partners[pairKey(m.teamB[0], m.teamB[1])] || 0) + 1;
        m.teamA.forEach(function (a) {
          m.teamB.forEach(function (b) {
            opponents[pairKey(a, b)] = (opponents[pairKey(a, b)] || 0) + 1;
          });
        });
      });
    });
    return { sitOuts: sitOuts, partners: partners, opponents: opponents, games: games };
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /*
   * Pick who sits out this round. Fairness rule: the players who have sat out
   * the least (including a "credit" for late joiners so they are not forced to
   * sit immediately) sit next. Ties broken by most games played, then randomly.
   */
  function pickSitOuts(session, numSit, counts) {
    if (numSit <= 0) return [];
    var meta = session.playerMeta || {};
    var scored = shuffle(session.playerIds).map(function (id) {
      var credit = (meta[id] && meta[id].sitCredit) || 0;
      return { id: id, eff: (counts.sitOuts[id] || 0) + credit, games: counts.games[id] || 0 };
    });
    scored.sort(function (a, b) {
      if (a.eff !== b.eff) return a.eff - b.eff;
      return b.games - a.games;
    });
    return scored.slice(0, numSit).map(function (s) { return s.id; });
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
    return { teams: best, cost: bestCost };
  }

  /*
   * Generate the next round: choose sit-outs, then search for the court
   * assignment that maximizes partner/opponent variety via random restarts.
   */
  function generateRound(session, playersById) {
    var counts = sessionCounts(session);
    var active = session.playerIds.filter(function (id) { return playersById[id]; });
    var maxPlaying = Math.min(session.courtCount * 4, Math.floor(active.length / 4) * 4);
    if (maxPlaying < 4) return null;
    var numSit = active.length - maxPlaying;
    var sitOuts = pickSitOuts(session, numSit, counts);
    var sitSet = {};
    sitOuts.forEach(function (id) { sitSet[id] = true; });
    var playing = active.filter(function (id) { return !sitSet[id]; });

    function ratingOf(id) {
      return (playersById[id] && playersById[id].rating) || 1250;
    }

    var bestAssign = null, bestCost = Infinity;
    var iterations = 400;
    for (var it = 0; it < iterations; it++) {
      var order = shuffle(playing);
      var matches = [];
      var total = 0;
      for (var c = 0; c < order.length / 4; c++) {
        var four = order.slice(c * 4, c * 4 + 4);
        var split = bestSplitOfFour(four, counts, ratingOf);
        total += split.cost;
        matches.push({ teamA: split.teams[0], teamB: split.teams[1] });
      }
      if (total < bestCost) {
        bestCost = total;
        bestAssign = matches;
        if (bestCost === 0) break;
      }
    }

    return {
      number: session.rounds.length + 1,
      sitOuts: sitOuts,
      matches: bestAssign.map(function (m, i) {
        return {
          id: Storage_.newId(),
          court: i + 1,
          teamA: m.teamA,
          teamB: m.teamB,
          scoreA: null,
          scoreB: null,
          done: false,
          ratingDeltas: null
        };
      })
    };
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

  /* Aggregate stats from completed matches. scope: array of sessions. */
  function computeStats(sessions, playerFilter) {
    var stats = {}; // id -> {games, wins, losses, pf, pa}
    function ensure(id) {
      if (!stats[id]) stats[id] = { games: 0, wins: 0, losses: 0, pf: 0, pa: 0 };
      return stats[id];
    }
    sessions.forEach(function (session) {
      session.rounds.forEach(function (round) {
        round.matches.forEach(function (m) {
          if (!m.done) return;
          var aWon = m.scoreA > m.scoreB;
          m.teamA.forEach(function (id) {
            if (playerFilter && !playerFilter[id]) return;
            var s = ensure(id);
            s.games++; s.pf += m.scoreA; s.pa += m.scoreB;
            if (aWon) s.wins++; else s.losses++;
          });
          m.teamB.forEach(function (id) {
            if (playerFilter && !playerFilter[id]) return;
            var s = ensure(id);
            s.games++; s.pf += m.scoreB; s.pa += m.scoreA;
            if (aWon) s.losses++; else s.wins++;
          });
        });
      });
    });
    return stats;
  }

  window.Engine = {
    initialRating: initialRating,
    sessionCounts: sessionCounts,
    generateRound: generateRound,
    computeRatingDeltas: computeRatingDeltas,
    applyDeltas: applyDeltas,
    computeStats: computeStats,
    SKILL_LEVELS: ['2.5', '3.0', '3.5', '4.0', '4.5', '5.0']
  };
})();
