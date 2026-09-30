/* Engine: continuous fair rotation (per-court flow), Elo-style ratings, stats.
   Each court runs independently: as soon as its game is scored, the next game
   starts from the waiting pool. Fairness is longest wait first, measured by
   the clock; team-making maximizes partner/opponent variety and competitive
   balance among players who have waited the same length of time. Two people
   may opt to be fixed partners for the night: they are then one unit in the
   line and always land on the same team. */
(function () {
  'use strict';

  /* USA Pickleball skill scale, 2.0 through 5.5, mapped onto a rating ladder. */
  var SKILL_RATINGS = { '2.0': 900, '2.5': 1000, '3.0': 1100, '3.5': 1250, '4.0': 1400, '4.5': 1550, '5.0': 1700, '5.5': 1850 };
  var ELO_K = 32;

  /* The group plays first to 11, straight up - the game ends the moment a
     side reaches 11, so 11-10 is a result. This is the group's own format,
     chosen deliberately; USA Pickleball rule 12.A is win by 2. */
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
   * Fixed partners for the night. session.pairs holds [idA, idB] pairs; a
   * pair is in effect only while both are checked in. Checking one partner
   * out dissolves the pair (see setSessionPlayers) rather than leaving it to
   * spring back silently if they return. Returns {id: partnerId} both ways.
   */
  function fixedPairs(session) {
    var map = {};
    var ids = session.playerIds || [];
    (session.pairs || []).forEach(function (p) {
      if (!p || p.length !== 2 || p[0] === p[1]) return;
      if (ids.indexOf(p[0]) < 0 || ids.indexOf(p[1]) < 0) return;
      map[p[0]] = p[1];
      map[p[1]] = p[0];
    });
    return map;
  }

  /* Drop any pair this player is in. Returns whether one was removed. */
  function clearPair(session, id) {
    var before = (session.pairs || []).length;
    session.pairs = (session.pairs || []).filter(function (p) { return p[0] !== id && p[1] !== id; });
    return session.pairs.length !== before;
  }

  /* Make two checked-in players a pair. Anyone can be in only one pair, so
     an earlier pair involving either of them is replaced. */
  function setPair(session, a, b) {
    if (!a || !b || a === b) return { ok: false, error: 'Pick two different players.' };
    if (session.playerIds.indexOf(a) < 0 || session.playerIds.indexOf(b) < 0) {
      return { ok: false, error: 'Both players must be checked in to this session.' };
    }
    clearPair(session, a);
    clearPair(session, b);
    session.pairs.push([a, b]);
    return { ok: true, error: null };
  }

  function isFixedTeam(fixed, team) {
    return !!fixed && fixed[team[0]] === team[1];
  }

  /* A split is allowed only if no fixed pair is separated across the net. */
  function honoursPairs(teams, fixed) {
    if (!fixed) return true;
    for (var t = 0; t < 2; t++) {
      var team = teams[t], other = teams[1 - t];
      for (var i = 0; i < team.length; i++) {
        var partner = fixed[team[i]];
        if (partner && other.indexOf(partner) >= 0) return false;
      }
    }
    return true;
  }

  /*
   * Cost of one court's grouping (4 players split into two teams).
   * Heavily penalize repeat partners, moderately penalize repeat opponents,
   * lightly prefer teams with similar combined ratings (competitive games).
   * A fixed pair is meant to repeat, so their partnership is not counted -
   * otherwise every game they play together would make their next court
   * look worse and the engine would start leaving them on the bench.
   */
  function pairingCost(t1, t2, counts, ratingOf, fixed) {
    var cost = 0;
    if (!isFixedTeam(fixed, t1)) cost += (counts.partners[pairKey(t1[0], t1[1])] || 0) * 100;
    if (!isFixedTeam(fixed, t2)) cost += (counts.partners[pairKey(t2[0], t2[1])] || 0) * 100;
    t1.forEach(function (a) {
      t2.forEach(function (b) {
        cost += (counts.opponents[pairKey(a, b)] || 0) * 20;
      });
    });
    var diff = Math.abs((ratingOf(t1[0]) + ratingOf(t1[1])) - (ratingOf(t2[0]) + ratingOf(t2[1])));
    cost += diff * RATING_WEIGHT;
    return cost;
  }

  /* Best of the three ways to split four players into two teams. Splits that
     separate a fixed pair are not options; teams is null if none is allowed
     (cannot happen when pairs are kept as units, but callers check). */
  function bestSplitOfFour(four, counts, ratingOf, fixed) {
    var a = four[0], b = four[1], c = four[2], d = four[3];
    var options = [
      [[a, b], [c, d]],
      [[a, c], [b, d]],
      [[a, d], [b, c]]
    ];
    var best = null, bestCost = Infinity;
    options.forEach(function (opt) {
      if (!honoursPairs(opt, fixed)) return;
      var cost = pairingCost(opt[0], opt[1], counts, ratingOf, fixed);
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
   * after game 6 if it simply runs longer; its players sat down later and
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
   * restarts the clock but keeps any earlier credit. A fixed pair whose
   * member leaves is dissolved; if they come back, pair them again.
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
    if (session.pairs) {
      session.pairs = session.pairs.filter(function (p) {
        return ids.indexOf(p[0]) >= 0 && ids.indexOf(p[1]) >= 0;
      });
    }
  }

  /*
   * The waiting list as units, in the order they are entitled to play:
   * longest wait first, then fewest games. A fixed pair is one unit of two,
   * anyone else a unit of one. A pair has waited only as long as its later
   * member - it cannot play until both are free - and carries the higher
   * game count of the two, so opting in never buys court time at others'
   * expense. A player whose partner is still on court is listed with
   * `waitingFor` set and is not available until the partner sits down.
   *
   * `randomize` breaks exact ties by chance (used when actually picking a
   * game); otherwise roster order keeps the displayed list from shuffling
   * between renders.
   */
  function rankUnits(session, playersById, randomize) {
    var pool = waitingPool(session).filter(function (id) { return playersById[id]; });
    var counts = sessionCounts(session);
    var fixed = fixedPairs(session);
    var inPool = {};
    pool.forEach(function (id) { inPool[id] = true; });
    var order = randomize ? shuffle(pool) : pool;
    var seen = {}, units = [];
    order.forEach(function (id) {
      if (seen[id]) return;
      seen[id] = true;
      var unit = { ids: [id], eff: effectiveGames(session, counts, id), since: waitSince(session, id), waitingFor: null };
      var partner = fixed[id];
      if (partner && inPool[partner]) {
        seen[partner] = true;
        unit.ids.push(partner);
        unit.eff = Math.max(unit.eff, effectiveGames(session, counts, partner));
        unit.since = Math.max(unit.since, waitSince(session, partner));
      } else if (partner) {
        unit.waitingFor = partner;
      }
      units.push(unit);
    });
    units.sort(function (a, b) {
      if (a.since !== b.since) return a.since - b.since;
      return a.eff - b.eff;
    });
    return { units: units, counts: counts };
  }

  function queueUnits(session, playersById) {
    return rankUnits(session, playersById, false).units;
  }

  /* The same list, one player per entry: partners sit side by side and share
     their unit's wait and game count. */
  function queueOrder(session, playersById) {
    var out = [];
    queueUnits(session, playersById).forEach(function (u) {
      u.ids.forEach(function (id) {
        out.push({
          id: id, eff: u.eff, since: u.since,
          pairWith: u.ids.length > 1 ? (u.ids[0] === id ? u.ids[1] : u.ids[0]) : null,
          waitingFor: u.waitingFor
        });
      });
    });
    return out;
  }

  function countIds(units) {
    return units.reduce(function (n, u) { return n + u.ids.length; }, 0);
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

  /* All subsets of a short list of units whose players add up to exactly n.
     Bounded by TIER_WINDOW in normal use, so only a handful are evaluated;
     with n at most 4 it stays small even over a whole tier. */
  function pickCombos(units, n) {
    var out = [];
    (function rec(start, acc, size) {
      if (size === n) { out.push(acc.slice()); return; }
      for (var i = start; i < units.length; i++) {
        var next = size + units[i].ids.length;
        if (next > n) continue;
        acc.push(units[i]);
        rec(i + 1, acc, next);
        acc.pop();
      }
    })(0, [], 0);
    return out;
  }

  /* Is `other` more entitled to play than `chosen` within one tie tier? */
  function outranks(other, chosen) {
    if (other.eff !== chosen.eff) return other.eff < chosen.eff;
    return other.since < chosen.since;
  }

  function byEntitlement(a, b) {
    if (a.eff !== b.eff) return a.eff - b.eff;
    return a.since - b.since;
  }

  /* Best court from the locked units plus a pick from the candidates that
     brings the count to four. Null when no pick fits - an odd number of
     seats with only pairs to fill them. */
  function pickCourt(locked, candidates, counts, ratingOf, fixed) {
    var need = 4 - countIds(locked);
    var best = null, bestCost = Infinity;
    pickCombos(candidates, need).forEach(function (pick) {
      var four = [];
      locked.concat(pick).forEach(function (u) { four = four.concat(u.ids); });
      var split = bestSplitOfFour(four, counts, ratingOf, fixed);
      if (!split.teams) return;
      var cost = split.cost;
      pick.forEach(function (chosen) {
        candidates.forEach(function (other) {
          if (pick.indexOf(other) < 0 && outranks(other, chosen)) cost += LEAPFROG_PENALTY;
        });
      });
      if (cost < bestCost) { bestCost = cost; best = split.teams; }
    });
    return best;
  }

  /*
   * Pick the next 4 players for a free court.
   *
   * Longest wait is the hard constraint. Any unit whose wait began more than
   * TIE_WINDOW_MS before the unit that brings the count to four is locked in
   * and cannot be skipped. Everyone within the window of that unit forms a
   * tie; among them, fewer games goes first, and the engine may look up to
   * TIER_WINDOW units past that to avoid a clearly worse court, paying
   * LEAPFROG_PENALTY for each unit it passes over.
   *
   * Fixed pairs can make that impossible: three locked singles and only
   * pairs waiting leaves one seat that no unit fits. Rather than leave the
   * court empty, the locked unit with the weakest claim (most games, then
   * shortest wait) gives way and becomes an ordinary candidate; it is still
   * first in line for the next court.
   */
  function nextGame(session, playersById) {
    var ranked = rankUnits(session, playersById, true);
    var counts = ranked.counts;
    var units = ranked.units.filter(function (u) { return !u.waitingFor; });
    if (countIds(units) < 4) return null;
    var fixed = fixedPairs(session);

    function ratingOf(id) {
      return (playersById[id] && playersById[id].rating) || 1250;
    }

    var pivot = 0, seen = 0;
    for (var i = 0; i < units.length; i++) {
      seen += units[i].ids.length;
      if (seen >= 4) { pivot = units[i].since; break; }
    }
    var locked = [], tier = [];
    units.forEach(function (u) {
      if (u.since < pivot - TIE_WINDOW_MS) locked.push(u);
      else if (u.since <= pivot + TIE_WINDOW_MS) tier.push(u);
    });

    for (;;) {
      tier.sort(byEntitlement);
      var need = 4 - countIds(locked);
      var covered = 0, k = tier.length;
      for (var j = 0; j < tier.length; j++) {
        covered += tier[j].ids.length;
        if (covered >= need) { k = j + 1; break; }
      }
      var candidates = tier.slice(0, k + TIER_WINDOW);
      var teams = pickCourt(locked, candidates, counts, ratingOf, fixed) ||
        pickCourt(locked, tier, counts, ratingOf, fixed);
      if (teams) return { teamA: teams[0], teamB: teams[1] };
      // With nobody locked the tier holds four or more players, and any four
      // or more players can always be seated - so this loop always ends.
      if (!locked.length) return null;
      locked.sort(byEntitlement);
      tier.push(locked.pop());
    }
  }

  /*
   * Validate a final score for first-to-11, straight up. The winner always
   * has exactly 11 and the loser anything from 0 to 10. Under 11 the game is
   * not finished; over 11 is not possible, because it ended at 11. Both are
   * refused with a reason, which also catches the common mis-tap.
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
    if (hi > GAME_TARGET) {
      return { ok: false,
        error: 'The game ends at ' + GAME_TARGET + ', so ' + hi + '–' + lo + ' is not possible. Check the scores.' };
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

  /*
   * Standings. Two lists: the board, and special mentions.
   *
   * Ranking by win percentage let a 1-0 night sit above a 7-1 one. The
   * board is now ranked by WINS - then win rate, then point difference, then
   * games - so playing more and winning more is what climbs it. To rank at
   * all a player needs at least half as many games as the busiest player;
   * anyone under that is listed under special mentions with their record,
   * so a 3-0 late arrival is celebrated rather than either crowned or
   * dropped. Ties fall through to name so screen and PDF agree exactly.
   *
   * Notes are deterministic and ASCII only - the PDF writer cannot print
   * anything outside Latin-1.
   */
  function boardNote(r, index, maxGames) {
    if (index === 0) return 'Top of the board - the most wins on the night.';
    if (index === 1) return 'Runner-up. One more win and it is yours.';
    if (index === 2) return 'Podium finish. Well played.';
    if (r.losses === 0) return 'Unbeaten. Nobody found a way through.';
    // Winless comes before the volume compliment: an 0-8 night should get the
    // honest, encouraging line, not be told they played the most.
    if (r.wins === 0) return 'Tough night on the scoreline - showing up is how it turns. See you Thursday.';
    if (r.games === maxGames) return 'Most games played. Every court needs someone like that.';
    if (r.pct >= 0.6) return 'Winning more than you lose. Keep it rolling.';
    if (r.pct >= 0.4) return 'Right in the mix - a point here or there decides these.';
    return 'Wins on the board. Every game sharpens the next one.';
  }

  function mentionNote(r) {
    var rec = r.wins + '-' + r.losses + ' in ' + r.games + (r.games === 1 ? ' game' : ' games');
    if (r.losses === 0) return 'Unbeaten, ' + rec + '. A few more games and the podium is yours to take.';
    if (r.pct >= 0.5) return rec + '. Good numbers - play more and they count for the board.';
    return rec + '. Come back for more games and a run at the board.';
  }

  function rankStandings(stats, playersById, restrictIds) {
    var ids = restrictIds || Object.keys(stats);
    var rows = ids.filter(function (id) {
      return stats[id] && playersById[id] && stats[id].games > 0;
    }).map(function (id) {
      var s = stats[id];
      return {
        id: id, name: playersById[id].name, rating: playersById[id].rating,
        games: s.games, wins: s.wins, losses: s.losses,
        pct: s.wins / s.games, diff: s.pf - s.pa, rank: 0, note: ''
      };
    });

    var maxGames = rows.reduce(function (m, r) { return Math.max(m, r.games); }, 0);
    var minGames = Math.max(1, Math.ceil(maxGames / 2));

    var ranked = rows.filter(function (r) { return r.games >= minGames; });
    ranked.sort(function (a, b) {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.pct !== a.pct) return b.pct - a.pct;
      if (b.diff !== a.diff) return b.diff - a.diff;
      if (b.games !== a.games) return b.games - a.games;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    ranked.forEach(function (r, i) { r.rank = i + 1; r.note = boardNote(r, i, maxGames); });

    var mentions = rows.filter(function (r) { return r.games < minGames; });
    mentions.sort(function (a, b) {
      if (b.pct !== a.pct) return b.pct - a.pct;
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.diff !== a.diff) return b.diff - a.diff;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    mentions.forEach(function (r) { r.note = mentionNote(r); });

    return { ranked: ranked, mentions: mentions, minGames: minGames, maxGames: maxGames };
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
    fixedPairs: fixedPairs,
    setPair: setPair,
    clearPair: clearPair,
    queueUnits: queueUnits,
    queueOrder: queueOrder,
    fillCourts: fillCourts,
    checkScore: checkScore,
    migrateSession: migrateSession,
    normalizeSession: normalizeSession,
    computeRatingDeltas: computeRatingDeltas,
    applyDeltas: applyDeltas,
    computeStats: computeStats,
    sessionParticipants: sessionParticipants,
    rankStandings: rankStandings,
    GAME_TARGET: GAME_TARGET,
    TIE_WINDOW_MS: TIE_WINDOW_MS,
    SKILL_LEVELS: ['2.0', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0', '5.5']
  };
})();
