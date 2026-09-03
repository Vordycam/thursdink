/* Engine: continuous fair rotation (per-court flow), Elo-style ratings, stats.
   Each court runs independently: as soon as its game is scored, the next game
   starts from the waiting pool. Fairness balances games played and wait time;
   team-making maximizes partner/opponent variety and competitive balance. */
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

  /* Choosing WHICH four play next: among players tied on games played, the
     engine may look a little past strict wait order to avoid a bad game —
     but passing over someone who has waited longer costs this much, so it
     only happens when the alternative is clearly worse (a third repeat
     partnership, a badly lopsided court). Fewer games always wins outright. */
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
   * When a player's wait began, in game-sequence terms: the game they last
   * finished, or the moment they joined if they have not played yet.
   *
   * This is the fix for late joiners jumping the line. A player who had never
   * played returned 0 here — read by the sort as "waiting since before game
   * 1" — so anyone added mid-session went straight to the front, ahead of
   * people who had genuinely been waiting for several games.
   */
  function waitStart(session, id) {
    var meta = (session.playerMeta || {})[id];
    var joined = (meta && meta.joinedSeq) || 0;
    return Math.max(lastPlayedSeq(session, id), joined);
  }

  /*
   * Set the session's player list. Newcomers are credited with the lightest
   * current load, so they cannot monopolise the next several games to "catch
   * up", and their wait is clocked from now, so they cannot jump anyone who is
   * already in line. Rejoining refreshes the clock but keeps earlier credit.
   */
  function setSessionPlayers(session, ids) {
    var counts = sessionCounts(session);
    var meta = session.playerMeta || (session.playerMeta = {});
    var effs = session.playerIds.map(function (id) { return effectiveGames(session, counts, id); });
    var minEff = effs.length ? Math.min.apply(null, effs) : 0;
    ids.forEach(function (id) {
      if (session.playerIds.indexOf(id) >= 0) return;
      if (!meta[id]) meta[id] = { gamesCredit: minEff };
      meta[id].joinedSeq = session.nextSeq || 1;
    });
    session.playerIds = ids;
  }

  /* Waiting players in the order they are entitled to play: fewest games
     first, then longest wait. `randomize` breaks exact ties by chance (used
     when actually picking a game); otherwise roster order keeps the displayed
     list from shuffling between renders. */
  function rankPool(session, playersById, randomize) {
    var pool = waitingPool(session).filter(function (id) { return playersById[id]; });
    var counts = sessionCounts(session);
    var order = randomize ? shuffle(pool) : pool;
    var scored = order.map(function (id) {
      return { id: id, eff: effectiveGames(session, counts, id), wait: waitStart(session, id) };
    });
    scored.sort(function (a, b) {
      if (a.eff !== b.eff) return a.eff - b.eff;
      return a.wait - b.wait;
    });
    return { scored: scored, counts: counts };
  }

  function queueOrder(session, playersById) {
    return rankPool(session, playersById, false).scored;
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

  /*
   * Pick the next 4 players for a free court.
   *
   * Fairness is the hard constraint: anyone with strictly fewer games than
   * the fourth-ranked player is locked in and can never be skipped. Only
   * among players TIED on games played does the engine look a little past
   * strict wait order, and each player passed over costs LEAPFROG_PENALTY —
   * so a longer-waiting player is only stepped over when the alternative
   * game is clearly worse, never for a marginal gain.
   */
  function nextGame(session, playersById) {
    var ranked = rankPool(session, playersById, true);
    var scored = ranked.scored, counts = ranked.counts;
    if (scored.length < 4) return null;

    function ratingOf(id) {
      return (playersById[id] && playersById[id].rating) || 1250;
    }

    var cutoff = scored[3].eff;
    var locked = [], tier = [];
    scored.forEach(function (s) {
      if (s.eff < cutoff) locked.push(s);
      else if (s.eff === cutoff) tier.push(s);
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
          if (pick.indexOf(other) < 0 && other.wait < chosen.wait) cost += LEAPFROG_PENALTY;
        });
      });
      if (cost < bestCost) { bestCost = cost; best = split; }
    });
    return { teamA: best.teams[0], teamB: best.teams[1] };
  }

  /*
   * Validate a final score against USA Pickleball rules. A game is won by
   * the first side to reach the target with a two-point margin; the margin
   * is a hard rule, the target is the rec-play default and only warns, since
   * some groups play short or timed games.
   */
  function checkScore(a, b) {
    if (a === null || b === null || a === undefined || b === undefined || isNaN(a) || isNaN(b)) {
      return { ok: false, error: 'Enter both scores.', warn: null };
    }
    if (a < 0 || b < 0) return { ok: false, error: 'Scores cannot be negative.', warn: null };
    if (a === b) return { ok: false, error: 'Pickleball games cannot end in a tie.', warn: null };
    var hi = Math.max(a, b), lo = Math.min(a, b);
    if (hi - lo < 2) {
      return { ok: false, warn: null,
        error: 'A game must be won by 2 points (USA Pickleball rules). ' + hi + '–' + lo + ' is not a finished game.' };
    }
    var result = { ok: true, error: null, warn: null };
    if (hi < GAME_TARGET) {
      result.warn = 'Games are normally played to ' + GAME_TARGET + '. Save ' + hi + '–' + lo + ' anyway?';
    }
    return result;
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

  /*
   * One-time repair for sessions that are already running when this fix
   * ships. A player checked in under the old app has gamesCredit but no
   * joinedSeq, so their wait would still read as "since game 0" and they
   * would jump the line once more. Stamp them as joining now: back of their
   * tier once, then they progress normally. Only late joiners ever have a
   * meta entry, so original players are untouched. Returns whether anything
   * changed, so the caller knows to save.
   */
  function normalizeSession(session) {
    if (session.status !== 'active') return false;
    var meta = session.playerMeta || {};
    var changed = false;
    Object.keys(meta).forEach(function (id) {
      if (meta[id] && meta[id].joinedSeq === undefined) {
        meta[id].joinedSeq = session.nextSeq || 1;
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
    waitStart: waitStart,
    setSessionPlayers: setSessionPlayers,
    queueOrder: queueOrder,
    fillCourts: fillCourts,
    checkScore: checkScore,
    migrateSession: migrateSession,
    normalizeSession: normalizeSession,
    computeRatingDeltas: computeRatingDeltas,
    applyDeltas: applyDeltas,
    computeStats: computeStats,
    GAME_TARGET: GAME_TARGET,
    SKILL_LEVELS: ['2.0', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0', '5.5']
  };
})();
