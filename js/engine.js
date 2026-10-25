/* Engine: continuous fair rotation (per-court flow), Elo-style ratings, stats.
   Each court runs independently: as soon as its game is scored, the next game
   starts from the waiting pool. Fairness is longest wait first, measured by
   the clock; team-making maximizes partner/opponent variety and competitive
   balance among players who have waited the same length of time. Two people
   may opt to be fixed partners for the night: they are then one unit in the
   line and always land on the same team. A session may also match by skill:
   courts are then built around the longest wait from the players closest to
   them in rating. A tournament goes further: every game is played within
   one division, the group's skill categories, and divisions never mix. The
   host may allow fixed partners of different levels; such a pair then plays
   in the higher partner's division. The other tournament format is two
   groups: every game is two players from one group against two from the
   other, and the groups' wins are the score. Every game carries a clock, so
   a player's average time on court can be reported. */
(function () {
  'use strict';

  /* USA Pickleball skill scale, 1.0 through 5.5, mapped onto a rating ladder. */
  var SKILL_RATINGS = {
    '1.0': 700, '1.5': 800, '2.0': 900, '2.5': 1000, '3.0': 1100,
    '3.5': 1250, '4.0': 1400, '4.5': 1550, '5.0': 1700, '5.5': 1850
  };
  var SKILL_LEVELS = ['1.0', '1.5', '2.0', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0', '5.5'];
  var ELO_K = 32;

  /* The group's names for spans of the scale, lowest first. */
  var SKILL_CATEGORIES = [
    { name: 'Beginner', from: '1.0', to: '2.5' },
    { name: 'Novice', from: '3.0', to: '3.5' },
    { name: 'Intermediate', from: '4.0', to: '4.5' },
    { name: 'Expert', from: '5.0', to: '5.5' }
  ];

  /* Category name for a skill level, or '' for anything off the scale. */
  function skillCategory(skill) {
    var v = parseFloat(skill);
    for (var i = 0; i < SKILL_CATEGORIES.length; i++) {
      var c = SKILL_CATEGORIES[i];
      if (v >= parseFloat(c.from) && v <= parseFloat(c.to)) return c.name;
    }
    return '';
  }

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

  /*
   * Match by skill is a per-session option, off unless the organiser turns
   * it on. With it on, a court is built around whoever has waited longest -
   * they always play next - and the other seats go to the waiting players
   * closest to them in rating, so each game is between people of about the
   * same level. Anyone passed over is charged once (not once per seat):
   * LEAPFROG_PENALTY, plus SKILL_WAIT_PENALTY for every minute they have
   * waited longer than the player taken instead. So a long wait keeps its
   * weight: half a level is not reason enough to skip someone who has sat
   * about five minutes longer, a full level is not enough beyond about a
   * quarter of an hour, and once they have waited longest nobody can skip
   * them at all. SKILL_SPREAD_WEIGHT is the cost per rating point between
   * the strongest and weakest player on the court; half a level is 100 to
   * 150 points.
   */
  var SKILL_SPREAD_WEIGHT = 1;
  var SKILL_WAIT_PENALTY = 20;

  function matchBySkill(session) {
    return !!session.matchBySkill;
  }

  /*
   * Tournament mode is a per-session option for the nights the group runs
   * a tournament. Every game is then played within one division - the
   * group's skill categories, by declared level - so a Beginner only ever
   * shares a court with Beginners, a Novice with Novices, and so on. Any
   * court can host any division; which one is decided game by game. Within
   * a division the usual rules apply: longest wait first, then fewest
   * games, with the same variety and balance in team-making.
   *
   * Between divisions, a free court goes to the division of whoever has
   * waited longest, provided four of them are ready. A division with fewer
   * than four ready cannot fill a court and is passed over for the next
   * longest wait in another division - never topped up from one.
   */
  function tournament(session) {
    return !!session.tournament;
  }

  /*
   * Mixed pairs is a per-tournament option, off unless the host turns it
   * on. Off, fixed partners must be in the same division, as a tournament
   * always required. On, two players of different levels may pair up; the
   * pair then plays in the higher partner's division - the usual tournament
   * rule, so nobody plays down - and courts are still never mixed beyond
   * that: every other seat on the court is that division's.
   */
  function mixedPairs(session) {
    return !!session.mixedPairs;
  }

  /*
   * Two groups is the other tournament format: Group A against Group B,
   * for a company or club night. Every game is two players from one group
   * against two from the other, so nobody ever partners or faces their own
   * group, and the groups' wins are the score. session.groups holds the two
   * names and each player's group: { names: ['Group A', 'Group B'],
   * of: { playerId: 0 | 1 } }. Without it a tournament is by division, as
   * before. Team A on every court is the first group and team B the second,
   * so a game's score is also a group's score. Within a group the usual
   * rules apply: longest wait first, then fewest games, with the same
   * variety and balance in choosing the court.
   */
  function groupPlay(session) {
    return tournament(session) && !!(session.groups && session.groups.of);
  }

  /* A player's group, 0 or 1, or -1 when they have none. A player who has
     left keeps theirs, so their results stay with their group. */
  function playerGroup(session, id) {
    var g = session.groups && session.groups.of ? session.groups.of[id] : undefined;
    return g === 0 || g === 1 ? g : -1;
  }

  function groupLabel(session, g) {
    var names = (session.groups && session.groups.names) || [];
    return names[g] || ('Group ' + (g === 1 ? 'B' : 'A'));
  }

  /* A unit's group: the one its members share, or -1 when a member has
     none or a fixed pair straddles the two. Such a unit is never seated. */
  function unitGroup(session, unit) {
    var g = playerGroup(session, unit.ids[0]);
    for (var i = 1; i < unit.ids.length; i++) {
      if (playerGroup(session, unit.ids[i]) !== g) return -1;
    }
    return g;
  }

  /* The division a player plays in: the category of their declared level.
     '' for a level off the scale; such players form a division of their own. */
  function playerCategory(playersById, id) {
    var p = playersById[id];
    return p ? skillCategory(p.skill) : '';
  }

  /* The name a division is shown under. */
  function divisionLabel(category) {
    return category || 'Unrated';
  }

  /* Where a category sits on the scale; the unrated group is below it. */
  function categoryRank(category) {
    for (var i = 0; i < SKILL_CATEGORIES.length; i++) {
      if (SKILL_CATEGORIES[i].name === category) return i + 1;
    }
    return 0;
  }

  function higherCategory(a, b) {
    return categoryRank(b) > categoryRank(a) ? b : a;
  }

  /* A unit's division. Members in different divisions - a fixed pair of
     different levels - make it the higher one when the session allows mixed
     pairs, and null otherwise: such a unit is never seated. Without the
     session, as before this option, a mixed unit is null. */
  function unitCategory(unit, playersById, session) {
    var cat = playerCategory(playersById, unit.ids[0]);
    var mixed = false, highest = cat;
    for (var i = 1; i < unit.ids.length; i++) {
      var other = playerCategory(playersById, unit.ids[i]);
      if (other !== cat) mixed = true;
      highest = higherCategory(highest, other);
    }
    if (!mixed) return cat;
    return session && mixedPairs(session) ? highest : null;
  }

  /* The division a player plays in: their fixed pair's, when they have a
     partner and the pair can be seated, otherwise their own level's. */
  function playerDivision(session, playersById, id) {
    var partner = fixedPairs(session)[id];
    if (partner) {
      var cat = unitCategory({ ids: [id, partner] }, playersById, session);
      if (cat !== null) return cat;
    }
    return playerCategory(playersById, id);
  }

  function initialRating(skill) {
    return SKILL_RATINGS[skill] || 1250;
  }

  /*
   * Names pasted one per line, for adding a whole group at once. A line
   * may end with a level ("Ann 3.5" or "Ann, 3.5"); otherwise the default
   * applies. Blank lines are skipped, names are trimmed, spaced singly
   * and cut to 30 characters, and a name repeated in the text is kept
   * once, whatever its case.
   */
  function parseRoster(text, defaultSkill) {
    var out = [], seen = {};
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var s = line.trim();
      if (!s) return;
      var skill = defaultSkill;
      var m = s.match(/^(.*?)[\s,;:-]+(\d\.\d)$/);
      if (m && SKILL_LEVELS.indexOf(m[2]) >= 0 && m[1].trim()) { s = m[1].trim(); skill = m[2]; }
      s = s.replace(/\s+/g, ' ').slice(0, 30);
      var key = s.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push({ name: s, skill: skill });
    });
    return out;
  }

  /* The level whose starting rating is nearest to `rating`; a tie goes to
     the lower level. */
  function suggestedSkill(rating) {
    var best = SKILL_LEVELS[0], bestGap = Infinity;
    SKILL_LEVELS.forEach(function (s) {
      var gap = Math.abs(SKILL_RATINGS[s] - rating);
      if (gap < bestGap) { bestGap = gap; best = s; }
    });
    return best;
  }

  /* How far a player's rating has drifted from the level they are listed
     at, in steps on the scale - positive means playing above it. Null for
     a level off the scale. */
  function levelDrift(player) {
    var from = SKILL_LEVELS.indexOf(player.skill);
    if (from < 0) return null;
    var suggested = suggestedSkill(player.rating);
    return { suggested: suggested, steps: SKILL_LEVELS.indexOf(suggested) - from };
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
     an earlier pair involving either of them is replaced. In a tournament,
     given the players, both must be in the same division unless the host
     allows mixed pairs; in a two-group tournament, in the same group. */
  function setPair(session, a, b, playersById) {
    if (!a || !b || a === b) return { ok: false, error: 'Pick two different players.' };
    if (session.playerIds.indexOf(a) < 0 || session.playerIds.indexOf(b) < 0) {
      return { ok: false, error: 'Both players must be checked in to this session.' };
    }
    if (groupPlay(session)) {
      if (playerGroup(session, a) !== playerGroup(session, b)) {
        return { ok: false, error: 'In a group tournament, partners must be in the same group.' };
      }
    } else if (tournament(session) && !mixedPairs(session) && playersById &&
        playerCategory(playersById, a) !== playerCategory(playersById, b)) {
      return { ok: false, error: 'In a tournament, partners must be in the same division.' };
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
   * Take back the last score saved, for the moment the host sees it went
   * on the wrong court. The game goes back in progress with no score, and
   * the games its finish started (`startedIds`) are withdrawn - but only
   * while every one of them is still unscored and nobody from the game
   * has been put on another court since; otherwise the score stands and
   * the numbers are for Edit. Returns ok, or the reason, plus the game
   * and how many games were withdrawn.
   */
  function undoScore(session, gameId, startedIds) {
    var game = null;
    (session.games || []).forEach(function (g) { if (g.id === gameId) game = g; });
    if (!game || !game.done) return { ok: false, error: 'That score is no longer there to take back.' };
    var started = (session.games || []).filter(function (g) { return startedIds.indexOf(g.id) >= 0; });
    if (started.some(function (g) { return g.done; })) {
      return { ok: false, error: 'A game that followed has been scored, so this one stands. Use Edit to change the numbers.' };
    }
    var four = game.teamA.concat(game.teamB);
    var clash = activeGames(session).some(function (g) {
      return startedIds.indexOf(g.id) < 0 && g.teamA.concat(g.teamB).some(function (id) { return four.indexOf(id) >= 0; });
    });
    if (clash) {
      return { ok: false, error: 'Someone from that game is already on another court, so it stands. Use Edit to change the numbers.' };
    }
    session.games = session.games.filter(function (g) { return startedIds.indexOf(g.id) < 0; });
    game.scoreA = null;
    game.scoreB = null;
    game.done = false;
    game.finishedAt = null;
    return { ok: true, error: null, game: game, withdrawn: started.length };
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

  /* Rating gap between the strongest and weakest of the four. */
  function courtSpread(four, ratingOf) {
    var lo = Infinity, hi = -Infinity;
    four.forEach(function (id) {
      var r = ratingOf(id);
      if (r < lo) lo = r;
      if (r > hi) hi = r;
    });
    return hi - lo;
  }

  /* Cost of seating `chosen` while `other` keeps waiting, when matching by
     skill. Waits within the tie window count as equal and fall to the usual
     entitlement; beyond it, every minute `other` has waited longer adds up. */
  function skillLeapfrogCost(other, chosen) {
    var gap = chosen.since - other.since;
    if (gap > TIE_WINDOW_MS) return LEAPFROG_PENALTY + SKILL_WAIT_PENALTY * gap / 60000;
    if (gap < -TIE_WINDOW_MS) return 0;
    return outranks(other, chosen) ? LEAPFROG_PENALTY : 0;
  }

  /* Best court from the locked units plus a pick from the candidates that
     brings the count to four. Null when no pick fits - an odd number of
     seats with only pairs to fill them. */
  function pickCourt(locked, candidates, counts, ratingOf, fixed, skill) {
    var need = 4 - countIds(locked);
    var best = null, bestCost = Infinity;
    pickCombos(candidates, need).forEach(function (pick) {
      var four = [];
      locked.concat(pick).forEach(function (u) { four = four.concat(u.ids); });
      var split = bestSplitOfFour(four, counts, ratingOf, fixed);
      if (!split.teams) return;
      var cost = split.cost;
      if (skill) {
        // A unit passed over is charged once, by its strongest grievance.
        cost += courtSpread(four, ratingOf) * SKILL_SPREAD_WEIGHT;
        candidates.forEach(function (other) {
          if (pick.indexOf(other) >= 0) return;
          var worst = 0;
          pick.forEach(function (chosen) { worst = Math.max(worst, skillLeapfrogCost(other, chosen)); });
          cost += worst;
        });
      } else {
        pick.forEach(function (chosen) {
          candidates.forEach(function (other) {
            if (pick.indexOf(other) < 0 && outranks(other, chosen)) cost += LEAPFROG_PENALTY;
          });
        });
      }
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
   *
   * Matching by skill keeps one hard claim instead of a locked tier: the
   * unit that has waited longest (fewest games within the tie window) always
   * plays, and every other waiting unit is a candidate for the remaining
   * seats, weighed by rating fit against how much longer they have waited.
   *
   * A tournament runs the same pick, but over one division at a time: the
   * division of the longest wait first, then the next, until one of them
   * has four ready. The game is tagged with its division. A two-group
   * tournament instead takes two from each group's line (pickGroupGame).
   */
  function nextGame(session, playersById, randomize) {
    var ranked = rankUnits(session, playersById, randomize !== false);
    var counts = ranked.counts;
    var units = ranked.units.filter(function (u) { return !u.waitingFor; });
    if (countIds(units) < 4) return null;
    var fixed = fixedPairs(session);
    var skill = matchBySkill(session);

    function ratingOf(id) {
      return (playersById[id] && playersById[id].rating) || 1250;
    }

    if (!tournament(session)) return pickNext(units, counts, fixed, skill, ratingOf);
    if (groupPlay(session)) return pickGroupGame(units, counts, fixed, ratingOf, session);

    // The units are already in queue order, so the first seen from each
    // division is that division's claim on the court. A mixed pair, where
    // allowed, is in the higher partner's division.
    var byCat = {}, order = [];
    units.forEach(function (u) {
      var cat = unitCategory(u, playersById, session);
      if (cat === null) return;
      if (!byCat[cat]) { byCat[cat] = []; order.push(cat); }
      byCat[cat].push(u);
    });
    for (var d = 0; d < order.length; d++) {
      var division = byCat[order[d]];
      if (countIds(division) < 4) continue;
      var game = pickNext(division, counts, fixed, skill, ratingOf);
      if (game) { game.category = order[d]; return game; }
    }
    return null;
  }

  /*
   * Who would go on if a court opened this moment: the same pick as
   * fillCourts makes, but with exact ties settled by roster order instead
   * of by chance, so the answer holds still between redraws. On an exact
   * tie the real pick may differ; otherwise it is this one. Null when no
   * court could be filled.
   */
  function previewNext(session, playersById) {
    return nextGame(session, playersById, false);
  }

  /* The pick itself, over units already in queue order with four or more
     players among them. */
  function pickNext(units, counts, fixed, skill, ratingOf) {
    var locked = [], tier = [];
    if (skill) {
      var head = units[0];
      units.forEach(function (u) {
        if (u.since <= units[0].since + TIE_WINDOW_MS && outranks(u, head)) head = u;
      });
      locked.push(head);
      tier = units.filter(function (u) { return u !== head; });
    } else {
      var pivot = 0, seen = 0;
      for (var i = 0; i < units.length; i++) {
        seen += units[i].ids.length;
        if (seen >= 4) { pivot = units[i].since; break; }
      }
      units.forEach(function (u) {
        if (u.since < pivot - TIE_WINDOW_MS) locked.push(u);
        else if (u.since <= pivot + TIE_WINDOW_MS) tier.push(u);
      });
    }

    for (;;) {
      tier.sort(byEntitlement);
      var need = 4 - countIds(locked);
      var covered = 0, k = tier.length;
      for (var j = 0; j < tier.length; j++) {
        covered += tier[j].ids.length;
        if (covered >= need) { k = j + 1; break; }
      }
      var candidates = skill ? tier : tier.slice(0, k + TIER_WINDOW);
      var teams = pickCourt(locked, candidates, counts, ratingOf, fixed, skill);
      if (!teams && candidates.length < tier.length) teams = pickCourt(locked, tier, counts, ratingOf, fixed, skill);
      if (teams) return { teamA: teams[0], teamB: teams[1] };
      // With nobody locked the tier holds four or more players, and any four
      // or more players can always be seated - so this loop always ends.
      if (!locked.length) return null;
      locked.sort(byEntitlement);
      tier.push(locked.pop());
    }
  }

  /*
   * The pick for two groups. Each side comes from its own group's line:
   * longest wait first, then fewest games, with the same tie window, lock
   * and look-ahead as a regular court, but for two seats instead of four.
   * The two sides are then chosen together - the court with the fewest
   * repeat partners and opponents and the closest team ratings, each unit
   * passed over on its side costing LEAPFROG_PENALTY as usual. Team A is
   * always the first group. Null when either group has fewer than two
   * ready; a court is never filled from one group alone.
   */
  function pickGroupGame(units, counts, fixed, ratingOf, session) {
    var lines = [[], []];
    units.forEach(function (u) {
      var g = unitGroup(session, u);
      if (g >= 0) lines[g].push(u);
    });
    if (countIds(lines[0]) < 2 || countIds(lines[1]) < 2) return null;
    var sidesA = sideOptions(lines[0]), sidesB = sideOptions(lines[1]);
    var best = null, bestCost = Infinity;
    sidesA.forEach(function (a) {
      sidesB.forEach(function (b) {
        var cost = pairingCost(a.ids, b.ids, counts, ratingOf, fixed) + a.penalty + b.penalty;
        if (cost < bestCost) { bestCost = cost; best = { teamA: a.ids, teamB: b.ids, groups: [0, 1] }; }
      });
    });
    return best;
  }

  /* The ways to fill one side of a group court from its line, in queue
     order: every pick of two that the lock and look-ahead allow, each with
     the leapfrog cost of the units it passes over. Empty only if the line
     cannot seat two, which the caller has ruled out. */
  function sideOptions(units) {
    var locked = [], tier = [];
    var pivot = 0, seen = 0;
    for (var i = 0; i < units.length; i++) {
      seen += units[i].ids.length;
      if (seen >= 2) { pivot = units[i].since; break; }
    }
    units.forEach(function (u) {
      if (u.since < pivot - TIE_WINDOW_MS) locked.push(u);
      else if (u.since <= pivot + TIE_WINDOW_MS) tier.push(u);
    });
    for (;;) {
      tier.sort(byEntitlement);
      var need = 2 - countIds(locked);
      var covered = 0, k = tier.length;
      for (var j = 0; j < tier.length; j++) {
        covered += tier[j].ids.length;
        if (covered >= need) { k = j + 1; break; }
      }
      var options = sideCombos(locked, tier.slice(0, k + TIER_WINDOW), need);
      if (!options.length && k + TIER_WINDOW < tier.length) options = sideCombos(locked, tier, need);
      if (options.length) return options;
      // A locked single with only pairs behind them: the single gives way
      // for this court and stays first in line for the next, as on a
      // regular court.
      if (!locked.length) return [];
      locked.sort(byEntitlement);
      tier.push(locked.pop());
    }
  }

  function sideCombos(locked, candidates, need) {
    var base = [];
    locked.forEach(function (u) { base = base.concat(u.ids); });
    return pickCombos(candidates, need).map(function (pick) {
      var ids = base.slice(), penalty = 0;
      pick.forEach(function (u) { ids = ids.concat(u.ids); });
      pick.forEach(function (chosen) {
        candidates.forEach(function (other) {
          if (pick.indexOf(other) < 0 && outranks(other, chosen)) penalty += LEAPFROG_PENALTY;
        });
      });
      return { ids: ids, penalty: penalty };
    });
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
        startedAt: Date.now(),
        teamA: next.teamA,
        teamB: next.teamB,
        scoreA: null,
        scoreB: null,
        done: false,
        finishedAt: null,
        ratingDeltas: null
      };
      // A tournament game carries its division, so the record keeps it
      // even if a level is edited later.
      if (next.category !== undefined) game.category = next.category;
      // A two-group game records which group each team is.
      if (next.groups) game.groups = next.groups;
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

  /* Take rating deltas back for a score that should not have been saved:
     the rating, and the history point it left. */
  function undoDeltas(deltas, playersById) {
    Object.keys(deltas).forEach(function (id) {
      var p = playersById[id];
      if (!p) return;
      var h = p.ratingHistory || [];
      if (h.length && h[h.length - 1].r === p.rating) h.pop();
      p.rating -= deltas[id];
    });
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

  /*
   * Start over for a new season: every session is deleted and each player
   * goes back to the rating their skill level starts at, with no history.
   * Names, levels and archived flags are kept. Returns what was cleared so
   * the caller can say so.
   */
  function resetProgress(data) {
    var sessions = (data.sessions || []).length;
    data.sessions = [];
    (data.players || []).forEach(function (p) {
      p.rating = initialRating(p.skill);
      p.ratingHistory = [];
    });
    return { sessions: sessions, players: (data.players || []).length };
  }

  /*
   * A player's night-by-night record, oldest first, with their rating at
   * the end of each session. Worked back from the current rating through
   * the deltas recorded on each scored game, so it is exact whatever the
   * clock said; `start` is the rating before their first recorded game.
   */
  function playerProgression(player, sessions) {
    var rows = [];
    var rating = player.rating;
    for (var i = sessions.length - 1; i >= 0; i--) {
      var s = sessions[i];
      var st = computeStats([s])[player.id];
      if (!st) continue;
      var change = 0;
      sessionMatches(s).forEach(function (m) {
        if (m.done && m.ratingDeltas && m.ratingDeltas[player.id]) change += m.ratingDeltas[player.id];
      });
      rows.push({
        id: s.id, startedAt: s.startedAt, active: s.status === 'active',
        games: st.games, wins: st.wins, losses: st.losses, diff: st.pf - st.pa,
        ratingAfter: rating, ratingChange: change
      });
      rating -= change;
    }
    rows.reverse();
    return { rows: rows, start: rating };
  }

  /*
   * Game clocks. Every game started since this shipped carries startedAt;
   * with finishedAt that is its length. Games from before have no clock
   * and are simply left out of the averages.
   */
  function gameDuration(m) {
    if (!m.startedAt || !m.finishedAt || m.finishedAt < m.startedAt) return null;
    return m.finishedAt - m.startedAt;
  }

  /* Each player's time on court this session - timed games, total and
     average, in ms - over the scored games that have a clock. */
  function playTimes(session) {
    var out = {};
    sessionMatches(session).forEach(function (m) {
      if (!m.done) return;
      var d = gameDuration(m);
      if (d === null) return;
      m.teamA.concat(m.teamB).forEach(function (id) {
        var t = out[id] || (out[id] = { games: 0, total: 0, avg: 0 });
        t.games++;
        t.total += d;
        t.avg = Math.round(t.total / t.games);
      });
    });
    return out;
  }

  /* "13m 20s", "45s", "1h 02m" - ASCII, so it can go in a PDF note. */
  function fmtDuration(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (h) return h + 'h ' + (m < 10 ? '0' : '') + m + 'm';
    if (m) return m + 'm ' + (sec < 10 ? '0' : '') + sec + 's';
    return sec + 's';
  }

  /*
   * The night in numbers: the scored games, and over those with a clock
   * the average and the longest; the closest and the biggest result; and
   * the climber of the night, whose rating rose most over the session.
   * Each game field is the game itself, or null when there is none.
   */
  function sessionSummary(session) {
    var done = sessionMatches(session).filter(function (m) { return m.done; });
    var out = { games: done.length, timed: 0, avg: null, longest: null, longestMs: null, closest: null, biggest: null, climber: null };
    var total = 0, gains = {};
    done.forEach(function (m) {
      var d = gameDuration(m);
      if (d !== null) {
        out.timed++;
        total += d;
        if (out.longestMs === null || d > out.longestMs) { out.longestMs = d; out.longest = m; }
      }
      var margin = Math.abs(m.scoreA - m.scoreB);
      if (!out.closest || margin < Math.abs(out.closest.scoreA - out.closest.scoreB)) out.closest = m;
      if (!out.biggest || margin > Math.abs(out.biggest.scoreA - out.biggest.scoreB)) out.biggest = m;
      Object.keys(m.ratingDeltas || {}).forEach(function (id) { gains[id] = (gains[id] || 0) + m.ratingDeltas[id]; });
    });
    if (out.timed) out.avg = Math.round(total / out.timed);
    // Ties go to the first id, so the answer is the same every time.
    Object.keys(gains).sort().forEach(function (id) {
      if (gains[id] > 0 && (!out.climber || gains[id] > out.climber.change)) out.climber = { id: id, change: gains[id] };
    });
    return out;
  }

  /*
   * A player's form: their last `n` results, oldest first, 'W' or 'L'.
   * Sessions in order, and within one by finish time, then sequence.
   */
  function playerForm(playerId, sessions, n) {
    var results = [];
    sessions.forEach(function (session) {
      var mine = sessionMatches(session).filter(function (m) {
        return m.done && (m.teamA.indexOf(playerId) >= 0 || m.teamB.indexOf(playerId) >= 0);
      });
      mine.sort(function (a, b) { return ((a.finishedAt || 0) - (b.finishedAt || 0)) || ((a.seq || 0) - (b.seq || 0)); });
      mine.forEach(function (m) {
        var onA = m.teamA.indexOf(playerId) >= 0;
        results.push((onA ? m.scoreA > m.scoreB : m.scoreB > m.scoreA) ? 'W' : 'L');
      });
    });
    return results.slice(-n);
  }

  /*
   * Who a player has shared a court with over the given sessions: every
   * partner and every opponent, with the games and the record from the
   * player's side. Most games first, then most wins, then by id, so the
   * order is stable between renders.
   */
  function playerCompanions(playerId, sessions) {
    var partners = {}, opponents = {};
    function tally(map, id, won) {
      var t = map[id] || (map[id] = { id: id, games: 0, wins: 0, losses: 0 });
      t.games++;
      if (won) t.wins++; else t.losses++;
    }
    sessions.forEach(function (session) {
      sessionMatches(session).forEach(function (m) {
        if (!m.done) return;
        var onA = m.teamA.indexOf(playerId) >= 0, onB = m.teamB.indexOf(playerId) >= 0;
        if (!onA && !onB) return;
        var mine = onA ? m.teamA : m.teamB, theirs = onA ? m.teamB : m.teamA;
        var won = onA ? m.scoreA > m.scoreB : m.scoreB > m.scoreA;
        mine.forEach(function (id) { if (id !== playerId) tally(partners, id, won); });
        theirs.forEach(function (id) { tally(opponents, id, won); });
      });
    });
    function sorted(map) {
      return Object.keys(map).map(function (id) { return map[id]; }).sort(function (a, b) {
        if (b.games !== a.games) return b.games - a.games;
        if (b.wins !== a.wins) return b.wins - a.wins;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    }
    return { partners: sorted(partners), opponents: sorted(opponents) };
  }

  /*
   * A plain-text recap of a session for the group chat: the night in
   * numbers and the standings exactly as the app ranks them - one board,
   * or one per division, or the group score and one per group. `dateText`
   * is the date as the caller formats it. Plain characters only, apart
   * from names, so it pastes anywhere.
   */
  function sessionRecap(session, playersById, dateText) {
    var name = function (id) { return playersById[id] ? playersById[id].name : '?'; };
    var team = function (ids) { return ids.map(name).join(' & '); };
    var result = function (m) { return team(m.teamA) + ' ' + m.scoreA + '-' + m.scoreB + ' ' + team(m.teamB); };
    var plural = function (n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); };
    var sum = sessionSummary(session);
    var lines = ['ThursDink - ' + dateText + (session.tournament ? ' - tournament' : '')];
    lines.push(plural(sessionParticipants(session).length, 'player') + ', ' + plural(sum.games, 'game') + ', ' +
      plural(session.courtCount || 0, 'court'));
    if (sum.timed) lines.push('Average game ' + fmtDuration(sum.avg) + '; longest ' + fmtDuration(sum.longestMs) + ': ' + result(sum.longest));
    if (sum.closest) lines.push('Closest game: ' + result(sum.closest));
    if (sum.biggest && sum.biggest !== sum.closest) lines.push('Biggest win: ' + result(sum.biggest));
    if (sum.climber) lines.push('Climber of the night: ' + name(sum.climber.id) + ' (+' + sum.climber.change + ')');

    var stats = computeStats([session]);
    function board(title, ids) {
      var b = rankStandings(stats, playersById, ids);
      if (!b.ranked.length && !b.mentions.length) return;
      lines.push('', title);
      b.ranked.forEach(function (r) {
        lines.push(r.rank + '. ' + r.name + ' ' + r.wins + '-' + r.losses + ' (' + Math.round(r.pct * 100) + '%, ' +
          (r.diff > 0 ? '+' : '') + r.diff + ')');
      });
      if (b.mentions.length) {
        lines.push('Special mentions: ' + b.mentions.map(function (r) {
          return r.name + ' ' + r.wins + '-' + r.losses + ' in ' + plural(r.games, 'game');
        }).join(', '));
      }
    }
    if (groupPlay(session)) {
      var score = groupScore(session);
      lines.push('', groupLabel(session, 0) + ' ' + score.wins[0] + ' - ' + score.wins[1] + ' ' + groupLabel(session, 1) +
        ' (games won; points ' + score.points[0] + '-' + score.points[1] + ')');
      tournamentGroups(session).forEach(function (g) { board(g.label, g.ids); });
    } else if (tournament(session)) {
      tournamentDivisions(session, playersById).forEach(function (d) { board(d.label, d.ids); });
    } else {
      board('Standings', null);
    }
    if ((session.pairs || []).length) {
      lines.push('', 'Fixed partners: ' + session.pairs.map(function (p) { return name(p[0]) + ' & ' + name(p[1]); }).join(', '));
    }
    return lines.join('\n');
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
   * A tournament's divisions in scale order, each with everyone who is or
   * was part of it. A player's division is the one of the last game they
   * played, so a level edited after the night does not move their results;
   * until they have played it is their current level - or their pair's,
   * for a partner of a different level who is allowed to play up.
   */
  function tournamentDivisions(session, playersById) {
    var of = {};
    sessionParticipants(session).forEach(function (id) { of[id] = playerDivision(session, playersById, id); });
    sessionMatches(session).forEach(function (m) {
      if (!m.done || m.category === undefined) return;
      m.teamA.concat(m.teamB).forEach(function (id) { of[id] = m.category; });
    });
    var names = SKILL_CATEGORIES.map(function (c) { return c.name; }).concat(['']);
    var out = [];
    names.forEach(function (name) {
      var ids = Object.keys(of).filter(function (id) { return of[id] === name; });
      if (ids.length) out.push({ name: name, label: divisionLabel(name), ids: ids });
    });
    return out;
  }

  /* The two groups of a two-group tournament, in order, each with everyone
     who is or was in it - a player who left keeps their group. */
  function tournamentGroups(session) {
    var ids = [[], []];
    sessionParticipants(session).forEach(function (id) {
      var g = playerGroup(session, id);
      if (g >= 0) ids[g].push(id);
    });
    return ids.map(function (members, g) {
      return { index: g, label: groupLabel(session, g), ids: members };
    });
  }

  /* The score between the groups: games won and points scored by each,
     over every scored game. Team A is always the first group. */
  function groupScore(session) {
    var score = { wins: [0, 0], points: [0, 0], games: 0 };
    sessionMatches(session).forEach(function (m) {
      if (!m.done) return;
      score.games++;
      score.points[0] += m.scoreA;
      score.points[1] += m.scoreB;
      score.wins[m.scoreA > m.scoreB ? 0 : 1]++;
    });
    return score;
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
   * anything outside Latin-1. Given the session's play times (playTimes),
   * each note also reports the player's average time on court.
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

  function rankStandings(stats, playersById, restrictIds, times) {
    var ids = restrictIds || Object.keys(stats);
    var rows = ids.filter(function (id) {
      return stats[id] && playersById[id] && stats[id].games > 0;
    }).map(function (id) {
      var s = stats[id];
      var t = times && times[id];
      return {
        id: id, name: playersById[id].name, rating: playersById[id].rating,
        games: s.games, wins: s.wins, losses: s.losses,
        pct: s.wins / s.games, diff: s.pf - s.pa, rank: 0, note: '',
        avgGame: t && t.games ? t.avg : null
      };
    });
    function timeNote(r) {
      if (r.avgGame !== null) r.note += ' Average game time: ' + fmtDuration(r.avgGame) + '.';
    }

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
    ranked.forEach(function (r, i) { r.rank = i + 1; r.note = boardNote(r, i, maxGames); timeNote(r); });

    var mentions = rows.filter(function (r) { return r.games < minGames; });
    mentions.sort(function (a, b) {
      if (b.pct !== a.pct) return b.pct - a.pct;
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.diff !== a.diff) return b.diff - a.diff;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    mentions.forEach(function (r) { r.note = mentionNote(r); timeNote(r); });

    return { ranked: ranked, mentions: mentions, minGames: minGames, maxGames: maxGames };
  }

  window.Engine = {
    initialRating: initialRating,
    suggestedSkill: suggestedSkill,
    levelDrift: levelDrift,
    parseRoster: parseRoster,
    sessionMatches: sessionMatches,
    activeGames: activeGames,
    waitingPool: waitingPool,
    sessionCounts: sessionCounts,
    effectiveGames: effectiveGames,
    waitSince: waitSince,
    waitBands: waitBands,
    completeGame: completeGame,
    undoScore: undoScore,
    undoDeltas: undoDeltas,
    playerForm: playerForm,
    setSessionPlayers: setSessionPlayers,
    fixedPairs: fixedPairs,
    setPair: setPair,
    clearPair: clearPair,
    queueUnits: queueUnits,
    queueOrder: queueOrder,
    fillCourts: fillCourts,
    previewNext: previewNext,
    checkScore: checkScore,
    migrateSession: migrateSession,
    normalizeSession: normalizeSession,
    computeRatingDeltas: computeRatingDeltas,
    applyDeltas: applyDeltas,
    computeStats: computeStats,
    sessionParticipants: sessionParticipants,
    rankStandings: rankStandings,
    playerProgression: playerProgression,
    resetProgress: resetProgress,
    matchBySkill: matchBySkill,
    tournament: tournament,
    mixedPairs: mixedPairs,
    playerCategory: playerCategory,
    playerDivision: playerDivision,
    unitCategory: unitCategory,
    divisionLabel: divisionLabel,
    tournamentDivisions: tournamentDivisions,
    groupPlay: groupPlay,
    playerGroup: playerGroup,
    groupLabel: groupLabel,
    unitGroup: unitGroup,
    tournamentGroups: tournamentGroups,
    groupScore: groupScore,
    gameDuration: gameDuration,
    playTimes: playTimes,
    fmtDuration: fmtDuration,
    sessionSummary: sessionSummary,
    playerCompanions: playerCompanions,
    sessionRecap: sessionRecap,
    skillCategory: skillCategory,
    GAME_TARGET: GAME_TARGET,
    TIE_WINDOW_MS: TIE_WINDOW_MS,
    SKILL_LEVELS: SKILL_LEVELS,
    SKILL_CATEGORIES: SKILL_CATEGORIES
  };
})();
