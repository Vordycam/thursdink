/* App: UI wiring for Play / Tournament / Players / Stats views (continuous court flow). */
(function () {
  'use strict';

  var DB = Storage_.load();

  // One-time upgrade of legacy round-based active sessions
  (function () {
    var byId = {};
    DB.players.forEach(function (p) { byId[p.id] = p; });
    var changed = false;
    DB.sessions.forEach(function (s) {
      if (Engine.migrateSession(s)) changed = true;
      // repair timestamps for a session that was running when the app updated
      if (Engine.normalizeSession(s)) changed = true;
      // fill any court left free (e.g. right after migration)
      if (s.status === 'active' && Engine.fillCourts(s, byId).length) changed = true;
    });
    if (changed) Storage_.save(DB);
  })();

  /* Every saved change but a score itself ends the chance to undo that
     score: once anything else has moved on, the score stands. */
  function persist() {
    lastUndo = null;
    return Storage_.save(DB);
  }

  /* The last score saved, while it can still be taken back: which game,
     and the games its finish started. Not kept across a reload. */
  var lastUndo = null;

  function undoButtonHtml(session) {
    return lastUndo && lastUndo.sessionId === session.id
      ? '<button class="btn small" data-action="undo-score">Undo last score</button>' : '';
  }

  function undoLastScore() {
    var session = activeSession();
    if (!session || !lastUndo || lastUndo.sessionId !== session.id) return;
    var byId = playersById();
    var r = Engine.undoScore(session, lastUndo.gameId, lastUndo.startedIds);
    if (!r.ok) {
      lastUndo = null;
      renderPlay();
      toast(r.error);
      return;
    }
    if (r.game.ratingDeltas) {
      Engine.undoDeltas(r.game.ratingDeltas, byId);
      r.game.ratingDeltas = null;
    }
    persist();
    renderPlay();
    toast('Court ' + r.game.court + ': score taken back, the game is on again.' +
      (r.withdrawn ? ' ' + r.withdrawn + (r.withdrawn === 1 ? ' game' : ' games') + ' that followed withdrawn.' : ''));
  }

  function playersById() {
    var map = {};
    DB.players.forEach(function (p) { map[p.id] = p; });
    return map;
  }

  function activeSession() {
    for (var i = 0; i < DB.sessions.length; i++) {
      if (DB.sessions[i].status === 'active') return DB.sessions[i];
    }
    return null;
  }

  /* For the actions that refuse while something is running: which tab it is on. */
  function endFirstMessage() {
    var s = activeSession();
    return s && s.tournament
      ? 'End the running tournament first (Tournament tab).'
      : 'End the running session first (Play tab).';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  /* "3.5 Novice": the level and the group's name for it. */
  function skillText(skill) {
    var cat = Engine.skillCategory(skill);
    return esc(skill) + (cat ? ' ' + esc(cat) : '');
  }

  /* Skill picker options, grouped by category. */
  function skillOptions(selected) {
    return Engine.SKILL_CATEGORIES.map(function (c) {
      var opts = Engine.SKILL_LEVELS.filter(function (s) { return Engine.skillCategory(s) === c.name; })
        .map(function (s) {
          return '<option value="' + s + '"' + (s === selected ? ' selected' : '') + '>' + s + '</option>';
        }).join('');
      return '<optgroup label="' + esc(c.name) + ' (' + c.from + ' to ' + c.to + ')">' + opts + '</optgroup>';
    }).join('');
  }

  /* "Beginner 1.0–2.5 · Novice 3.0–3.5 · ..." */
  function categoriesLine() {
    return Engine.SKILL_CATEGORIES.map(function (c) {
      return esc(c.name) + ' ' + c.from + '&ndash;' + c.to;
    }).join(' &middot; ');
  }

  /* ---------- Player photos ---------- */

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return parts.map(function (w) { return w.charAt(0); }).join('').toUpperCase() || '?';
  }

  /* A player's photo as a round thumbnail, or their initials when they have
     none. Only a photo in the form this app saves (a base64 image data URL)
     is rendered as an image, so a hand-edited backup cannot inject markup. */
  function avatarHtml(p, cls) {
    var extra = cls ? ' ' + cls : '';
    if (p.photo && /^data:image\/[a-z]+;base64,[A-Za-z0-9+\/=]+$/.test(p.photo)) {
      return '<img class="avatar' + extra + '" src="' + p.photo + '" alt="">';
    }
    return '<span class="avatar avatar-initials' + extra + '">' + esc(initials(p.name)) + '</span>';
  }

  /* Shrink a chosen picture to a small square JPEG data URL - about 20 KB -
     so a whole roster of photos fits comfortably in the device's storage. */
  var PHOTO_SIZE = 240;
  function shrinkPhoto(file, done) {
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        var side = Math.min(w, h);
        if (!side) { done(null, 'That file does not look like a photo.'); return; }
        var canvas = document.createElement('canvas');
        canvas.width = PHOTO_SIZE;
        canvas.height = PHOTO_SIZE;
        var ctx = canvas.getContext('2d');
        if (!ctx) { done(null, 'This browser cannot resize photos.'); return; }
        ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, PHOTO_SIZE, PHOTO_SIZE);
        var dataUrl;
        try { dataUrl = canvas.toDataURL('image/jpeg', 0.82); } catch (e) { dataUrl = null; }
        if (dataUrl) done(dataUrl, null); else done(null, 'Could not read that photo.');
      };
      img.onerror = function () { done(null, 'That file does not look like a photo.'); };
      img.src = reader.result;
    };
    reader.onerror = function () { done(null, 'Could not read the file.'); };
    reader.readAsDataURL(file);
  }

  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, 2600);
  }

  /* ---------- Modal helpers ---------- */

  function openModal(html) {
    var root = document.getElementById('modal-root');
    root.innerHTML =
      '<div class="modal-backdrop">' +
      '<div class="modal" role="dialog" aria-modal="true">' + html + '</div>' +
      '</div>';
    var backdrop = root.querySelector('.modal-backdrop');
    // Close only on a direct backdrop click; clicks inside the dialog must
    // keep bubbling so the app's delegated button handler receives them.
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) closeModal();
    });
  }

  function closeModal() {
    document.getElementById('modal-root').innerHTML = '';
  }

  /* ---------- Play view ---------- */

  /* Pairs chosen on the setup screen, applied when the session starts. */
  var setupPairs = [];

  /* The Play and Tournament tabs both reflect the live session, so they are
     always redrawn together: the tab the session belongs to shows it, and
     the other says where it is. */
  function renderPlay() {
    var view = document.getElementById('view-play');
    var session = activeSession();
    if (!session) {
      view.innerHTML = renderSessionSetup();
      renderSetupPairs();
    } else if (session.tournament) {
      view.innerHTML = renderElsewhereCard(session);
    } else {
      view.innerHTML = renderActiveSession(session);
    }
    renderTournament();
  }

  /* Shown on the Play tab while a tournament runs, and on the Tournament
     tab while a regular session runs: they use the same courts. */
  function renderElsewhereCard(session) {
    var tour = !!session.tournament;
    return '<div class="card empty-state">' +
      '<h2>' + (tour ? 'A tournament is in progress' : 'A session is in progress') + '</h2>' +
      '<p class="muted">' + fmtDate(session.startedAt) + ' &middot; ' + session.playerIds.length + ' players &middot; ' +
      session.courtCount + ' courts.<br>' +
      (tour ? 'Courts, scores and the waiting lines are on the Tournament tab.'
        : 'A tournament uses the same courts, so end the session on the Play tab first.') + '</p>' +
      '<button class="btn primary" data-action="' + (tour ? 'goto-tournament' : 'goto-play') + '">' +
      (tour ? 'Open the Tournament tab' : 'Open the Play tab') + '</button></div>';
  }

  /* A search box for a long list of names, on the roster and the check-in
     lists. Short rosters do not need one. */
  var FILTER_FROM = 12;

  function rosterFilterHtml(count) {
    if (count < FILTER_FROM) return '';
    return '<input type="search" class="row-filter" placeholder="Find a name" aria-label="Find a name" autocomplete="off">';
  }

  /* Hide the rows in the box's own list whose name does not contain what
     was typed. The rows stay checked or unchecked as they were. */
  function applyRowFilter(input) {
    var q = input.value.trim().toLowerCase();
    var scope = input.closest('.card, .field') || document;
    scope.querySelectorAll('.check-row, .player-row').forEach(function (row) {
      var name = row.querySelector('.check-name, .player-main');
      row.hidden = !!q && !!name && name.textContent.toLowerCase().indexOf(q) < 0;
    });
  }

  /* The check boxes a Select all / none applies to: the ones not hidden
     by a filter. With no filter, all of them, as before. */
  function visibleChecks(selector) {
    return Array.prototype.slice.call(document.querySelectorAll(selector)).filter(function (c) {
      var row = c.closest('.check-row');
      return !row || !row.hidden;
    });
  }

  function renderSessionSetup() {
    var roster = DB.players.filter(function (p) { return !p.archived; });
    if (roster.length < 4) {
      return '<div class="empty-state">' +
        '<h2>Start a session</h2>' +
        '<p>You need at least 4 players in your roster. You have ' + roster.length + '.</p>' +
        '<button class="btn primary big" data-action="goto-players">Add players</button>' +
        '</div>';
    }
    var checks = roster.map(function (p) {
      return '<label class="check-row">' +
        '<input type="checkbox" class="setup-player" value="' + p.id + '" checked> ' +
        '<span class="check-name">' + esc(p.name) + '</span>' +
        '<span class="muted">' + skillText(p.skill) + '</span>' +
        '</label>';
    }).join('');
    return '<div class="card">' +
      '<h2>Start a session</h2>' +
      '<div class="field"><label>Courts available</label>' +
      '<div class="court-picker">' +
      [1, 2, 3, 4, 5, 6].map(function (n) {
        return '<button class="court-opt' + (n === 2 ? ' selected' : '') + '" data-action="pick-courts" data-n="' + n + '">' + n + '</button>';
      }).join('') +
      '</div></div>' +
      '<div class="field"><label>Who is playing today? <span class="muted" id="setup-count"></span></label>' +
      '<div class="setup-actions"><button class="btn small" data-action="setup-all">Select all</button>' +
      '<button class="btn small" data-action="setup-none">Select none</button>' + rosterFilterHtml(roster.length) + '</div>' +
      '<div class="check-list">' + checks + '</div></div>' +
      '<div class="field"><label>Fixed partners <span class="muted">(optional)</span></label>' +
      '<p class="muted small-note pairs-help">For anyone who wants to keep one partner all night. ' +
      'Partners go on together every game and count as one entry in the waiting line.</p>' +
      '<div id="setup-pairs"></div></div>' +
      '<div class="field"><label>Matching <span class="muted">(optional)</span></label>' +
      '<label class="check-row"><input type="checkbox" id="setup-skill-match"> ' +
      '<span class="check-name">Match by skill</span></label>' +
      '<p class="muted small-note">Courts are made of players close in rating. Whoever has waited longest ' +
      'still plays next; the other seats go to the closest-rated players waiting.</p></div>' +
      '<button class="btn primary big" data-action="start-session">Start session</button>' +
      '</div>';
  }

  function checkedSetupIds() {
    return Array.prototype.slice.call(document.querySelectorAll('.setup-player:checked'))
      .map(function (el) { return el.value; });
  }

  /* Redraw only the pairs block, so ticking a checkbox or adding a pair does
     not reset the court picker and the check list around it. A pair whose
     member is unticked is dropped. */
  function renderSetupPairs() {
    var el = document.getElementById('setup-pairs');
    if (!el) return;
    var ids = checkedSetupIds();
    setupPairs = setupPairs.filter(function (p) { return ids.indexOf(p[0]) >= 0 && ids.indexOf(p[1]) >= 0; });
    el.innerHTML = pairsBlockHtml(setupPairs, ids, playersById());
  }

  /* Current pairs, each with a Split button, plus a picker to add one from
     whoever is unpaired. Shared by session setup, tournament setup and the
     in-session modal. `labelOf` can add to a name in the picker (the
     tournament shows each player's division beside it). */
  function pairsBlockHtml(pairs, ids, byId, labelOf, noteOf) {
    function name(id) { return byId[id] ? byId[id].name : '?'; }
    var label = labelOf || name;
    var paired = {};
    pairs.forEach(function (p) { paired[p[0]] = true; paired[p[1]] = true; });
    var free = ids.filter(function (id) { return !paired[id] && byId[id]; });
    free.sort(function (a, b) { return name(a).localeCompare(name(b)); });

    var rows = pairs.map(function (p) {
      return '<div class="pair-row"><span class="pair-names">' + esc(name(p[0])) + ' &amp; ' + esc(name(p[1])) +
        ' <span class="pair-tag">pair</span>' + (noteOf ? noteOf(p) : '') + '</span>' +
        '<button class="btn small" data-action="remove-pair" data-player="' + p[0] + '">Split</button></div>';
    }).join('');
    if (!rows) rows = '<p class="muted small-note pairs-none">No fixed partners.</p>';

    var picker;
    if (free.length >= 2) {
      var opts = function (placeholder) {
        return '<option value="">' + placeholder + '</option>' + free.map(function (id) {
          return '<option value="' + id + '">' + esc(label(id)) + '</option>';
        }).join('');
      };
      picker = '<div class="pair-add">' +
        '<select class="pair-pick" aria-label="First partner">' + opts('Player') + '</select>' +
        '<span class="muted">&amp;</span>' +
        '<select class="pair-pick" aria-label="Second partner">' + opts('Partner') + '</select>' +
        '<button class="btn small primary" data-action="add-pair">Pair up</button></div>';
    } else {
      picker = '<p class="muted small-note">Not enough unpaired players to add another pair.</p>';
    }
    return rows + picker;
  }

  /* The division badge on a tournament court or result; nothing otherwise. */
  function divisionTag(badge) {
    return badge ? ' <span class="division-tag">' + esc(badge) + '</span>' : '';
  }

  /* `fixed` (from Engine.fixedPairs) tags a team that is a fixed pair;
     `levels` adds each player's skill level, shown while matching by skill
     and in a tournament. `badge`, in a tournament, names the court's division. */
  function teamNames(team, byId, fixed, levels) {
    var html = team.map(function (id) {
      return '<span class="pname">' + esc(byId[id] ? byId[id].name : '?') + '</span>' +
        (levels && byId[id] ? ' <span class="lvl">' + esc(byId[id].skill) + '</span>' : '');
    }).join(' &amp; ');
    if (fixed && team.length === 2 && fixed[team[0]] === team[1]) html += ' <span class="pair-tag">pair</span>';
    return html;
  }

  /* Games still running on courts the host has since closed: they finish,
     and nothing new starts there. */
  function closingCourtsHtml(actives, session, card) {
    return actives.filter(function (g) { return g.court > session.courtCount; })
      .sort(function (a, b) { return a.court - b.court; })
      .map(card).join('');
  }

  /* `sideTags`, in a two-group tournament, names each team's group. The
     court label carries the game's clock; `closing` marks a court that
     closes after this game. */
  function renderActiveGameCard(m, byId, fixed, levels, badge, sideTags, closing) {
    var scoreRow = function (side, team) {
      var v = side === 'A' ? m.scoreA : m.scoreB;
      var val = (v === null || v === undefined) ? '' : v;
      return '<div class="team-row">' +
        '<div class="team-names">' + teamNames(team, byId, fixed, levels) +
        (sideTags ? ' ' + sideTags[side === 'A' ? 0 : 1] : '') + '</div>' +
        '<div class="score-ctl">' +
        '<button class="step-btn" data-action="score-step" data-match="' + m.id + '" data-side="' + side + '" data-d="-1">&minus;</button>' +
        '<input type="number" class="score-input" inputmode="numeric" min="0" max="99" ' +
        'data-match="' + m.id + '" data-side="' + side + '" value="' + val + '" placeholder="0">' +
        '<button class="step-btn" data-action="score-step" data-match="' + m.id + '" data-side="' + side + '" data-d="1">+</button>' +
        '</div></div>';
    };
    return '<div class="match-card">' +
      '<div class="court-label">Court ' + m.court + divisionTag(badge) +
      (closing ? ' <span class="closing-note">closing after this game</span>' : '') + gameClockHtml(m) + '</div>' +
      scoreRow('A', m.teamA) +
      '<div class="vs">vs</div>' +
      scoreRow('B', m.teamB) +
      '<div class="match-footer"><div class="match-footer-left">' +
      '<button class="btn small" data-action="reshuffle-game" data-match="' + m.id + '">Reshuffle</button>' +
      '<button class="btn small" data-action="edit-matchup" data-match="' + m.id + '">Edit players</button>' +
      '</div>' +
      '<button class="btn primary" data-action="save-score" data-match="' + m.id + '">Save score</button>' +
      '</div></div>';
  }

  function freeCourtReason(poolCount, readyCount) {
    if (poolCount === 0) return 'no one is waiting.';
    if (readyCount < poolCount) {
      return readyCount + ' of ' + poolCount + ' waiting are ready, needs 4. ' +
        'Someone is held for a partner still on court.';
    }
    return 'only ' + poolCount + ' waiting, needs 4.';
  }

  /* `reason` overrides the usual explanation (a tournament has its own). */
  function renderFreeCourtCard(court, poolCount, readyCount, reason) {
    var why = reason || freeCourtReason(poolCount, readyCount);
    return '<div class="match-card free-court">' +
      '<div class="court-label">Court ' + court + '</div>' +
      '<p class="muted free-note">Free &mdash; ' + why + '</p></div>';
  }

  /* `sideTags`, in a two-group tournament, names each team's group. A
     game with a clock shows how long it took. */
  function renderFinishedGameRow(m, byId, badge, sideTags, readOnly) {
    var aWon = m.scoreA > m.scoreB;
    var dur = Engine.gameDuration(m);
    return '<div class="finished-row">' +
      '<span class="finished-court muted">C' + m.court + divisionTag(badge) +
      (dur !== null ? ' <span class="fin-time">' + fmtShort(dur) + '</span>' : '') + '</span>' +
      '<span class="finished-teams">' +
      '<span class="' + (aWon ? 'fin-win' : '') + '">' + teamNames(m.teamA, byId) + (sideTags ? ' ' + sideTags[0] : '') + ' ' + m.scoreA + '</span>' +
      ' &ndash; ' +
      '<span class="' + (!aWon ? 'fin-win' : '') + '">' + m.scoreB + ' ' + (sideTags ? sideTags[1] + ' ' : '') + teamNames(m.teamB, byId) + '</span>' +
      '</span>' +
      (readOnly ? '' : '<button class="btn small" data-action="edit-finished" data-match="' + m.id + '">Edit</button>') +
      '</div>';
  }

  /* A saved session's games in the order they were played, with no Edit:
     a night that has ended is read-only. */
  function pastGamesHtml(sess, byId) {
    var done = Engine.sessionMatches(sess).filter(function (m) { return m.done; });
    if (!done.length) return '';
    var groups = Engine.groupPlay(sess);
    var tags = groups ? [groupTag(sess, 0), groupTag(sess, 1)] : null;
    done.sort(function (a, b) { return ((a.finishedAt || 0) - (b.finishedAt || 0)) || ((a.seq || 0) - (b.seq || 0)); });
    return '<details class="round-past"><summary>Games (' + done.length + ')</summary><div class="finished-list">' +
      done.map(function (m) {
        var badge = sess.tournament && !groups ? Engine.divisionLabel(gameDivision(m, byId)) : null;
        return renderFinishedGameRow(m, byId, badge, tags, true);
      }).join('') + '</div></details>';
  }

  /* One entry in a waiting line: a player or a fixed pair, with their clock,
     games played, and - with `levels` - each player's skill level. */
  function waitChip(u, band, label, byId, counts, levels) {
    var names = u.ids.map(function (id) {
      return esc(byId[id] ? byId[id].name : '?') +
        (levels && byId[id] ? ' <span class="lvl">' + esc(byId[id].skill) + '</span>' : '');
    }).join(' &amp; ');
    var games = Math.max.apply(null, u.ids.map(function (id) { return counts.games[id] || 0; }));
    return '<span class="chip chip-' + band + '" data-since="' + u.since + '">' +
      (label ? '<span class="muted">' + label + '</span> ' : '') + names +
      (u.ids.length > 1 ? ' <span class="pair-tag">pair</span>' : '') +
      (u.waitingFor ? ' <span class="muted">waiting for ' + esc(byId[u.waitingFor] ? byId[u.waitingFor].name : '?') + '</span>' : '') +
      ' <span class="wait-time">' + fmtWait(Date.now() - u.since) + '</span>' +
      ' <span class="muted">(' + games + ')</span></span>';
  }

  function renderActiveSession(session) {
    var byId = playersById();
    var actives = Engine.activeGames(session);
    var finished = (session.games || []).filter(function (g) { return g.done; });
    var pool = Engine.waitingPool(session);
    var counts = Engine.sessionCounts(session);
    var fixed = Engine.fixedPairs(session);
    var pairCount = (session.pairs || []).length;
    var skill = Engine.matchBySkill(session);

    // The line as units: a fixed pair is one entry. Anyone held back because
    // their partner is still on court is listed separately, after the line.
    var units = Engine.queueUnits(session, byId);
    var ready = units.filter(function (u) { return !u.waitingFor; });
    var held = units.filter(function (u) { return u.waitingFor; });
    var readyCount = ready.reduce(function (n, u) { return n + u.ids.length; }, 0);

    var html = '<div class="session-bar">' +
      '<div><strong>Session</strong> &middot; ' + fmtDate(session.startedAt) +
      ' &middot; ' + session.playerIds.length + ' players &middot; ' + session.courtCount + ' courts</div>' +
      '<div class="session-bar-actions">' +
      '<button class="btn small" data-action="manage-players">Players</button>' +
      '<button class="btn small" data-action="manage-partners">Partners' + (pairCount ? ' (' + pairCount + ')' : '') + '</button>' +
      '<button class="btn small' + (skill ? ' on' : '') + '" data-action="toggle-skill-match">Skill match: ' + (skill ? 'On' : 'Off') + '</button>' +
      '<button class="btn small" data-action="change-courts">Courts: ' + session.courtCount + '</button>' +
      undoButtonHtml(session) +
      '<button class="btn small danger-outline" data-action="end-session">End session</button>' +
      '</div></div>';

    html += '<div class="courts-grid">';
    for (var c = 1; c <= session.courtCount; c++) {
      var g = null;
      actives.forEach(function (a) { if (a.court === c) g = a; });
      html += g ? renderActiveGameCard(g, byId, fixed, skill) : renderFreeCourtCard(c, pool.length, readyCount);
    }
    html += closingCourtsHtml(actives, session, function (cg) { return renderActiveGameCard(cg, byId, fixed, skill, null, null, true); });
    html += '</div>';

    if (pool.length) {
      // Longest wait first. Each chip carries its own clock and a colour for
      // where it sits: red fills the next court, yellow the one after, green
      // just sat down or just arrived. Bands are worked out over the people
      // who can actually go on; someone held for a partner gets no colour.
      var bands = Engine.waitBands(ready);
      var chip = function (u, band, label) { return waitChip(u, band, label, byId, counts, skill); };
      html += '<div class="sitouts"><span class="sitout-label">Waiting to play, longest wait first:</span> ' +
        ready.map(function (u, i) { return chip(u, bands[i], (i + 1) + '.'); }).join(' ') +
        (held.length
          ? '<div class="held-line"><span class="sitout-label">Held for a partner:</span> ' +
            held.map(function (u) { return chip(u, 'held', ''); }).join(' ') + '</div>'
          : '') +
        '<div class="muted small-note">' +
        '<span class="legend legend-red">Red</span> waited longest &middot; ' +
        '<span class="legend legend-yellow">Yellow</span> next &middot; ' +
        '<span class="legend legend-green">Green</span> most recent to sit down or arrive. ' +
        'Time = how long they have been waiting; brackets = games played.' +
        (pairCount ? ' Fixed partners are one entry and go on together.' : '') +
        (skill ? ' Match by skill is on: the longest wait plays next, and the other seats go to the closest-rated players waiting.' : '') +
        '</div></div>';
    }

    if (finished.length) {
      html += '<details class="round-past" open><summary>Finished games (' + finished.length + ')</summary>' +
        '<div class="finished-list">' +
        finished.slice().reverse().map(function (m) { return renderFinishedGameRow(m, byId); }).join('') +
        '</div></details>';
    }

    // Everyone who finished a game this session, including anyone who has
    // since left. Restricting to playerIds dropped early leavers' results.
    var stats = Engine.computeStats([session]);
    var board = leaderboardHtml(stats, byId, null, Engine.playTimes(session));
    if (board) {
      html += '<div class="card"><h3>Session standings</h3>' + board + '</div>';
    }
    return html;
  }

  /* ---------- Tournament view ---------- */

  /* Pairs chosen on the tournament setup screen, applied when it starts,
     and whether partners of different levels are allowed. Both live here,
     not in the form, so a redraw of the setup screen keeps them. */
  var tourPairs = [];
  var tourMixedPairs = false;

  /* The format chosen on the setup screen - by division, or two groups -
     and for two groups the names and each player's group. Kept here across
     redraws too. */
  var tourFormat = 'divisions';
  var tourGroupNames = ['Group A', 'Group B'];
  var tourGroupOf = {};

  function resetTournamentSetup() {
    tourPairs = [];
    tourMixedPairs = false;
    tourFormat = 'divisions';
    tourGroupNames = ['Group A', 'Group B'];
    tourGroupOf = {};
  }

  /* The group names as typed, trimmed, with the defaults for anything blank. */
  function groupNames() {
    return [0, 1].map(function (i) {
      return String(tourGroupNames[i] || '').trim() || (i ? 'Group B' : 'Group A');
    });
  }

  /* The setup's groups as the engine reads them, for its pair and group
     checks before a session exists. */
  function setupGroupSession() {
    return { tournament: true, groups: { names: groupNames(), of: tourGroupOf } };
  }

  /* The two-way switch beside a name that puts a player in a group. */
  function groupPickHtml(names, playerId, selected, action, cls) {
    return '<span class="group-pick' + (cls ? ' ' + cls : '') + '" role="group" aria-label="Group">' +
      [0, 1].map(function (i) {
        return '<button type="button" class="grp-opt' + (selected === i ? ' selected' : '') + '" data-action="' + action +
          '" data-player="' + playerId + '" data-group="' + i + '">' + esc(names[i]) + '</button>';
      }).join('') + '</span>';
  }

  /* The coloured tag naming a team's group on a court or a result. */
  function groupTag(session, g) {
    return '<span class="group-tag g' + g + '">' + esc(Engine.groupLabel(session, g)) + '</span>';
  }

  /* Picker label with the group, for a two-group tournament's pair pickers. */
  function groupLabelFn(session, byId) {
    return function (id) {
      var g = Engine.playerGroup(session, id);
      return (byId[id] ? byId[id].name : '?') + ' (' + (g < 0 ? 'no group' : Engine.groupLabel(session, g)) + ')';
    };
  }

  /* For a two-group tournament's pair rows: a warning when the pair now
     straddles the groups and cannot be seated. Nothing otherwise. */
  function groupPairNoteFn(session) {
    return function (p) {
      return Engine.unitGroup(session, { ids: p }) < 0
        ? ' <span class="pair-note warn">different groups</span>' : '';
    };
  }

  /* What the mixed-level pairs setting means, in its current state. */
  function mixedPairsNote(on) {
    return on
      ? 'On: two players of different levels may pair up. The pair plays in the higher partner\'s ' +
        'division, and the other two on that court are from that division as usual.'
      : 'Off: both partners must be in the same division.';
  }

  /* For a tournament's pair rows: where a pair of different levels plays,
     or a warning when it cannot be seated. Nothing for an ordinary pair. */
  function pairNoteFn(byId, session) {
    return function (p) {
      if (divisionOf(byId, p[0]) === divisionOf(byId, p[1])) return '';
      var cat = Engine.unitCategory({ ids: p }, byId, session);
      return cat === null
        ? ' <span class="pair-note warn">different divisions</span>'
        : ' <span class="pair-note">plays in ' + esc(Engine.divisionLabel(cat)) + '</span>';
    };
  }

  /* The division each checked-in player would play in at setup: their own,
     or their pair's when partners of different levels are allowed - the
     engine's rule, the higher of the two. */
  function setupDivisions(ids, byId) {
    var of = {};
    ids.forEach(function (id) { of[id] = divisionOf(byId, id); });
    if (tourMixedPairs) {
      tourPairs.forEach(function (p) {
        if (of[p[0]] === undefined || of[p[1]] === undefined) return;
        of[p[0]] = of[p[1]] = Engine.unitCategory({ ids: p }, byId, { mixedPairs: true });
      });
    }
    return of;
  }

  function renderTournament() {
    var view = document.getElementById('view-tournament');
    if (!view) return;
    var session = activeSession();
    if (!session) {
      view.innerHTML = renderTournamentSetup();
      renderTournamentPairs();
      updateTournamentCounts();
    } else if (session.tournament) {
      view.innerHTML = renderActiveTournament(session);
    } else {
      view.innerHTML = renderElsewhereCard(session);
    }
  }

  /* Division names in scale order, the unrated group last. */
  function divisionNames() {
    return Engine.SKILL_CATEGORIES.map(function (c) { return c.name; }).concat(['']);
  }

  /* "3.0–3.5" for a named division, '' for the unrated group. */
  function divisionRange(name) {
    var range = '';
    Engine.SKILL_CATEGORIES.forEach(function (c) { if (c.name === name) range = c.from + '&ndash;' + c.to; });
    return range;
  }

  function divisionOf(byId, id) {
    return Engine.playerCategory(byId, id);
  }

  /* A game's division: as recorded, or by its players for safety. */
  function gameDivision(g, byId) {
    return g.category === undefined ? divisionOf(byId, g.teamA[0]) : g.category;
  }

  /* Picker label with the division, for the tournament's pair pickers. */
  function divisionLabelFn(byId) {
    return function (id) {
      return (byId[id] ? byId[id].name : '?') + ' (' + Engine.divisionLabel(divisionOf(byId, id)) + ')';
    };
  }

  function checkedTournamentIds() {
    return Array.prototype.slice.call(document.querySelectorAll('.tsetup-player:checked'))
      .map(function (el) { return el.value; });
  }

  /* The setup screen offers two formats. The whole card carries the chosen
     one as a class, and each control that belongs to only one format is
     marked only-divisions or only-groups, so switching shows and hides
     without redrawing the check-in list or the court choice. */
  function renderTournamentSetup() {
    var roster = DB.players.filter(function (p) { return !p.archived; });
    var groups = tourFormat === 'groups';
    var names = groupNames();
    var intro = '<div class="card tsetup ' + (groups ? 'format-groups' : 'format-divisions') + '"><h2>Tournament</h2>' +
      '<p class="muted small-note tour-intro">For tournament nights. Play by division - everyone within their own level, ' +
      'never mixed - or as two groups facing off, for a company or club tournament. ' +
      'Levels: ' + categoriesLine() + '.</p>';
    if (roster.length < 4) {
      return intro + '<div class="empty-state">' +
        '<p>You need at least 4 players in your roster. You have ' + roster.length + '.</p>' +
        '<button class="btn primary big" data-action="goto-players">Add players</button>' +
        '</div></div>';
    }
    var divisions = divisionNames().map(function (name) {
      var members = roster.filter(function (p) { return Engine.skillCategory(p.skill) === name; });
      if (!members.length && !name) return '';
      var rows = members.map(function (p) {
        return '<label class="check-row">' +
          '<input type="checkbox" class="tsetup-player" value="' + p.id + '" data-division="' + esc(name) + '" checked> ' +
          '<span class="check-name">' + esc(p.name) + '</span>' +
          '<span class="muted">' + esc(p.skill) + '</span>' +
          groupPickHtml(names, p.id, tourGroupOf[p.id], 'tsetup-group', 'only-groups') +
          '</label>';
      }).join('');
      return '<div class="division-group"><div class="division-head">' +
        '<strong>' + esc(Engine.divisionLabel(name)) + '</strong>' +
        (name ? ' <span class="muted">' + divisionRange(name) + '</span>' : '') +
        ' <span class="muted division-count" data-division="' + esc(name) + '"></span></div>' +
        (rows || '<p class="muted small-note division-empty">No one at this level in the roster.</p>') +
        '</div>';
    }).join('');
    return intro +
      '<div class="field"><label>Format</label>' +
      '<div class="format-picker">' +
      '<button class="format-opt' + (groups ? '' : ' selected') + '" data-action="tsetup-format" data-format="divisions">By division</button>' +
      '<button class="format-opt' + (groups ? ' selected' : '') + '" data-action="tsetup-format" data-format="groups">Two groups</button>' +
      '</div>' +
      '<p class="muted small-note format-note only-divisions">Everyone plays only within their division: Beginners with Beginners, ' +
      'Novices with Novices, and so on, never mixed. Any court can host any division, and each court card says which one is on it. ' +
      'Within a division, longest wait plays first as usual.</p>' +
      '<p class="muted small-note format-note only-groups">One group against the other. Every game is two players from one group ' +
      'against two from the other, so nobody plays with or against their own group, and a scoreboard shows which group is ahead. ' +
      'Within a group, longest wait plays first as usual. Equal numbers work best; a smaller group simply plays more often.</p></div>' +
      '<div class="field only-groups"><label>Group names</label>' +
      '<div class="group-names">' +
      '<input type="text" class="group-name" data-group="0" value="' + esc(tourGroupNames[0]) + '" maxlength="24" placeholder="Group A" aria-label="First group">' +
      '<span class="muted">vs</span>' +
      '<input type="text" class="group-name" data-group="1" value="' + esc(tourGroupNames[1]) + '" maxlength="24" placeholder="Group B" aria-label="Second group">' +
      '</div></div>' +
      '<div class="field"><label>Courts available</label>' +
      '<div class="court-picker">' +
      [1, 2, 3, 4, 5, 6].map(function (n) {
        return '<button class="court-opt' + (n === 2 ? ' selected' : '') + '" data-action="pick-courts" data-n="' + n + '">' + n + '</button>';
      }).join('') +
      '</div></div>' +
      '<div class="field"><label>Who is playing? <span class="muted" id="tsetup-count"></span></label>' +
      '<div class="setup-actions"><button class="btn small" data-action="tsetup-all">Select all</button>' +
      '<button class="btn small" data-action="tsetup-none">Select none</button>' +
      '<button class="btn small only-groups" data-action="tsetup-autosplit">Auto-split by skill</button>' +
      (lastGroupSession() ? '<button class="btn small only-groups" data-action="tsetup-reuse-groups">Use last tournament\'s groups</button>' : '') +
      rosterFilterHtml(roster.length) +
      '</div>' +
      '<div class="check-list divisions-list">' + divisions + '</div>' +
      '<p class="muted small-note only-divisions">A division needs 4 players checked in to get a court. ' +
      'To move someone to another division, change their level on the Players tab.</p>' +
      '<p class="muted small-note only-groups">Tap a group beside each name, or Auto-split to share the strongest players ' +
      'evenly between the two. A court needs 2 from each group.</p></div>' +
      '<div class="field"><label>Fixed partners <span class="muted">(optional)</span></label>' +
      '<p class="muted small-note pairs-help">Partners go on together every game and count as one entry in ' +
      'their <span class="only-divisions">division\'s</span><span class="only-groups">group\'s</span> line.</p>' +
      '<div class="only-divisions">' +
      '<label class="check-row"><input type="checkbox" id="tsetup-mixed-pairs"' + (tourMixedPairs ? ' checked' : '') + '> ' +
      '<span class="check-name">Allow partners of different levels</span></label>' +
      '<p class="muted small-note mixed-note">' + mixedPairsNote(tourMixedPairs) + '</p></div>' +
      '<div id="tsetup-pairs"></div></div>' +
      '<button class="btn primary big" data-action="start-tournament">Start tournament</button>' +
      '</div>';
  }

  /* ---------- Two groups: setup actions ---------- */

  /* Switch the setup screen between the formats. Only the controls change;
     the check-in list and the court choice stay as they are. A pair the
     other format does not allow is dropped, and said so. */
  function setTournamentFormat(format) {
    if ((format !== 'groups' && format !== 'divisions') || format === tourFormat) return;
    tourFormat = format;
    var card = document.querySelector('#view-tournament .tsetup');
    if (card) {
      card.classList.toggle('format-groups', format === 'groups');
      card.classList.toggle('format-divisions', format !== 'groups');
      card.querySelectorAll('.format-opt').forEach(function (b) {
        b.classList.toggle('selected', b.getAttribute('data-format') === format);
      });
    }
    var before = tourPairs.length;
    renderTournamentPairs();
    updateTournamentCounts();
    var dropped = before - tourPairs.length;
    if (dropped) toast(dropped + (dropped === 1 ? ' pair' : ' pairs') + ' removed: not allowed in this format.');
  }

  /* Put a player in a group on the setup screen. A fixed partner goes with
     them, since partners share a group. */
  function setSetupGroup(playerId, g) {
    if (g !== 0 && g !== 1) return;
    var moved = [playerId];
    tourPairs.forEach(function (p) {
      if (p[0] === playerId) moved.push(p[1]);
      if (p[1] === playerId) moved.push(p[0]);
    });
    moved.forEach(function (id) { tourGroupOf[id] = g; });
    refreshSetupGroups();
    if (moved.length > 1) {
      var byId = playersById();
      toast(moved.map(function (id) { return byId[id] ? byId[id].name : '?'; }).join(' & ') +
        ' moved together: partners share a group.');
    }
  }

  /* Share the checked-in players between the groups evenly, the strongest
     spread across both: in rating order, each goes to the smaller group, or
     to the weaker one when the groups are the same size. Fixed partners
     move as one. */
  function autoSplitGroups() {
    var ids = checkedTournamentIds();
    var byId = playersById();
    var seen = {}, units = [];
    ids.forEach(function (id) {
      if (seen[id]) return;
      var unit = [id];
      tourPairs.forEach(function (p) {
        if (p[0] === id && ids.indexOf(p[1]) >= 0) unit.push(p[1]);
        if (p[1] === id && ids.indexOf(p[0]) >= 0) unit.push(p[0]);
      });
      unit.forEach(function (x) { seen[x] = true; });
      units.push(unit);
    });
    var rating = function (id) { return byId[id] ? byId[id].rating : 1250; };
    var avg = function (unit) { return unit.reduce(function (s, id) { return s + rating(id); }, 0) / unit.length; };
    units.sort(function (a, b) { return avg(b) - avg(a); });
    var size = [0, 0], total = [0, 0];
    units.forEach(function (unit) {
      var g = size[0] !== size[1] ? (size[0] < size[1] ? 0 : 1) : (total[0] <= total[1] ? 0 : 1);
      unit.forEach(function (id) { tourGroupOf[id] = g; size[g]++; total[g] += rating(id); });
    });
    refreshSetupGroups();
    var names = groupNames();
    toast('Split by skill: ' + names[0] + ' ' + size[0] + ', ' + names[1] + ' ' + size[1] + '.');
  }

  /* The most recent two-group tournament, or null. */
  function lastGroupSession() {
    for (var i = DB.sessions.length - 1; i >= 0; i--) {
      if (Engine.groupPlay(DB.sessions[i])) return DB.sessions[i];
    }
    return null;
  }

  /* Take the names and the groups from the last two-group tournament, for
     everyone still in the roster. The same company teams, week after week. */
  function reuseLastGroups() {
    var last = lastGroupSession();
    if (!last) return;
    var byId = playersById();
    tourGroupNames = [Engine.groupLabel(last, 0), Engine.groupLabel(last, 1)];
    tourGroupOf = {};
    var per = [0, 0];
    Object.keys(last.groups.of).forEach(function (id) {
      var g = Engine.playerGroup(last, id);
      if (g >= 0 && byId[id] && !byId[id].archived) { tourGroupOf[id] = g; per[g]++; }
    });
    document.querySelectorAll('#view-tournament .group-name').forEach(function (input) {
      input.value = tourGroupNames[parseInt(input.getAttribute('data-group'), 10)] || '';
    });
    var names = groupNames();
    document.querySelectorAll('#view-tournament .grp-opt').forEach(function (b) {
      b.textContent = names[parseInt(b.getAttribute('data-group'), 10)];
    });
    refreshSetupGroups();
    toast('Groups from ' + fmtDate(last.startedAt) + ': ' + names[0] + ' ' + per[0] + ', ' + names[1] + ' ' + per[1] + '.');
  }

  /* Redraw the group switches, the pairs block and the counts after a
     change of groups, without touching the rest of the setup screen. */
  function refreshSetupGroups() {
    document.querySelectorAll('#view-tournament .grp-opt').forEach(function (b) {
      b.classList.toggle('selected', tourGroupOf[b.getAttribute('data-player')] === parseInt(b.getAttribute('data-group'), 10));
    });
    renderTournamentPairs();
    updateTournamentCounts();
  }

  /* A new group name: on the switches beside each name, in the pair
     pickers and in the counts. */
  function groupNameTyped(input) {
    var gi = parseInt(input.getAttribute('data-group'), 10);
    if (gi !== 0 && gi !== 1) return;
    tourGroupNames[gi] = input.value;
    var label = groupNames()[gi];
    document.querySelectorAll('#view-tournament .grp-opt[data-group="' + gi + '"]').forEach(function (b) { b.textContent = label; });
    renderTournamentPairs();
    updateTournamentCounts();
  }

  /* The selected count, and under each division how many are checked in,
     flagged when there are some but fewer than the four a court needs. */
  function updateTournamentCounts() {
    var el = document.getElementById('tsetup-count');
    if (!el) return;
    // Counted by the division each player would play in, so a partner of a
    // different level who plays up is counted where they will actually play.
    var ids = checkedTournamentIds();
    var of = setupDivisions(ids, playersById());
    var total = ids.length, per = {};
    ids.forEach(function (id) { per[of[id]] = (per[of[id]] || 0) + 1; });
    if (tourFormat === 'groups') {
      // By group: a court needs 2 from each, and everyone needs a group.
      var names = groupNames(), perGroup = [0, 0], none = 0;
      ids.forEach(function (id) {
        var g = tourGroupOf[id];
        if (g === 0 || g === 1) perGroup[g]++; else none++;
      });
      el.textContent = '(' + total + ' selected \u00b7 ' + names[0] + ' ' + perGroup[0] + ' \u00b7 ' + names[1] + ' ' + perGroup[1] +
        (none ? ' \u00b7 ' + none + ' without a group' : '') + ')';
      el.classList.toggle('warn', none > 0 || (total > 0 && (perGroup[0] < 2 || perGroup[1] < 2)));
    } else {
      el.textContent = '(' + total + ' selected)';
      if (el.classList.contains('warn')) el.classList.remove('warn');
    }
    document.querySelectorAll('.division-count').forEach(function (c) {
      var n = per[c.getAttribute('data-division')] || 0;
      c.textContent = n === 0 ? '' : n >= 4 ? '\u00b7 ' + n + ' playing' : '\u00b7 ' + n + ' playing, needs 4';
      c.classList.toggle('warn', n > 0 && n < 4);
    });
  }

  function renderTournamentPairs() {
    var el = document.getElementById('tsetup-pairs');
    if (!el) return;
    var ids = checkedTournamentIds();
    var byId = playersById();
    if (tourFormat === 'groups') {
      // Partners must share a group; a pair pulled apart is dropped.
      var gs = setupGroupSession();
      tourPairs = tourPairs.filter(function (p) {
        return ids.indexOf(p[0]) >= 0 && ids.indexOf(p[1]) >= 0 && Engine.unitGroup(gs, { ids: p }) >= 0;
      });
      el.innerHTML = pairsBlockHtml(tourPairs, ids, byId, groupLabelFn(gs, byId), groupPairNoteFn(gs));
      return;
    }
    tourPairs = tourPairs.filter(function (p) {
      return ids.indexOf(p[0]) >= 0 && ids.indexOf(p[1]) >= 0 &&
        (tourMixedPairs || divisionOf(byId, p[0]) === divisionOf(byId, p[1]));
    });
    el.innerHTML = pairsBlockHtml(tourPairs, ids, byId, divisionLabelFn(byId),
      pairNoteFn(byId, tourMixedPairs ? { mixedPairs: true } : null));
  }

  /* Why a tournament court is free: who is waiting, by division. */
  function tournamentFreeReason(lines) {
    var parts = [];
    divisionNames().forEach(function (n) {
      var ready = (lines[n] || []).filter(function (u) { return !u.waitingFor; });
      var count = ready.reduce(function (s, u) { return s + u.ids.length; }, 0);
      if (count) parts.push(Engine.divisionLabel(n) + ' ' + count);
    });
    if (!parts.length) return 'no one is waiting.';
    return 'waiting: ' + parts.join(', ') + '. A division needs 4 ready to fill a court.';
  }

  function renderActiveTournament(session) {
    if (Engine.groupPlay(session)) return renderActiveGroupTournament(session);
    var byId = playersById();
    var actives = Engine.activeGames(session);
    var finished = (session.games || []).filter(function (g) { return g.done; });
    var counts = Engine.sessionCounts(session);
    var fixed = Engine.fixedPairs(session);
    var pairCount = (session.pairs || []).length;
    var mixedOn = Engine.mixedPairs(session);

    // The line as units, one line per division. A pair of different levels
    // is in the higher partner's line when the host allows it; otherwise it
    // cannot be seated and is listed apart.
    var lines = {}, mixed = [];
    Engine.queueUnits(session, byId).forEach(function (u) {
      var cat = Engine.unitCategory(u, byId, session);
      if (cat === null) { mixed.push(u); return; }
      (lines[cat] = lines[cat] || []).push(u);
    });
    var onCourt = {};
    actives.forEach(function (g) {
      var cat = gameDivision(g, byId);
      onCourt[cat] = (onCourt[cat] || 0) + 4;
    });
    var divisions = divisionNames().filter(function (n) {
      return (lines[n] && lines[n].length) || onCourt[n] ||
        session.playerIds.some(function (id) { return Engine.playerDivision(session, byId, id) === n; });
    });
    var chip = function (u, band, label) { return waitChip(u, band, label, byId, counts, true); };

    var html = '<div class="session-bar">' +
      '<div><strong>Tournament</strong> &middot; ' + fmtDate(session.startedAt) +
      ' &middot; ' + session.playerIds.length + ' players &middot; ' + session.courtCount + ' courts</div>' +
      '<div class="session-bar-actions tour-actions">' +
      '<button class="btn small" data-action="manage-players">Players</button>' +
      '<button class="btn small" data-action="manage-partners">Partners' + (pairCount ? ' (' + pairCount + ')' : '') + '</button>' +
      '<button class="btn small' + (mixedOn ? ' on' : '') + '" data-action="toggle-mixed-pairs">Mixed-level pairs: ' +
      (mixedOn ? 'On' : 'Off') + '</button>' +
      '<button class="btn small" data-action="change-courts">Courts: ' + session.courtCount + '</button>' +
      undoButtonHtml(session) +
      '<button class="btn small danger-outline" data-action="end-session">End tournament</button>' +
      '</div></div>';

    html += '<div class="division-strip">' + divisions.map(function (n) {
      var ready = (lines[n] || []).filter(function (u) { return !u.waitingFor; });
      var waiting = ready.reduce(function (s, u) { return s + u.ids.length; }, 0);
      return '<span class="division-pill">' + esc(Engine.divisionLabel(n)) +
        ' <span class="muted">' + (onCourt[n] || 0) + ' on court &middot; ' + waiting + ' waiting</span></span>';
    }).join('') + '</div>';

    html += '<div class="courts-grid">';
    for (var c = 1; c <= session.courtCount; c++) {
      var g = null;
      actives.forEach(function (a) { if (a.court === c) g = a; });
      html += g
        ? renderActiveGameCard(g, byId, fixed, true, Engine.divisionLabel(gameDivision(g, byId)))
        : renderFreeCourtCard(c, 0, 0, tournamentFreeReason(lines));
    }
    html += closingCourtsHtml(actives, session, function (cg) {
      return renderActiveGameCard(cg, byId, fixed, true, Engine.divisionLabel(gameDivision(cg, byId)), null, true);
    });
    html += '</div>';

    divisions.forEach(function (n) {
      var all = lines[n] || [];
      var ready = all.filter(function (u) { return !u.waitingFor; });
      var held = all.filter(function (u) { return u.waitingFor; });
      var readyCount = ready.reduce(function (s, u) { return s + u.ids.length; }, 0);
      var bands = Engine.waitBands(ready);
      var stuck = readyCount > 0 && readyCount < 4 && !onCourt[n];
      html += '<div class="sitouts division-line">' +
        '<div class="division-line-head"><span class="sitout-label">' + esc(Engine.divisionLabel(n)) + '</span>' +
        (n ? ' <span class="muted">' + divisionRange(n) + '</span>' : '') +
        ' <span class="muted">&middot; ' + readyCount + ' waiting' +
        (stuck ? ', needs 4 for a court' : '') + '</span></div>' +
        (ready.length
          ? ready.map(function (u, i) { return chip(u, bands[i], (i + 1) + '.'); }).join(' ')
          : '<span class="muted">No one waiting.</span>') +
        (held.length
          ? '<div class="held-line"><span class="sitout-label">Held for a partner:</span> ' +
            held.map(function (u) { return chip(u, 'held', ''); }).join(' ') + '</div>'
          : '') +
        '</div>';
    });
    if (mixed.length) {
      html += '<div class="sitouts division-line"><span class="sitout-label">Cannot be seated:</span> ' +
        mixed.map(function (u) { return chip(u, 'held', ''); }).join(' ') +
        '<div class="muted small-note">These partners are now in different divisions. ' +
        'Split the pair (Partners) or change a level (Players tab).</div></div>';
    }
    html += '<div class="muted small-note tour-legend">' +
      '<span class="legend legend-red">Red</span> waited longest in their division &middot; ' +
      '<span class="legend legend-yellow">Yellow</span> next &middot; ' +
      '<span class="legend legend-green">Green</span> most recent to sit down or arrive. ' +
      'Time = how long they have been waiting; brackets = games played. ' +
      'Divisions never mix: a free court goes to the division of whoever has waited longest, once 4 of them are ready.' +
      (pairCount ? ' Fixed partners are one entry and go on together.' : '') +
      (mixedOn ? ' Mixed-level pairs are on: partners of different levels play as a pair in the higher partner\'s division.' : '') +
      '</div>';

    if (finished.length) {
      html += '<details class="round-past" open><summary>Finished games (' + finished.length + ')</summary>' +
        '<div class="finished-list">' +
        finished.slice().reverse().map(function (m) {
          return renderFinishedGameRow(m, byId, Engine.divisionLabel(gameDivision(m, byId)));
        }).join('') +
        '</div></details>';
    }

    var stats = Engine.computeStats([session]);
    var times = Engine.playTimes(session);
    Engine.tournamentDivisions(session, byId).forEach(function (d) {
      var board = leaderboardHtml(stats, byId, d.ids, times);
      if (board) html += '<div class="card"><h3>' + esc(d.label) + ' standings</h3>' + board + '</div>';
    });
    return html;
  }

  /* The live view of a two-group tournament: the scoreboard, the courts
     with each team's group, one waiting line per group, and a board per
     group. */
  function renderActiveGroupTournament(session) {
    var byId = playersById();
    var actives = Engine.activeGames(session);
    var finished = (session.games || []).filter(function (g) { return g.done; });
    var counts = Engine.sessionCounts(session);
    var fixed = Engine.fixedPairs(session);
    var pairCount = (session.pairs || []).length;
    var names = [Engine.groupLabel(session, 0), Engine.groupLabel(session, 1)];
    var tags = [groupTag(session, 0), groupTag(session, 1)];

    // One line per group. A pair now straddling the groups, or anyone with
    // no group yet, cannot be seated and is listed apart.
    var lines = [[], []], stranded = [];
    Engine.queueUnits(session, byId).forEach(function (u) {
      var g = Engine.unitGroup(session, u);
      if (g < 0) stranded.push(u); else lines[g].push(u);
    });
    var chip = function (u, band, label) { return waitChip(u, band, label, byId, counts, true); };
    var readyOf = function (g) { return lines[g].filter(function (u) { return !u.waitingFor; }); };
    var countOf = function (units) { return units.reduce(function (s, u) { return s + u.ids.length; }, 0); };

    var html = '<div class="session-bar">' +
      '<div><strong>Tournament</strong> &middot; ' + fmtDate(session.startedAt) +
      ' &middot; ' + session.playerIds.length + ' players &middot; ' + session.courtCount + ' courts</div>' +
      '<div class="session-bar-actions tour-actions">' +
      '<button class="btn small" data-action="manage-players">Players</button>' +
      '<button class="btn small" data-action="manage-partners">Partners' + (pairCount ? ' (' + pairCount + ')' : '') + '</button>' +
      '<button class="btn small" data-action="change-courts">Courts: ' + session.courtCount + '</button>' +
      undoButtonHtml(session) +
      '<button class="btn small danger-outline" data-action="end-session">End tournament</button>' +
      '</div></div>';

    html += scoreboardHtml(session, actives.length);

    var freeReason = 'waiting: ' + esc(names[0]) + ' ' + countOf(readyOf(0)) + ', ' + esc(names[1]) + ' ' + countOf(readyOf(1)) +
      '. A court needs 2 from each group.';
    html += '<div class="courts-grid">';
    for (var c = 1; c <= session.courtCount; c++) {
      var g = null;
      actives.forEach(function (a) { if (a.court === c) g = a; });
      html += g
        ? renderActiveGameCard(g, byId, fixed, true, null, tags)
        : renderFreeCourtCard(c, 0, 0, freeReason);
    }
    html += closingCourtsHtml(actives, session, function (cg) { return renderActiveGameCard(cg, byId, fixed, true, null, tags, true); });
    html += '</div>';

    [0, 1].forEach(function (gi) {
      var ready = readyOf(gi);
      var held = lines[gi].filter(function (u) { return u.waitingFor; });
      var readyCount = countOf(ready);
      var bands = Engine.waitBands(ready);
      html += '<div class="sitouts division-line group-line">' +
        '<div class="division-line-head"><span class="sitout-label">' + esc(names[gi]) + '</span> ' + tags[gi] +
        ' <span class="muted">&middot; ' + readyCount + ' waiting' +
        (readyCount > 0 && readyCount < 2 ? ', needs 2 for a court' : '') + '</span></div>' +
        (ready.length
          ? ready.map(function (u, i) { return chip(u, bands[i], (i + 1) + '.'); }).join(' ')
          : '<span class="muted">No one waiting.</span>') +
        (held.length
          ? '<div class="held-line"><span class="sitout-label">Held for a partner:</span> ' +
            held.map(function (u) { return chip(u, 'held', ''); }).join(' ') + '</div>'
          : '') +
        '</div>';
    });
    if (stranded.length) {
      html += '<div class="sitouts division-line"><span class="sitout-label">Cannot be seated:</span> ' +
        stranded.map(function (u) { return chip(u, 'held', ''); }).join(' ') +
        '<div class="muted small-note">A pair in two different groups, or someone with no group yet. ' +
        'Split the pair (Partners) or set their group (Players).</div></div>';
    }
    html += '<div class="muted small-note tour-legend">' +
      '<span class="legend legend-red">Red</span> waited longest in their group &middot; ' +
      '<span class="legend legend-yellow">Yellow</span> next &middot; ' +
      '<span class="legend legend-green">Green</span> most recent to sit down or arrive. ' +
      'Time = how long they have been waiting; brackets = games played. ' +
      'Every game is two from ' + esc(names[0]) + ' against two from ' + esc(names[1]) + ': nobody plays with or against their own group.' +
      (pairCount ? ' Fixed partners are one entry and go on together.' : '') +
      '</div>';

    if (finished.length) {
      html += '<details class="round-past" open><summary>Finished games (' + finished.length + ')</summary>' +
        '<div class="finished-list">' +
        finished.slice().reverse().map(function (m) { return renderFinishedGameRow(m, byId, null, tags); }).join('') +
        '</div></details>';
    }

    var stats = Engine.computeStats([session]);
    var times = Engine.playTimes(session);
    Engine.tournamentGroups(session).forEach(function (grp) {
      var board = leaderboardHtml(stats, byId, grp.ids, times);
      if (board) html += '<div class="card"><h3>' + esc(grp.label) + ' standings</h3>' + board + '</div>';
    });
    return html;
  }

  /* Games won by each group, with points, and who is ahead. */
  function scoreboardHtml(session, inProgress) {
    var score = Engine.groupScore(session);
    var names = [Engine.groupLabel(session, 0), Engine.groupLabel(session, 1)];
    var lead = score.wins[0] === score.wins[1]
      ? (score.games ? 'All square.' : 'No games scored yet.')
      : esc(names[score.wins[0] > score.wins[1] ? 0 : 1]) + ' leads by ' + Math.abs(score.wins[0] - score.wins[1]) + '.';
    var side = function (g) {
      return '<div class="score-side g' + g + '"><div class="score-name">' + esc(names[g]) + '</div>' +
        '<div class="score-num">' + score.wins[g] + '</div>' +
        '<div class="score-sub muted">' + score.points[g] + ' points</div></div>';
    };
    return '<div class="card scoreboard">' +
      '<div class="score-row">' + side(0) + '<div class="score-dash">&ndash;</div>' + side(1) + '</div>' +
      '<p class="score-note muted small-note">Games won. ' + lead + ' ' + score.games + (score.games === 1 ? ' game' : ' games') + ' scored' +
      (inProgress ? ', ' + inProgress + ' in progress' : '') + '.</p></div>';
  }

  /* ---------- Leaderboards ---------- */

  /* The board plus special mentions, ranked by the engine so this and the PDF
     can never disagree. Returns '' when there is nothing to show. `times`
     (Engine.playTimes) adds each player's average game time to their note. */
  function leaderboardHtml(stats, byId, restrictIds, times) {
    var board = Engine.rankStandings(stats, byId, restrictIds, times);
    if (!board.ranked.length && !board.mentions.length) return '';
    var html = '';

    if (board.ranked.length) {
      html += '<div class="table-wrap"><table class="lb">' +
        '<thead><tr><th>#</th><th>Player</th><th>GP</th><th>W</th><th>L</th><th>Win%</th><th>+/&minus;</th><th>Rating</th></tr></thead>' +
        '<tbody>' +
        board.ranked.map(function (r) {
          return '<tr class="' + (r.rank <= 3 ? 'podium-' + r.rank : '') + '" data-action="player-detail" data-player="' + r.id + '">' +
            '<td>' + r.rank + '</td>' +
            '<td class="td-name">' + esc(r.name) + '<span class="lb-note">' + esc(r.note) + '</span></td>' +
            '<td>' + r.games + '</td><td>' + r.wins + '</td><td>' + r.losses + '</td>' +
            '<td>' + Math.round(r.pct * 100) + '%</td>' +
            '<td>' + (r.diff > 0 ? '+' : '') + r.diff + '</td>' +
            '<td>' + r.rating + '</td></tr>';
        }).join('') +
        '</tbody></table></div>' +
        '<p class="muted small-note">Ranked by wins, then win rate, then point difference.' +
        (board.minGames > 1
          ? ' Minimum ' + board.minGames + ' games to rank &mdash; half of the ' + board.maxGames + ' the busiest player had.'
          : '') +
        '</p>';
    }

    if (board.mentions.length) {
      html += '<div class="mentions"><h4>Special mentions</h4>' +
        '<p class="muted small-note">Fewer than ' + board.minGames + ' games, so not ranked &mdash; but not forgotten.</p>' +
        board.mentions.map(function (r) {
          return '<div class="mention" data-action="player-detail" data-player="' + r.id + '">' +
            '<strong>' + esc(r.name) + '</strong> ' +
            '<span class="muted">' + r.wins + 'W&ndash;' + r.losses + 'L &middot; ' + r.games + (r.games === 1 ? ' game' : ' games') + '</span>' +
            '<div class="lb-note">' + esc(r.note) + '</div></div>';
        }).join('') +
        '</div>';
    }
    return html;
  }

  /* ---------- Players view ---------- */

  function renderPlayers() {
    var view = document.getElementById('view-players');
    var stats = Engine.computeStats(DB.sessions);
    var roster = DB.players.filter(function (p) { return !p.archived; });
    var archived = DB.players.filter(function (p) { return p.archived; });

    var skillOpts = skillOptions('3.5');

    var rows = roster.map(function (p) {
      var s = stats[p.id] || { games: 0, wins: 0, losses: 0 };
      return '<div class="player-row" data-action="player-detail" data-player="' + p.id + '">' +
        avatarHtml(p) +
        '<div class="player-main"><strong>' + esc(p.name) + '</strong>' +
        '<span class="muted">skill ' + skillText(p.skill) + ' &middot; rating ' + p.rating + ' &middot; ' +
        s.wins + 'W&ndash;' + s.losses + 'L</span></div>' +
        '<button class="btn small" data-action="edit-player" data-player="' + p.id + '">Edit</button>' +
        '</div>';
    }).join('');

    var archivedHtml = archived.length
      ? '<details class="archived-list"><summary>Archived players (' + archived.length + ')</summary>' +
        archived.map(function (p) {
          return '<div class="player-row"><div class="player-main">' + esc(p.name) + '</div>' +
            '<button class="btn small" data-action="unarchive-player" data-player="' + p.id + '">Restore</button></div>';
        }).join('') + '</details>'
      : '';

    view.innerHTML =
      '<div class="card"><h2>Add a player</h2>' +
      '<div class="add-player-form">' +
      '<input type="text" id="new-player-name" placeholder="Player name" maxlength="30">' +
      '<select id="new-player-skill" title="Skill level">' + skillOpts + '</select>' +
      '<button class="btn primary" data-action="add-player">Add</button>' +
      '</div><p class="muted small-note">Skill sets the starting rating; it adjusts automatically from results. ' +
      'Levels: ' + categoriesLine() + '.</p></div>' +
      '<div class="card"><h2>Roster (' + roster.length + ')</h2>' + rosterFilterHtml(roster.length) +
      (rows || '<p class="muted">No players yet.</p>') + archivedHtml + '</div>';
  }

  /* ---------- Stats view ---------- */

  function countDoneGames(session) {
    var n = 0;
    Engine.sessionMatches(session).forEach(function (m) { if (m.done) n++; });
    return n;
  }

  /* "Ann & Ben, Cal & Dee" for the session's fixed partners, or ''. */
  function pairsLine(session, byId) {
    return (session.pairs || []).map(function (p) {
      return (byId[p[0]] ? byId[p[0]].name : '?') + ' & ' + (byId[p[1]] ? byId[p[1]].name : '?');
    }).join(', ');
  }

  /* "today", "yesterday", "5 days ago", "3 weeks ago", "4 months ago". */
  function agoText(ms) {
    var days = Math.floor(ms / 86400000);
    if (days < 1) return 'today';
    if (days < 2) return 'yesterday';
    if (days < 14) return days + ' days ago';
    if (days < 60) return Math.floor(days / 7) + ' weeks ago';
    return Math.floor(days / 30) + ' months ago';
  }

  /* The data lives only on this device, so the backup's age matters. Stale
     means no backup in four weeks - or none at all once there is a second
     session to lose. */
  var BACKUP_STALE_MS = 28 * 86400000;

  function backupStale() {
    if (!DB.lastBackupAt) return DB.sessions.length >= 2;
    return Date.now() - DB.lastBackupAt > BACKUP_STALE_MS;
  }

  function backupNoteHtml() {
    var stale = backupStale();
    var text = DB.lastBackupAt
      ? 'Last backup: ' + fmtDate(DB.lastBackupAt) + ' (' + agoText(Date.now() - DB.lastBackupAt) + ').' +
        (stale ? ' It is getting old: export a fresh one.' : '')
      : 'No backup yet. Everything here lives only on this device, so export a backup now and then.';
    return '<p class="muted small-note backup-note' + (stale ? ' warn' : '') + '">' + text + '</p>';
  }

  /* The nudge on the end-of-session toast, or ''. */
  function backupNudge() {
    if (!backupStale()) return '';
    return DB.lastBackupAt
      ? ' Your last backup was ' + agoText(Date.now() - DB.lastBackupAt) + ': export one on the Stats tab.'
      : ' No backup yet: export one on the Stats tab.';
  }

  /* The all-time board can be narrowed to a period; the default shows
     everything, as before. */
  var statsPeriod = 'all';

  function periodSessions() {
    if (statsPeriod === 'all') return DB.sessions;
    var now = new Date(Date.now());
    var cutoff = statsPeriod === 'year'
      ? new Date(now.getFullYear(), 0, 1).getTime()
      : Date.now() - 30 * 86400000;
    return DB.sessions.filter(function (s) { return s.startedAt >= cutoff; });
  }

  function periodPickerHtml() {
    var opts = [['all', 'All time'], ['30', 'Last 30 days'], ['year', 'This year']];
    return '<div class="period-picker">' + opts.map(function (o) {
      return '<button class="period-opt' + (statsPeriod === o[0] ? ' selected' : '') + '" data-action="stats-period" data-period="' + o[0] + '">' + o[1] + '</button>';
    }).join('') + '</div>';
  }

  function renderStats() {
    var view = document.getElementById('view-stats');
    var byId = playersById();
    var period = periodSessions();
    var stats = Engine.computeStats(period);
    var board = leaderboardHtml(stats, byId);
    var heading = statsPeriod === 'all' ? 'All-time leaderboard'
      : statsPeriod === 'year' ? 'Leaderboard &middot; ' + new Date(Date.now()).getFullYear()
      : 'Leaderboard &middot; last 30 days';
    var none = statsPeriod === 'all'
      ? 'No games recorded yet. Finish some games in a session first.'
      : 'No games in this period.';

    var sessionsHtml = DB.sessions.slice().reverse().map(function (s) {
      return '<div class="player-row" data-action="session-detail" data-session="' + s.id + '">' +
        '<div class="player-main"><strong>' + fmtDate(s.startedAt) + '</strong>' +
        '<span class="muted">' + Engine.sessionParticipants(s).length + ' players &middot; ' +
        countDoneGames(s) + ' games' +
        (s.tournament ? (Engine.groupPlay(s) ? ' &middot; tournament, two groups' : ' &middot; tournament') : '') +
        (s.status === 'active' ? ' &middot; in progress' : '') + '</span></div>' +
        '<span class="chev">&rsaquo;</span></div>';
    }).join('');

    view.innerHTML =
      '<div class="card"><h2>' + heading + '</h2>' + periodPickerHtml() +
      (board || '<p class="muted">' + none + '</p>') +
      '<p class="muted small-note">Tap a player for their trend and history.</p></div>' +
      '<div class="card"><h2>Sessions (' + DB.sessions.length + ')</h2>' +
      (sessionsHtml || '<p class="muted">No sessions yet.</p>') + '</div>' +
      '<div class="card"><h2>Export &amp; backup</h2>' +
      '<p class="muted small-note">The PDF is a readable report you can share or print. ' +
      'The JSON backup is for restoring or moving your data to another device.</p>' +
      backupNoteHtml() +
      '<div class="setup-actions">' +
      '<button class="btn primary" data-action="export-pdf">Export report (PDF)</button>' +
      '<button class="btn" data-action="export-data">Export backup (JSON)</button>' +
      '<button class="btn" data-action="import-data">Import backup</button>' +
      '<input type="file" id="import-file" accept=".json,application/json" hidden>' +
      '</div></div>' +
      '<div class="card"><h2>Start over</h2>' +
      '<p class="muted small-note">For a new season. Export a backup first if you might want today\'s numbers back.</p>' +
      '<div class="setup-actions">' +
      '<button class="btn danger-outline" data-action="reset-progress">Reset sessions and stats</button>' +
      '<button class="btn danger-outline" data-action="reset-everything">Erase everything</button>' +
      '</div>' +
      '<p class="muted small-note">Reset keeps the roster: names and skill levels stay, every rating goes back to ' +
      'its starting value and all sessions are deleted. Erase removes the players too. ' +
      'Neither can be undone, and neither runs while a session is in progress.</p></div>';
  }

  /* ---------- Detail modals ---------- */

  function sparkline(history) {
    if (!history || history.length < 2) {
      return '<p class="muted">Rating trend appears after a few games.</p>';
    }
    var w = 320, h = 80, pad = 6;
    var rs = history.map(function (p) { return p.r; });
    var min = Math.min.apply(null, rs), max = Math.max.apply(null, rs);
    if (min === max) { min -= 10; max += 10; }
    var pts = history.map(function (p, i) {
      var x = pad + (i / (history.length - 1)) * (w - 2 * pad);
      var y = h - pad - ((p.r - min) / (max - min)) * (h - 2 * pad);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" class="spark" role="img" aria-label="Rating trend">' +
      '<polyline points="' + pts + '" fill="none" stroke="var(--accent)" stroke-width="3" stroke-linecap="round"/>' +
      '</svg><div class="spark-range muted">' + min + ' &ndash; ' + max + '</div>';
  }

  function showPlayerDetail(playerId) {
    var byId = playersById();
    var p = byId[playerId];
    if (!p) return;
    var all = Engine.computeStats(DB.sessions);
    var s = all[playerId] || { games: 0, wins: 0, losses: 0, pf: 0, pa: 0 };
    var pct = s.games ? Math.round(100 * s.wins / s.games) : 0;

    // Night by night, oldest first, with the rating they left each night on.
    var prog = Engine.playerProgression(p, DB.sessions);
    var change = p.rating - prog.start;
    var signed = function (d) { return (d < 0 ? '&minus;' : '+') + Math.abs(d); };
    var deltaHtml = function (d) {
      if (!d) return '<span class="muted">0</span>';
      return '<span class="' + (d > 0 ? 'delta-up' : 'delta-down') + '">' + signed(d) + '</span>';
    };
    var sessionsHtml = prog.rows.length
      ? '<div class="table-wrap"><table class="prog">' +
        '<thead><tr><th>Session</th><th>W&ndash;L</th><th>+/&minus;</th><th>Rating</th></tr></thead><tbody>' +
        '<tr><td class="muted">Start</td><td></td><td></td><td>' + prog.start + '</td></tr>' +
        prog.rows.map(function (r) {
          return '<tr><td>' + fmtDate(r.startedAt) + (r.active ? ' <span class="muted">(tonight)</span>' : '') + '</td>' +
            '<td>' + r.wins + '&ndash;' + r.losses + '</td>' +
            '<td>' + (r.diff > 0 ? '+' : '') + r.diff + '</td>' +
            '<td>' + r.ratingAfter + ' ' + deltaHtml(r.ratingChange) + '</td></tr>';
        }).join('') +
        '</tbody></table></div>'
      : '';

    openModal(
      '<div class="profile-head">' + avatarHtml(p, 'big') +
      '<div><h2>' + esc(p.name) + '</h2>' +
      '<p class="muted">Skill ' + skillText(p.skill) + ' &middot; Rating <strong>' + p.rating + '</strong>' +
      (prog.rows.length ? ' (' + signed(change) + ' since their first game)' : '') + '</p></div></div>' +
      levelHintHtml(p) +
      sparkline(p.ratingHistory) +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-num">' + s.games + '</div><div class="stat-lbl">Games</div></div>' +
      '<div class="stat-box"><div class="stat-num">' + s.wins + '&ndash;' + s.losses + '</div><div class="stat-lbl">W&ndash;L</div></div>' +
      '<div class="stat-box"><div class="stat-num">' + pct + '%</div><div class="stat-lbl">Win rate</div></div>' +
      '<div class="stat-box"><div class="stat-num">' + ((s.pf - s.pa) > 0 ? '+' : '') + (s.pf - s.pa) + '</div><div class="stat-lbl">Point diff</div></div>' +
      '</div>' +
      formHtml(playerId) +
      companionsHtml(playerId, byId) +
      (sessionsHtml ? '<h3>Progression by session</h3>' + sessionsHtml : '') +
      '<div class="modal-actions">' +
      '<button class="btn" data-action="edit-player" data-player="' + p.id + '">Edit</button>' +
      '<span class="spacer"></span>' +
      '<button class="btn" data-action="close-modal">Close</button></div>'
    );
  }

  /* When a player's rating has drifted two or more levels from the level
     they are listed at, say so; the host decides, from Edit. */
  function levelHintHtml(p) {
    var drift = Engine.levelDrift(p);
    if (!drift || Math.abs(drift.steps) < 2) return '';
    var session = activeSession();
    return '<p class="muted small-note level-hint">Their rating of ' + p.rating + ' sits closest to a ' + esc(drift.suggested) +
      ' level, ' + (drift.steps > 0 ? 'above' : 'below') + ' the listed ' + esc(p.skill) + '. ' +
      'If that matches what you see on court, update the level from Edit' +
      (session && session.tournament && !Engine.groupPlay(session) ? '; in a tournament by division that moves them from their next game' : '') +
      '.</p>';
  }

  /* A player's last five results, oldest first. Nothing until they have
     finished a game. */
  function formHtml(playerId) {
    var form = Engine.playerForm(playerId, DB.sessions, 5);
    if (!form.length) return '';
    return '<p class="form-line muted small-note">Last ' + (form.length === 1 ? 'game' : form.length + ' games') + ': ' +
      form.map(function (r) { return '<span class="form-' + r.toLowerCase() + '">' + r + '</span>'; }).join(' ') +
      (form.length > 1 ? ' <span class="muted">(oldest first)</span>' : '') + '</p>';
  }

  /* Who a player plays with and against most, with the record from their
     side. Nothing until they have finished a game. */
  function companionsHtml(playerId, byId) {
    var comp = Engine.playerCompanions(playerId, DB.sessions);
    if (!comp.partners.length && !comp.opponents.length) return '';
    var row = function (c) {
      return '<div class="comp-row"><span class="comp-name">' + esc(byId[c.id] ? byId[c.id].name : '?') + '</span>' +
        '<span class="muted">' + c.wins + '&ndash;' + c.losses + ' in ' + c.games + (c.games === 1 ? ' game' : ' games') + '</span></div>';
    };
    var col = function (label, list) {
      return list.length ? '<div><div class="comp-label">' + label + '</div>' + list.slice(0, 3).map(row).join('') + '</div>' : '';
    };
    return '<section class="companions"><h3>Partners &amp; opponents</h3><div class="comp-grid">' +
      col('Played most with', comp.partners) + col('Played most against', comp.opponents) +
      '</div></section>';
  }

  function showSessionDetail(sessionId) {
    var sess = null;
    DB.sessions.forEach(function (s) { if (s.id === sessionId) sess = s; });
    if (!sess) return;
    var byId = playersById();
    var stats = Engine.computeStats([sess]);
    var times = Engine.playTimes(sess);
    var groups = Engine.groupPlay(sess);
    var board;   // includes players who left early
    if (groups) {
      board = scoreboardHtml(sess, 0) + Engine.tournamentGroups(sess).map(function (grp) {
        var b = leaderboardHtml(stats, byId, grp.ids, times);
        return b ? '<h3>' + esc(grp.label) + '</h3>' + b : '';
      }).join('');
    } else if (sess.tournament) {
      board = Engine.tournamentDivisions(sess, byId).map(function (d) {
        var b = leaderboardHtml(stats, byId, d.ids, times);
        return b ? '<h3>' + esc(d.label) + '</h3>' + b : '';
      }).join('');
    } else {
      board = leaderboardHtml(stats, byId, null, times);
    }
    var partners = pairsLine(sess, byId);
    openModal(
      '<h2>' + (sess.tournament ? 'Tournament &middot; ' : '') + fmtDate(sess.startedAt) + '</h2>' +
      '<p class="muted">' + Engine.sessionParticipants(sess).length + ' players &middot; ' + countDoneGames(sess) + ' games' +
      (sess.status === 'active' ? ' &middot; in progress' : '') + '</p>' +
      nightNumbersHtml(sess, byId) +
      (partners ? '<p class="muted small-note">Fixed partners: ' + esc(partners) + '</p>' : '') +
      (sess.matchBySkill ? '<p class="muted small-note">Courts were matched by skill level.</p>' : '') +
      (groups ? '<p class="muted small-note">Two groups: every game was two from ' + esc(Engine.groupLabel(sess, 0)) +
        ' against two from ' + esc(Engine.groupLabel(sess, 1)) + '.</p>'
        : sess.tournament ? '<p class="muted small-note">Every game was played within one division.' +
        (sess.mixedPairs ? ' Partners of different levels were allowed; such a pair played in the higher partner\'s division.' : '') +
        '</p>' : '') +
      (board || '<p class="muted">No scored games in this session.</p>') +
      (sess.status === 'done' ? pastGamesHtml(sess, byId) : '') +
      '<div class="modal-actions">' +
      (board ? '<button class="btn" data-action="share-results" data-session="' + sess.id + '">Share results</button><span class="spacer"></span>' : '') +
      '<button class="btn" data-action="close-modal">Close</button></div>'
    );
  }

  function findSession(sessionId) {
    for (var i = 0; i < DB.sessions.length; i++) {
      if (DB.sessions[i].id === sessionId) return DB.sessions[i];
    }
    return null;
  }

  /* "Ann & Ben 11–7 Cat & Dee", plain names. */
  function resultLine(m, byId) {
    var team = function (ids) { return esc(ids.map(function (id) { return byId[id] ? byId[id].name : '?'; }).join(' & ')); };
    return team(m.teamA) + ' ' + m.scoreA + '&ndash;' + m.scoreB + ' ' + team(m.teamB);
  }

  /* The night in numbers, under a session's heading: the average and
     longest game from the clocks, and the closest result. Nothing until a
     game has been scored. */
  function nightNumbersHtml(sess, byId) {
    var sum = Engine.sessionSummary(sess);
    if (!sum.games) return '';
    var rows = [];
    if (sum.timed) {
      rows.push('Average game ' + Engine.fmtDuration(sum.avg));
      rows.push('Longest ' + Engine.fmtDuration(sum.longestMs) + ': ' + resultLine(sum.longest, byId));
    }
    if (sum.closest) rows.push('Closest: ' + resultLine(sum.closest, byId));
    if (sum.biggest && sum.biggest !== sum.closest) rows.push('Biggest win: ' + resultLine(sum.biggest, byId));
    if (sum.climber && byId[sum.climber.id]) {
      rows.push('Climber of the night: ' + esc(byId[sum.climber.id].name) + ' <span class="delta-up">+' + sum.climber.change + '</span>');
    }
    return '<ul class="muted small-note night-numbers">' + rows.map(function (r) { return '<li>' + r + '</li>'; }).join('') + '</ul>';
  }

  /* The recap as text: handed to the phone's share sheet when there is
     one, otherwise copied to the clipboard, otherwise shown to copy. The
     share sheet must be opened from the tap itself, so this runs straight
     from the click handler. */
  function shareResults(sessionId) {
    var sess = findSession(sessionId);
    if (!sess) return;
    var text = Engine.sessionRecap(sess, playersById(), fmtDate(sess.startedAt));
    var nav = window.navigator;
    if (nav.share) {
      nav.share({ title: 'ThursDink results', text: text }).then(function () { toast('Shared.'); }, function (err) {
        if (!err || err.name !== 'AbortError') showRecapText(text);   // cancelled: nothing to do
      });
      return;
    }
    if (nav.clipboard && nav.clipboard.writeText) {
      nav.clipboard.writeText(text).then(function () { toast('Results copied. Paste them into the group chat.'); },
        function () { showRecapText(text); });
      return;
    }
    showRecapText(text);
  }

  function showRecapText(text) {
    openModal(
      '<h2>Results</h2>' +
      '<p class="muted small-note">Copy the text below and paste it into the group chat.</p>' +
      '<textarea class="recap-text" readonly rows="14">' + esc(text) + '</textarea>' +
      '<div class="modal-actions">' +
      '<button class="btn" data-action="copy-recap">Copy</button><span class="spacer"></span>' +
      '<button class="btn" data-action="close-modal">Close</button></div>'
    );
    var ta = document.querySelector('.recap-text');
    if (ta) { ta.focus(); ta.select(); }
  }

  function copyRecap() {
    var ta = document.querySelector('.recap-text');
    if (!ta) return;
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand && document.execCommand('copy'); } catch (e) { ok = false; }
    toast(ok ? 'Copied.' : 'Select the text and copy it.');
  }

  function showEditPlayer(playerId) {
    var p = playersById()[playerId];
    if (!p) return;
    var skillOpts = skillOptions(p.skill);
    pendingPhoto = undefined;
    openModal(
      '<h2>Edit player</h2>' +
      '<div class="field"><label>Name</label>' +
      '<input type="text" id="edit-player-name" value="' + esc(p.name) + '" maxlength="30"></div>' +
      '<div class="field"><label>Skill level</label>' +
      '<select id="edit-player-skill">' + skillOpts + '</select></div>' +
      '<div class="field"><label>Photo</label>' +
      '<div class="photo-edit"><span id="edit-photo-preview">' + avatarHtml(p, 'big') + '</span>' +
      '<input type="file" id="edit-player-photo" accept="image/*" hidden>' +
      '<button class="btn small" data-action="pick-photo">' + (p.photo ? 'Change photo' : 'Add photo') + '</button>' +
      '<button class="btn small" data-action="remove-photo"' + (p.photo ? '' : ' hidden') + '>Remove</button></div>' +
      '<p class="muted small-note">Kept on this device only, shrunk to a small square.</p></div>' +
      '<div class="modal-actions">' +
      '<button class="btn danger-outline" data-action="archive-player" data-player="' + p.id + '">Archive</button>' +
      '<span class="spacer"></span>' +
      '<button class="btn" data-action="close-modal">Cancel</button>' +
      '<button class="btn primary" data-action="save-player" data-player="' + p.id + '">Save</button>' +
      '</div>' +
      '<p class="muted small-note">Archiving hides a player from new sessions; their history is kept.</p>'
    );
  }

  /* Groups as set in the Players modal of a two-group tournament, applied
     with the rest of the list. */
  var manageGroupOf = {};

  function showManagePlayers(session) {
    var roster = DB.players.filter(function (p) { return !p.archived || session.playerIds.indexOf(p.id) >= 0; });
    var groups = Engine.groupPlay(session);
    var names = [Engine.groupLabel(session, 0), Engine.groupLabel(session, 1)];
    manageGroupOf = {};
    if (groups) {
      roster.forEach(function (p) {
        var g = Engine.playerGroup(session, p.id);
        if (g >= 0) manageGroupOf[p.id] = g;
      });
    }
    var checks = roster.map(function (p) {
      var inSess = session.playerIds.indexOf(p.id) >= 0;
      return '<label class="check-row">' +
        '<input type="checkbox" class="manage-player" value="' + p.id + '"' + (inSess ? ' checked' : '') + '> ' +
        '<span class="check-name">' + esc(p.name) + '</span>' +
        '<span class="muted">' + skillText(p.skill) + '</span>' +
        (groups ? groupPickHtml(names, p.id, manageGroupOf[p.id], 'manage-group') : '') + '</label>';
    }).join('');
    openModal(
      '<h2>' + (session.tournament ? 'Tournament players' : 'Session players') + '</h2>' +
      '<p class="muted small-note">Check people in or out. Anyone mid-game finishes that game; ' +
      'checked-out players just get no new games. Checking out one half of a fixed pair splits the pair.' +
      (groups ? ' Everyone plays for their group - tap a group to move someone; a court needs 2 from each group. ' +
        'Moving one half of a fixed pair splits the pair.'
        : session.tournament ? ' Everyone plays in the division of their level' +
        (Engine.mixedPairs(session) ? ', or of their pair' : '') + '; a division needs 4 checked in to get a court.' : '') +
      '</p>' +
      '<div class="check-list">' + checks + '</div>' +
      '<div class="modal-actions">' +
      '<button class="btn" data-action="close-modal">Cancel</button>' +
      '<button class="btn primary" data-action="apply-manage-players">Apply</button>' +
      '</div>'
    );
  }

  /* Change how many courts are in use. A court that opens fills straight
     away from the waiting line; a court that closes finishes the game on
     it and gets no new one. */
  function showChangeCourts(session) {
    openModal(
      '<h2>Courts</h2>' +
      '<p class="muted small-note">How many courts are available right now. A court that opens fills straight away ' +
      'from the waiting line. A court that closes finishes the game already on it, and nothing new starts there.</p>' +
      '<div class="court-picker" id="courts-picker">' +
      [1, 2, 3, 4, 5, 6].map(function (n) {
        return '<button class="court-opt' + (n === session.courtCount ? ' selected' : '') + '" data-action="pick-courts" data-n="' + n + '">' + n + '</button>';
      }).join('') + '</div>' +
      '<div class="modal-actions"><button class="btn" data-action="close-modal">Cancel</button>' +
      '<button class="btn primary" data-action="apply-courts">Apply</button></div>'
    );
  }

  function applyCourts() {
    var session = activeSession();
    if (!session) return;
    var sel = document.querySelector('#courts-picker .court-opt.selected');
    if (!sel) return;
    var n = parseInt(sel.getAttribute('data-n'), 10);
    if (!(n >= 1 && n <= 6)) return;
    session.courtCount = n;
    var started = Engine.fillCourts(session, playersById());
    persist();
    closeModal();
    renderPlay();
    var closing = Engine.activeGames(session).filter(function (g) { return g.court > n; }).length;
    toast(n + (n === 1 ? ' court' : ' courts') + ' now.' +
      (started.length ? ' Court ' + started.map(function (g) { return g.court; }).join(' & ') + ': next game is up!' : '') +
      (closing ? ' ' + closing + (closing === 1 ? ' game finishes' : ' games finish') + ' on a closing court.' : ''));
  }

  function showPartners(session) {
    openModal(
      '<h2>Fixed partners</h2>' +
      '<p class="muted small-note">Partners play every game together and wait as one entry in the line. ' +
      'Changes apply from their next game; anyone mid-game finishes it first.</p>' +
      (Engine.groupPlay(session) ? '<p class="muted small-note">Partners must be in the same group.</p>'
        : session.tournament ? '<p class="muted small-note">' + (Engine.mixedPairs(session)
        ? 'Partners of different levels are allowed; such a pair plays in the higher partner\'s division. ' +
          'The Mixed-level pairs button on the Tournament tab turns this off.'
        : 'Both partners must be in the same division. The Mixed-level pairs button on the Tournament tab allows ' +
          'partners of different levels.') + '</p>' : '') +
      '<div id="session-pairs">' + sessionPairsHtml(session) + '</div>' +
      '<div class="modal-actions"><button class="btn" data-action="close-modal">Done</button></div>'
    );
  }

  function sessionPairsHtml(session) {
    var byId = playersById();
    if (Engine.groupPlay(session)) {
      return pairsBlockHtml(session.pairs || [], session.playerIds, byId, groupLabelFn(session, byId), groupPairNoteFn(session));
    }
    return pairsBlockHtml(session.pairs || [], session.playerIds, byId,
      session.tournament ? divisionLabelFn(byId) : null,
      session.tournament ? pairNoteFn(byId, session) : null);
  }

  function refreshPartners(session) {
    var el = document.getElementById('session-pairs');
    if (el) el.innerHTML = sessionPairsHtml(session);
  }

  function showEditMatchup(matchId) {
    var session = activeSession();
    if (!session) return;
    var m = findGame(session, matchId);
    if (!m || m.done) return;
    var byId = playersById();
    var fixed = Engine.fixedPairs(session);
    var groups = Engine.groupPlay(session);
    var names = groups ? [Engine.groupLabel(session, 0), Engine.groupLabel(session, 1)] : ['Team 1', 'Team 2'];
    // Anyone on this court plus anyone waiting; players on other courts stay put
    var eligible = m.teamA.concat(m.teamB, Engine.waitingPool(session))
      .filter(function (id) { return byId[id]; });
    // In a tournament only the court's own division is offered - by the
    // division each player plays in, so a partner playing up is included.
    var division = session.tournament && !groups ? gameDivision(m, byId) : null;
    if (division !== null) {
      eligible = eligible.filter(function (id) {
        return m.teamA.indexOf(id) >= 0 || m.teamB.indexOf(id) >= 0 || Engine.playerDivision(session, byId, id) === division;
      });
    }
    // In a two-group tournament each team is offered only its own group,
    // plus whoever is on that team now.
    var sides = [eligible, eligible];
    if (groups) {
      sides = [m.teamA, m.teamB].map(function (team, g) {
        return eligible.filter(function (id) { return team.indexOf(id) >= 0 || Engine.playerGroup(session, id) === g; });
      });
    }
    var pairNames = [], noted = {};
    eligible.forEach(function (id) {
      var p = fixed[id];
      if (p && !noted[id] && !noted[p]) {
        noted[id] = noted[p] = true;
        pairNames.push(esc(byId[id].name) + ' &amp; ' + esc(byId[p] ? byId[p].name : '?'));
      }
    });
    function slot(label, idx, selectedId) {
      var opts = sides[idx < 2 ? 0 : 1].map(function (id) {
        return '<option value="' + id + '"' + (id === selectedId ? ' selected' : '') + '>' +
          esc(byId[id].name) + '</option>';
      }).join('');
      return '<div class="field"><label>' + label + '</label>' +
        '<select class="matchup-slot" data-slot="' + idx + '">' + opts + '</select></div>';
    }
    openModal(
      '<h2>Edit matchup</h2>' +
      '<p class="muted small-note">Court ' + m.court + '. Pick from the four on court or anyone waiting; ' +
      'whoever you swap out goes back to the waiting list.' +
      (division !== null ? ' This is a ' + esc(Engine.divisionLabel(division)) + ' game, so only ' +
        esc(Engine.divisionLabel(division)) + ' players are offered.' : '') +
      (groups ? ' Each team is its group\'s, so each side is offered only its own group.' : '') + '</p>' +
      (pairNames.length
        ? '<p class="muted small-note">Fixed partners: ' + pairNames.join(', ') +
          '. Splitting them here applies to this game only.</p>'
        : '') +
      '<div class="matchup-grid">' +
      '<div class="matchup-team"><h3>' + esc(names[0]) + '</h3>' + slot('Player 1', 0, m.teamA[0]) + slot('Player 2', 1, m.teamA[1]) + '</div>' +
      '<div class="matchup-team"><h3>' + esc(names[1]) + '</h3>' + slot('Player 1', 2, m.teamB[0]) + slot('Player 2', 3, m.teamB[1]) + '</div>' +
      '</div>' +
      '<div class="modal-actions">' +
      '<button class="btn" data-action="close-modal">Cancel</button>' +
      '<button class="btn primary" data-action="save-matchup" data-match="' + m.id + '">Save matchup</button>' +
      '</div>'
    );
  }

  function saveMatchup(matchId) {
    var session = activeSession();
    if (!session) return;
    var m = findGame(session, matchId);
    if (!m || m.done) return;
    var ids = Array.prototype.slice.call(document.querySelectorAll('.matchup-slot'))
      .map(function (s) { return s.value; });
    var uniq = {};
    ids.forEach(function (id) { uniq[id] = true; });
    if (Object.keys(uniq).length !== 4) { toast('Pick 4 different players.'); return; }
    if (Engine.groupPlay(session)) {
      // Each team is its group's. Whoever is on a team now may stay there.
      var outsideGroup = [0, 1].filter(function (g) {
        var team = g ? m.teamB : m.teamA;
        return ids.slice(g * 2, g * 2 + 2).some(function (id) {
          return team.indexOf(id) < 0 && Engine.playerGroup(session, id) !== g;
        });
      });
      if (outsideGroup.length) {
        toast('Team 1 must be ' + Engine.groupLabel(session, 0) + ' players and Team 2 ' + Engine.groupLabel(session, 1) +
          ' players: this is a two-group tournament.');
        return;
      }
    } else if (session.tournament) {
      // Nobody from another division may be brought in. The four already on
      // the court were seated by the rules, so they can always stay.
      var byId = playersById();
      var division = gameDivision(m, byId);
      var already = m.teamA.concat(m.teamB);
      var outside = ids.filter(function (id) {
        return already.indexOf(id) < 0 && Engine.playerDivision(session, byId, id) !== division;
      });
      if (outside.length) {
        toast('All four must be ' + Engine.divisionLabel(division) + ' players: this is a tournament game.');
        return;
      }
    }
    m.teamA = [ids[0], ids[1]];
    m.teamB = [ids[2], ids[3]];
    persist();
    closeModal();
    renderPlay();
    toast('Court ' + m.court + ' matchup updated.');
  }

  function showEditFinished(matchId) {
    var session = activeSession();
    if (!session) return;
    var m = findGame(session, matchId);
    if (!m || !m.done) return;
    var byId = playersById();
    openModal(
      '<h2>Edit score</h2>' +
      '<p class="muted">Court ' + m.court + '</p>' +
      '<div class="field"><label>' + teamNames(m.teamA, byId) + '</label>' +
      '<input type="number" id="edit-score-a" inputmode="numeric" min="0" max="99" value="' + m.scoreA + '"></div>' +
      '<div class="field"><label>' + teamNames(m.teamB, byId) + '</label>' +
      '<input type="number" id="edit-score-b" inputmode="numeric" min="0" max="99" value="' + m.scoreB + '"></div>' +
      '<div class="modal-actions">' +
      '<button class="btn" data-action="close-modal">Cancel</button>' +
      '<button class="btn primary" data-action="save-finished" data-match="' + m.id + '">Save</button>' +
      '</div>'
    );
  }

  /* ---------- Actions ---------- */

  function addPlayer() {
    var nameEl = document.getElementById('new-player-name');
    var name = nameEl.value.trim();
    var skill = document.getElementById('new-player-skill').value;
    if (!name) { toast('Enter a name first.'); nameEl.focus(); return; }
    var dup = DB.players.some(function (p) {
      return !p.archived && p.name.toLowerCase() === name.toLowerCase();
    });
    if (dup) { toast('There is already a player named ' + name + '.'); return; }
    DB.players.push({
      id: Storage_.newId(),
      name: name,
      skill: skill,
      rating: Engine.initialRating(skill),
      ratingHistory: [],
      archived: false,
      createdAt: Date.now()
    });
    persist();
    renderPlayers();
    renderPlay();
    toast(name + ' added.');
    var el = document.getElementById('new-player-name');
    if (el) { el.value = ''; el.focus(); }
  }

  function startSession() {
    var courts = 2;
    var sel = document.querySelector('#view-play .court-opt.selected');
    if (sel) courts = parseInt(sel.getAttribute('data-n'), 10);
    var ids = Array.prototype.slice.call(document.querySelectorAll('.setup-player:checked'))
      .map(function (el) { return el.value; });
    if (ids.length < 4) { toast('Pick at least 4 players.'); return; }
    var session = {
      id: Storage_.newId(),
      startedAt: Date.now(),
      endedAt: null,
      courtCount: courts,
      playerIds: ids,
      playerMeta: {},
      pairs: setupPairs.filter(function (p) { return ids.indexOf(p[0]) >= 0 && ids.indexOf(p[1]) >= 0; }),
      matchBySkill: !!(document.getElementById('setup-skill-match') && document.getElementById('setup-skill-match').checked),
      games: [],
      nextSeq: 1,
      status: 'active'
    };
    var started = Engine.fillCourts(session, playersById());
    if (!started.length) { toast('Could not build a game.'); return; }
    DB.sessions.push(session);
    setupPairs = [];
    persist();
    renderPlay();
    toast('Session started — games are up on ' + started.length + ' court(s).');
  }

  function startTournament() {
    var courts = 2;
    var sel = document.querySelector('#view-tournament .court-opt.selected');
    if (sel) courts = parseInt(sel.getAttribute('data-n'), 10);
    var ids = checkedTournamentIds();
    if (ids.length < 4) { toast('Pick at least 4 players.'); return; }
    var byId = playersById();
    if (tourFormat === 'groups') { startGroupTournament(courts, ids, byId); return; }
    var of = setupDivisions(ids, byId);
    var per = {};
    ids.forEach(function (id) { var d = of[id]; per[d] = (per[d] || 0) + 1; });
    var playable = Object.keys(per).filter(function (d) { return per[d] >= 4; });
    if (!playable.length) { toast('No division has 4 players checked in, so no game can start.'); return; }
    var short = divisionNames().filter(function (d) { return per[d] && per[d] < 4; });
    if (short.length) {
      var who = short.map(function (d) {
        return Engine.divisionLabel(d) + ' has only ' + per[d] + (per[d] === 1 ? ' player' : ' players');
      }).join(', ');
      if (!confirm(who + ' checked in. A division needs 4 to get a court, so they will not get a game ' +
        'unless more arrive or a level is changed. Start anyway?')) return;
    }
    var session = {
      id: Storage_.newId(),
      startedAt: Date.now(),
      endedAt: null,
      courtCount: courts,
      playerIds: ids,
      playerMeta: {},
      pairs: tourPairs.filter(function (p) {
        return ids.indexOf(p[0]) >= 0 && ids.indexOf(p[1]) >= 0 &&
          (tourMixedPairs || divisionOf(byId, p[0]) === divisionOf(byId, p[1]));
      }),
      matchBySkill: false,
      tournament: true,
      mixedPairs: tourMixedPairs,
      games: [],
      nextSeq: 1,
      status: 'active'
    };
    var started = Engine.fillCourts(session, byId);
    if (!started.length) { toast('Could not build a game.'); return; }
    DB.sessions.push(session);
    resetTournamentSetup();
    persist();
    renderPlay();
    setTab('tournament');
    toast('Tournament started — games are up on ' + started.length + ' court(s).');
  }

  /* A two-group tournament. Everyone checked in needs a group and each
     group needs two; uneven groups are confirmed, since the smaller one
     will play more often. */
  function startGroupTournament(courts, ids, byId) {
    var names = groupNames();
    var of = {}, per = [0, 0], missing = [];
    ids.forEach(function (id) {
      var g = tourGroupOf[id];
      if (g === 0 || g === 1) { of[id] = g; per[g]++; } else missing.push(id);
    });
    if (missing.length) {
      toast('Pick a group for ' + missing.map(function (id) { return byId[id] ? byId[id].name : '?'; }).join(', ') +
        ', or tap Auto-split.');
      return;
    }
    if (per[0] < 2 || per[1] < 2) {
      toast('A court needs 2 from each group. ' + names[0] + ' has ' + per[0] + ' and ' + names[1] + ' has ' + per[1] + ' checked in.');
      return;
    }
    if (per[0] !== per[1] && !confirm(names[0] + ' has ' + per[0] + ' players and ' + names[1] + ' has ' + per[1] +
      '. The smaller group will play more often. Start anyway?')) return;
    var session = {
      id: Storage_.newId(),
      startedAt: Date.now(),
      endedAt: null,
      courtCount: courts,
      playerIds: ids,
      playerMeta: {},
      pairs: tourPairs.filter(function (p) {
        return ids.indexOf(p[0]) >= 0 && ids.indexOf(p[1]) >= 0 && of[p[0]] === of[p[1]];
      }),
      matchBySkill: false,
      tournament: true,
      mixedPairs: false,
      groups: { names: names, of: of },
      games: [],
      nextSeq: 1,
      status: 'active'
    };
    var started = Engine.fillCourts(session, byId);
    if (!started.length) { toast('Could not build a game.'); return; }
    DB.sessions.push(session);
    resetTournamentSetup();
    persist();
    renderPlay();
    setTab('tournament');
    toast('Tournament started — games are up on ' + started.length + ' court(s).');
  }

  function findGame(session, matchId) {
    var games = session.games || [];
    for (var i = 0; i < games.length; i++) {
      if (games[i].id === matchId) return games[i];
    }
    return null;
  }

  function collectScore(matchId, side) {
    var input = document.querySelector('.score-input[data-match="' + matchId + '"][data-side="' + side + '"]');
    if (!input) return null;
    var v = parseInt(input.value, 10);
    return isNaN(v) ? null : v;
  }

  /* The scoring rule lives in the engine; this just surfaces it. The group
     plays first to 11 straight up, so 11-10 is a result and anything under
     or over 11 is refused outright. */
  function validScores(a, b) {
    var check = Engine.checkScore(a, b);
    if (!check.ok) { toast(check.error); return false; }
    return true;
  }

  function saveScore(matchId) {
    var session = activeSession();
    if (!session) return;
    var m = findGame(session, matchId);
    if (!m || m.done) return;
    var a = collectScore(matchId, 'A');
    var b = collectScore(matchId, 'B');
    if (!validScores(a, b)) return;
    Engine.completeGame(m, a, b);   // also stamps finishedAt, which the wait order runs on
    var byId = playersById();
    m.ratingDeltas = Engine.computeRatingDeltas(m, byId);
    Engine.applyDeltas(m.ratingDeltas, byId, 1);
    var started = Engine.fillCourts(session, byId);
    persist();
    lastUndo = { sessionId: session.id, gameId: m.id, startedIds: started.map(function (g) { return g.id; }) };
    renderPlay();
    if (started.length) {
      toast('Court ' + started.map(function (g) { return g.court; }).join(' & ') + ': next game is up!');
    }
  }

  function saveFinished(matchId) {
    var session = activeSession();
    if (!session) return;
    var m = findGame(session, matchId);
    if (!m || !m.done) return;
    var a = parseInt(document.getElementById('edit-score-a').value, 10);
    var b = parseInt(document.getElementById('edit-score-b').value, 10);
    if (isNaN(a)) a = null;
    if (isNaN(b)) b = null;
    if (!validScores(a, b)) return;
    var byId = playersById();
    if (m.ratingDeltas) Engine.applyDeltas(m.ratingDeltas, byId, -1);
    m.scoreA = a;
    m.scoreB = b;
    m.ratingDeltas = Engine.computeRatingDeltas(m, byId);
    Engine.applyDeltas(m.ratingDeltas, byId, 1);
    persist();
    closeModal();
    renderPlay();
    toast('Score updated.');
  }

  function reshuffleGame(matchId) {
    var session = activeSession();
    if (!session) return;
    var m = findGame(session, matchId);
    if (!m || m.done) return;
    session.games = session.games.filter(function (g) { return g.id !== matchId; });
    Engine.fillCourts(session, playersById());
    persist();
    renderPlay();
  }

  function applyManagePlayers() {
    var session = activeSession();
    if (!session) return;
    var ids = Array.prototype.slice.call(document.querySelectorAll('.manage-player:checked'))
      .map(function (el) { return el.value; });
    if (ids.length < 4) { toast('A session needs at least 4 players.'); return; }
    var byId = playersById();
    var groups = Engine.groupPlay(session);
    if (groups) {
      // Everyone checked in to a two-group tournament needs a group.
      var missing = ids.filter(function (id) { return manageGroupOf[id] !== 0 && manageGroupOf[id] !== 1; });
      if (missing.length) {
        toast('Pick a group for ' + missing.map(function (id) { return byId[id] ? byId[id].name : '?'; }).join(', ') + '.');
        return;
      }
    }
    // The engine credits newcomers with the lightest current load and clocks
    // their wait from now, so they join the back of the line rather than
    // jumping people who were already waiting. A pair is dissolved when
    // either half is checked out.
    var pairsBefore = (session.pairs || []).length;
    Engine.setSessionPlayers(session, ids);
    if (groups) {
      // Groups as set in the modal; a pair pulled apart by a move is split.
      ids.forEach(function (id) { session.groups.of[id] = manageGroupOf[id]; });
      (session.pairs || []).slice().forEach(function (p) {
        if (Engine.unitGroup(session, { ids: p }) < 0) Engine.clearPair(session, p[0]);
      });
    }
    var split = pairsBefore - (session.pairs || []).length;
    var started = Engine.fillCourts(session, byId);
    persist();
    closeModal();
    renderPlay();
    var msg = started.length ? 'Players updated — a free court just filled!' : 'Player list updated.';
    if (split) msg += ' ' + split + (split === 1 ? ' fixed pair was' : ' fixed pairs were') + ' split.';
    toast(msg);
  }

  /* `box` is the pairs block the button sits in: the session setup, the
     tournament setup, or the in-session modal. Both setups are on the page
     at once, so the pickers are read from the block, not the document. */
  function addPair(box) {
    var picks = Array.prototype.slice.call((box || document).querySelectorAll('.pair-pick'))
      .map(function (s) { return s.value; });
    var a = picks[0], b = picks[1];
    if (!a || !b) { toast('Pick two players.'); return; }
    if (a === b) { toast('Pick two different players.'); return; }
    var session = activeSession();
    var byId = playersById();
    if (!session) {
      if (box && box.id === 'tsetup-pairs') {
        if (tourFormat === 'groups') {
          var ga = tourGroupOf[a], gb = tourGroupOf[b];
          if ((ga !== 0 && ga !== 1) || (gb !== 0 && gb !== 1)) { toast('Put both players in a group first.'); return; }
          if (ga !== gb) { toast('In a group tournament, partners must be in the same group.'); return; }
        } else if (!tourMixedPairs && divisionOf(byId, a) !== divisionOf(byId, b)) {
          toast('In a tournament, partners must be in the same division. ' +
            'Tick "Allow partners of different levels" to allow this pair.');
          return;
        }
        tourPairs.push([a, b]);
        renderTournamentPairs();
        updateTournamentCounts();   // a partner playing up is counted where they will play
      } else {
        setupPairs.push([a, b]);
        renderSetupPairs();
      }
      return;
    }
    var r = Engine.setPair(session, a, b, byId);
    if (!r.ok) { toast(r.error); return; }
    persist();
    refreshPartners(session);
    renderPlay();
    toast(byId[a].name + ' & ' + byId[b].name + ' will play together from their next game.');
  }

  function removePair(playerId, box) {
    var session = activeSession();
    if (!session) {
      if (box && box.id === 'tsetup-pairs') {
        tourPairs = tourPairs.filter(function (p) { return p[0] !== playerId && p[1] !== playerId; });
        renderTournamentPairs();
        updateTournamentCounts();
      } else {
        setupPairs = setupPairs.filter(function (p) { return p[0] !== playerId && p[1] !== playerId; });
        renderSetupPairs();
      }
      return;
    }
    Engine.clearPair(session, playerId);
    // Someone held back for a partner still on court may now be free to play.
    var started = Engine.fillCourts(session, playersById());
    persist();
    refreshPartners(session);
    renderPlay();
    toast('Pair split.' + (started.length ? ' A free court just filled.' : ''));
  }

  /* Flip match by skill for the running session. Games in progress are not
     touched; the next court to free up is built the new way. */
  function toggleSkillMatch() {
    var session = activeSession();
    if (!session) return;
    session.matchBySkill = !session.matchBySkill;
    persist();
    renderPlay();
    toast(session.matchBySkill
      ? 'Match by skill is on. From the next game, courts are made of players close in rating.'
      : 'Match by skill is off. Longest wait first, as before.');
  }

  /* Flip mixed-level pairs for the running tournament. Turning it off splits
     any pair of different levels, after asking, since such a pair could no
     longer be seated. Games in progress are not touched either way. */
  function toggleMixedPairs() {
    var session = activeSession();
    if (!session || !session.tournament || Engine.groupPlay(session)) return;
    var byId = playersById();
    var name = function (id) { return byId[id] ? byId[id].name : '?'; };
    if (session.mixedPairs) {
      var mixed = (session.pairs || []).filter(function (p) { return divisionOf(byId, p[0]) !== divisionOf(byId, p[1]); });
      if (mixed.length) {
        var who = mixed.map(function (p) { return name(p[0]) + ' & ' + name(p[1]); }).join(', ');
        if (!confirm('Turning this off splits ' + (mixed.length === 1 ? 'the pair ' : mixed.length + ' pairs: ') + who +
          ', since partners must then be in the same division. Continue?')) return;
        mixed.forEach(function (p) { Engine.clearPair(session, p[0]); });
      }
      session.mixedPairs = false;
    } else {
      session.mixedPairs = true;
    }
    // A pair that could not be seated may now fit; split partners are singles.
    var started = Engine.fillCourts(session, byId);
    persist();
    renderPlay();
    toast((session.mixedPairs
      ? 'Mixed-level pairs are on. Partners of different levels play as a pair in the higher partner\'s division.'
      : 'Mixed-level pairs are off. Partners must be in the same division.') +
      (started.length ? ' A free court just filled.' : ''));
  }

  function endSession() {
    var session = activeSession();
    if (!session) return;
    var unscored = Engine.activeGames(session).length;
    var what = session.tournament ? 'tournament' : 'session';
    var msg = 'End this ' + what + '?' + (unscored ? ' ' + unscored + ' game(s) in progress have no score and will not count.' : '');
    if (!confirm(msg)) return;
    session.games = (session.games || []).filter(function (g) { return g.done; });
    session.status = 'done';
    session.endedAt = Date.now();
    persist();
    releaseScreen();
    renderPlay();
    renderStats();
    showSessionDetail(session.id);
    toast((session.tournament ? 'Tournament saved.' : 'Session saved.') + backupNudge());
  }

  function savePlayer(playerId) {
    var byId = playersById();
    var p = byId[playerId];
    if (!p) return;
    var name = document.getElementById('edit-player-name').value.trim();
    var skill = document.getElementById('edit-player-skill').value;
    if (!name) { toast('Name cannot be empty.'); return; }
    p.name = name;
    var hadGames = (Engine.computeStats(DB.sessions)[playerId] || { games: 0 }).games > 0;
    var moved = '';
    if (skill !== p.skill) {
      var fromDivision = Engine.skillCategory(p.skill);
      p.skill = skill;
      if (!hadGames) p.rating = Engine.initialRating(skill);
      moved = tournamentLevelChange(playerId, fromDivision, byId);
    }
    var prevPhoto = p.photo, newPhoto = pendingPhoto;
    pendingPhoto = undefined;
    if (newPhoto === null) delete p.photo;
    else if (newPhoto) p.photo = newPhoto;
    var saved = persist();
    if (!saved && newPhoto) {
      // The one thing that can push the store over the device's limit is a
      // photo. Keep the rest of the edit and leave the photo out.
      if (prevPhoto) p.photo = prevPhoto; else delete p.photo;
      persist();
      closeModal();
      renderAll();
      toast('Saved, but the photo did not fit: this device\'s storage is full. Try removing other photos.');
      return;
    }
    closeModal();
    renderAll();
    toast('Saved.' + moved);
  }

  /* A level edited during a tournament can move a player to another
     division. Their line changes from now; a game in progress finishes as
     it is. A fixed pair that would now straddle two divisions is split -
     unless mixed-level pairs are allowed, when the pair simply plays in the
     higher partner's division from here on. In a two-group tournament a
     level moves nobody. */
  function tournamentLevelChange(playerId, fromDivision, byId) {
    var session = activeSession();
    if (!session || !session.tournament || Engine.groupPlay(session) || session.playerIds.indexOf(playerId) < 0) return '';
    var toDivision = divisionOf(byId, playerId);
    if (toDivision === fromDivision) return '';
    var note = ' ' + byId[playerId].name + ' now plays in the ' + Engine.divisionLabel(toDivision) + ' division.';
    var partner = Engine.fixedPairs(session)[playerId];
    if (partner && divisionOf(byId, partner) !== toDivision) {
      if (Engine.mixedPairs(session)) {
        note = ' ' + byId[playerId].name + ' and ' + (byId[partner] ? byId[partner].name : '?') +
          ' now play as a pair in the ' + Engine.divisionLabel(Engine.playerDivision(session, byId, playerId)) + ' division.';
      } else {
        Engine.clearPair(session, playerId);
        note += ' Their fixed pair was split: partners must be in the same division.';
      }
    }
    if (Engine.fillCourts(session, byId).length) note += ' A free court just filled.';
    return note;
  }

  /* The photo chosen in the edit modal, held until Save: undefined leaves
     it as it is, null removes it, a string is the new (shrunk) picture. */
  var pendingPhoto;

  function pickPhoto() {
    var input = document.getElementById('edit-player-photo');
    if (input) input.click();
  }

  function photoChosen(input) {
    var file = input.files && input.files[0];
    if (!file) return;
    shrinkPhoto(file, function (dataUrl, err) {
      input.value = '';
      if (err) { toast(err); return; }
      pendingPhoto = dataUrl;
      var preview = document.getElementById('edit-photo-preview');
      if (preview) preview.innerHTML = avatarHtml({ name: '', photo: dataUrl }, 'big');
      var pick = document.querySelector('[data-action="pick-photo"]');
      if (pick) pick.textContent = 'Change photo';
      var rm = document.querySelector('[data-action="remove-photo"]');
      if (rm) rm.hidden = false;
    });
  }

  function removePhoto() {
    pendingPhoto = null;
    var nameEl = document.getElementById('edit-player-name');
    var preview = document.getElementById('edit-photo-preview');
    if (preview) preview.innerHTML = avatarHtml({ name: nameEl ? nameEl.value : '' }, 'big');
    var pick = document.querySelector('[data-action="pick-photo"]');
    if (pick) pick.textContent = 'Add photo';
    var rm = document.querySelector('[data-action="remove-photo"]');
    if (rm) rm.hidden = true;
  }

  function archivePlayer(playerId) {
    var p = playersById()[playerId];
    if (!p) return;
    var session = activeSession();
    if (session && session.playerIds.indexOf(playerId) >= 0) {
      toast(session.tournament
        ? 'Remove them from the running tournament first (Tournament tab → Players).'
        : 'Remove them from the running session first (Play tab → Players).');
      return;
    }
    if (!confirm('Archive ' + p.name + '? Their stats and history are kept.')) return;
    p.archived = true;
    persist();
    closeModal();
    renderAll();
  }

  /* Both resets refuse while a session is running: ending it is a separate,
     visible step, and the Play tab should never change under someone's
     hands. Each asks once, with the numbers it is about to delete. */
  function resetProgress() {
    if (activeSession()) { toast(endFirstMessage()); return; }
    var n = DB.sessions.length;
    if (!confirm('Delete all ' + n + ' session(s) and put every player back to their starting rating, ' +
      'with no history? Names and skill levels are kept. This cannot be undone.')) return;
    var r = Engine.resetProgress(DB);
    persist();
    closeModal();
    renderAll();
    toast(r.sessions + ' session(s) deleted. ' + r.players + ' player(s) back to their starting rating.');
  }

  function resetEverything() {
    if (activeSession()) { toast(endFirstMessage()); return; }
    if (!confirm('Erase everything: ' + DB.players.length + ' player(s) and ' + DB.sessions.length +
      ' session(s)? This cannot be undone. Export a backup first if you might want it back.')) return;
    DB = Storage_.defaultData();
    persist();
    closeModal();
    renderAll();
    toast('All data erased.');
  }

  function importData() {
    var input = document.getElementById('import-file');
    input.onchange = function () {
      var file = input.files && input.files[0];
      if (!file) return;
      Storage_.importJson(file, function (data, err) {
        if (err) { toast(err); return; }
        if (!confirm('Replace ALL current data with the contents of "' + file.name + '"? This cannot be undone.')) return;
        DB = data;
        DB.sessions.forEach(function (s) {
          Engine.migrateSession(s);
          Engine.normalizeSession(s);
        });
        persist();
        renderAll();
        toast('Data imported.');
      });
      input.value = '';
    };
    input.click();
  }

  /* ---------- Event wiring ---------- */

  function setTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    document.querySelectorAll('.view').forEach(function (v) {
      v.classList.toggle('active', v.id === 'view-' + tab);
    });
    window.scrollTo(0, 0);
  }

  function updateSetupCount() {
    var el = document.getElementById('setup-count');
    if (!el) return;
    var n = document.querySelectorAll('.setup-player:checked').length;
    el.textContent = '(' + n + ' selected)';
  }

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-action]');
    if (!t) return;
    var action = t.getAttribute('data-action');
    switch (action) {
      case 'goto-players': setTab('players'); break;
      case 'goto-play': setTab('play'); break;
      case 'goto-tournament': setTab('tournament'); break;
      case 'pick-courts': {
        // Each setup screen has its own picker; only this one changes.
        var picker = t.closest('.court-picker') || document;
        picker.querySelectorAll('.court-opt').forEach(function (b) { b.classList.remove('selected'); });
        t.classList.add('selected');
        break;
      }
      case 'tsetup-all':
      case 'tsetup-none':
        visibleChecks('.tsetup-player').forEach(function (c) { c.checked = action === 'tsetup-all'; });
        updateTournamentCounts();
        renderTournamentPairs();
        break;
      case 'start-tournament': startTournament(); break;
      case 'tsetup-format': setTournamentFormat(t.getAttribute('data-format')); break;
      case 'tsetup-group':
        e.preventDefault();   // the switch sits in the check-in label: do not toggle the box
        setSetupGroup(t.getAttribute('data-player'), parseInt(t.getAttribute('data-group'), 10));
        break;
      case 'tsetup-autosplit': autoSplitGroups(); break;
      case 'manage-group': {
        e.preventDefault();
        manageGroupOf[t.getAttribute('data-player')] = parseInt(t.getAttribute('data-group'), 10);
        var pick = t.closest('.group-pick');
        if (pick) pick.querySelectorAll('.grp-opt').forEach(function (b) { b.classList.toggle('selected', b === t); });
        break;
      }
      case 'setup-all':
      case 'setup-none':
        visibleChecks('.setup-player').forEach(function (c) { c.checked = action === 'setup-all'; });
        updateSetupCount();
        renderSetupPairs();
        break;
      case 'start-session': startSession(); break;
      case 'score-step': {
        var input = document.querySelector('.score-input[data-match="' + t.getAttribute('data-match') +
          '"][data-side="' + t.getAttribute('data-side') + '"]');
        if (input) {
          var v = parseInt(input.value, 10);
          if (isNaN(v)) v = 0; else v += parseInt(t.getAttribute('data-d'), 10);
          input.value = Math.max(0, Math.min(99, v));
        }
        break;
      }
      case 'save-score': saveScore(t.getAttribute('data-match')); break;
      case 'reshuffle-game': reshuffleGame(t.getAttribute('data-match')); break;
      case 'edit-matchup': showEditMatchup(t.getAttribute('data-match')); break;
      case 'save-matchup': saveMatchup(t.getAttribute('data-match')); break;
      case 'edit-finished': showEditFinished(t.getAttribute('data-match')); break;
      case 'save-finished': saveFinished(t.getAttribute('data-match')); break;
      case 'manage-players': { var s = activeSession(); if (s) showManagePlayers(s); break; }
      case 'apply-manage-players': applyManagePlayers(); break;
      case 'manage-partners': { var ps = activeSession(); if (ps) showPartners(ps); break; }
      case 'add-pair': addPair(t.closest('#setup-pairs, #session-pairs, #tsetup-pairs')); break;
      case 'remove-pair':
        removePair(t.getAttribute('data-player'), t.closest('#setup-pairs, #session-pairs, #tsetup-pairs'));
        break;
      case 'toggle-skill-match': toggleSkillMatch(); break;
      case 'toggle-mixed-pairs': toggleMixedPairs(); break;
      case 'end-session': endSession(); break;
      case 'add-player': addPlayer(); break;
      case 'edit-player': e.stopPropagation(); showEditPlayer(t.getAttribute('data-player')); break;
      case 'save-player': savePlayer(t.getAttribute('data-player')); break;
      case 'pick-photo': pickPhoto(); break;
      case 'remove-photo': removePhoto(); break;
      case 'archive-player': archivePlayer(t.getAttribute('data-player')); break;
      case 'unarchive-player': {
        var p = playersById()[t.getAttribute('data-player')];
        if (p) { p.archived = false; persist(); renderAll(); }
        break;
      }
      case 'player-detail': showPlayerDetail(t.getAttribute('data-player')); break;
      case 'session-detail': showSessionDetail(t.getAttribute('data-session')); break;
      case 'share-results': shareResults(t.getAttribute('data-session')); break;
      case 'copy-recap': copyRecap(); break;
      case 'reload-app': window.location.reload(); break;
      case 'dismiss-update': {
        var bar = document.getElementById('update-bar');
        if (bar) bar.hidden = true;
        break;
      }
      case 'export-pdf': PdfReport.download(DB); toast('PDF report downloaded.'); break;
      case 'export-data':
        // Noted first, so the backup itself records when it was taken.
        DB.lastBackupAt = Date.now();
        persist();
        Storage_.exportJson(DB);
        renderStats();
        toast('Backup file downloaded.');
        break;
      case 'stats-period': {
        var period = t.getAttribute('data-period');
        if (period === 'all' || period === '30' || period === 'year') { statsPeriod = period; renderStats(); }
        break;
      }
      case 'undo-score': undoLastScore(); break;
      case 'change-courts': { var cs = activeSession(); if (cs) showChangeCourts(cs); break; }
      case 'apply-courts': applyCourts(); break;
      case 'tsetup-reuse-groups': reuseLastGroups(); break;
      case 'import-data': importData(); break;
      case 'reset-progress': resetProgress(); break;
      case 'reset-everything': resetEverything(); break;
      case 'close-modal': closeModal(); break;
    }
  });

  document.addEventListener('change', function (e) {
    if (e.target.classList && e.target.classList.contains('setup-player')) {
      updateSetupCount();
      renderSetupPairs();
    }
    if (e.target.classList && e.target.classList.contains('tsetup-player')) {
      renderTournamentPairs();
      updateTournamentCounts();
    }
    if (e.target.id === 'tsetup-mixed-pairs') {
      tourMixedPairs = e.target.checked;
      var note = document.querySelector('#view-tournament .mixed-note');
      if (note) note.textContent = mixedPairsNote(tourMixedPairs);
      var before = tourPairs.length;
      renderTournamentPairs();     // turned off: pairs of different levels are dropped
      updateTournamentCounts();
      var dropped = before - tourPairs.length;
      if (dropped) toast(dropped + (dropped === 1 ? ' pair' : ' pairs') + ' of different levels removed.');
    }
    if (e.target.id === 'edit-player-photo') photoChosen(e.target);
  });

  document.addEventListener('input', function (e) {
    if (e.target.classList && e.target.classList.contains('group-name')) groupNameTyped(e.target);
    if (e.target.classList && e.target.classList.contains('row-filter')) applyRowFilter(e.target);
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.id === 'new-player-name') addPlayer();
    // Enter in a score box saves that court, for anyone scoring from a keyboard.
    if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('score-input')) {
      e.preventDefault();
      saveScore(e.target.getAttribute('data-match'));
    }
    if (e.key === 'Escape') closeModal();
  });

  document.querySelectorAll('.tab-btn').forEach(function (b) {
    b.addEventListener('click', function () { setTab(b.getAttribute('data-tab')); });
  });

  /* "12m", "1h 05m", or "now" for a wait under a minute. */
  function fmtWait(ms) {
    var m = Math.max(0, Math.floor(ms / 60000));
    if (m < 1) return 'now';
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
  }

  /* Keep the waiting-list clocks moving without re-rendering the view —
     a full render would wipe any score someone is mid-way through typing. */
  function tickWaitTimers() {
    var now = Date.now();
    document.querySelectorAll('.chip[data-since]').forEach(function (chip) {
      var el = chip.querySelector('.wait-time');
      if (el) el.textContent = fmtWait(now - parseInt(chip.getAttribute('data-since'), 10));
    });
  }
  setInterval(tickWaitTimers, 15000);

  /* ---------- Game clocks ---------- */

  /* "12:34", or "1:02:03" past an hour, for a game in progress. */
  function fmtClock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  /* "13m", "1h 02m", or "45s" for a finished game's length. */
  function fmtShort(ms) {
    var m = Math.floor(ms / 60000);
    if (m >= 60) return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm';
    if (m >= 1) return m + 'm';
    return Math.floor(ms / 1000) + 's';
  }

  /* A game to 11 rarely needs twenty minutes; past that the clock turns
     red so the host can glance over. */
  var LONG_GAME_MS = 20 * 60000;

  /* The clock on a court card: how long the game has been on. Nothing for
     a game that started before clocks existed. */
  function gameClockHtml(m) {
    if (!m.startedAt) return '';
    var elapsed = Date.now() - m.startedAt;
    return ' <span class="game-time' + (elapsed >= LONG_GAME_MS ? ' long' : '') + '" data-started="' + m.startedAt +
      '" title="Time on court">\u23F1 ' + fmtClock(elapsed) + '</span>';
  }

  /* The game clocks tick every second; only their text changes, so a score
     being typed is never disturbed. */
  function tickGameTimers() {
    var now = Date.now();
    document.querySelectorAll('.game-time[data-started]').forEach(function (el) {
      var elapsed = now - parseInt(el.getAttribute('data-started'), 10);
      el.textContent = '\u23F1 ' + fmtClock(elapsed);
      el.classList.toggle('long', elapsed >= LONG_GAME_MS);
    });
  }
  setInterval(tickGameTimers, 1000);

  /* ---------- Keep the screen on ---------- */

  /* While a session or tournament runs, the phone on the bench should not
     go dark between scores. Browsers grant a wake lock only from a tap, so
     it is asked for on the first tap of a running session and again when
     the tab comes back; it is released when the session ends. A browser
     without the feature, or one that refuses, simply behaves as before. */
  var wakeLock = null;

  function holdScreen() {
    if (wakeLock || !activeSession()) return;
    var nav = window.navigator;
    if (!nav.wakeLock || !nav.wakeLock.request || document.visibilityState !== 'visible') return;
    nav.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
    }, function () { /* refused (low battery, a setting): nothing to do */ });
  }

  function releaseScreen() {
    if (!wakeLock) return;
    var lock = wakeLock;
    wakeLock = null;
    try { lock.release().catch(function () {}); } catch (e) { /* already gone */ }
  }

  document.addEventListener('click', holdScreen);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') holdScreen();
  });

  function renderAll() {
    renderPlay();
    renderPlayers();
    renderStats();
    updateSetupCount();
  }

  renderAll();
})();
