/* App: UI wiring for Play / Players / Stats views. */
(function () {
  'use strict';

  var DB = Storage_.load();

  function persist() { Storage_.save(DB); }

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

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
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

  function renderPlay() {
    var view = document.getElementById('view-play');
    var session = activeSession();
    if (!session) {
      view.innerHTML = renderSessionSetup();
    } else {
      view.innerHTML = renderActiveSession(session);
    }
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
        '<span class="muted">' + esc(p.skill) + '</span>' +
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
      '<button class="btn small" data-action="setup-none">Select none</button></div>' +
      '<div class="check-list">' + checks + '</div></div>' +
      '<button class="btn primary big" data-action="start-session">Start session &amp; make round 1</button>' +
      '</div>';
  }

  function scoreDisplay(m, side) {
    var v = side === 'A' ? m.scoreA : m.scoreB;
    return v === null || v === undefined ? '' : v;
  }

  function renderMatchCard(m, byId, editable) {
    function names(team) {
      return team.map(function (id) {
        return '<span class="pname">' + esc(byId[id] ? byId[id].name : '?') + '</span>';
      }).join(' &amp; ');
    }
    var scoreRow = function (side, team) {
      var val = scoreDisplay(m, side);
      if (m.done) {
        var won = (side === 'A') === (m.scoreA > m.scoreB);
        return '<div class="team-row' + (won ? ' winner' : '') + '">' +
          '<div class="team-names">' + names(team) + (won ? ' <span class="win-tag">W</span>' : '') + '</div>' +
          '<div class="score-final">' + val + '</div></div>';
      }
      return '<div class="team-row">' +
        '<div class="team-names">' + names(team) + '</div>' +
        '<div class="score-ctl">' +
        '<button class="step-btn" data-action="score-step" data-match="' + m.id + '" data-side="' + side + '" data-d="-1">&minus;</button>' +
        '<input type="number" class="score-input" inputmode="numeric" min="0" max="99" ' +
        'data-match="' + m.id + '" data-side="' + side + '" value="' + val + '" placeholder="0">' +
        '<button class="step-btn" data-action="score-step" data-match="' + m.id + '" data-side="' + side + '" data-d="1">+</button>' +
        '</div></div>';
    };
    var footer;
    if (m.done) {
      footer = editable ? '<button class="btn small" data-action="edit-score" data-match="' + m.id + '">Edit score</button>' : '';
    } else {
      footer = '<button class="btn primary" data-action="save-score" data-match="' + m.id + '">Save score</button>';
    }
    return '<div class="match-card' + (m.done ? ' done' : '') + '">' +
      '<div class="court-label">Court ' + m.court + '</div>' +
      scoreRow('A', m.teamA) +
      '<div class="vs">vs</div>' +
      scoreRow('B', m.teamB) +
      '<div class="match-footer">' + footer + '</div>' +
      '</div>';
  }

  function renderActiveSession(session) {
    var byId = playersById();
    var current = session.rounds[session.rounds.length - 1];
    var html = '<div class="session-bar">' +
      '<div><strong>Session</strong> &middot; ' + fmtDate(session.startedAt) +
      ' &middot; ' + session.playerIds.length + ' players &middot; ' + session.courtCount + ' courts</div>' +
      '<div class="session-bar-actions">' +
      '<button class="btn small" data-action="manage-players">Players</button>' +
      '<button class="btn small danger-outline" data-action="end-session">End session</button>' +
      '</div></div>';

    // Previous rounds, collapsed
    for (var i = 0; i < session.rounds.length - 1; i++) {
      var r = session.rounds[i];
      html += '<details class="round-past"><summary>Round ' + r.number +
        ' <span class="muted">(' + r.matches.filter(function (m) { return m.done; }).length + '/' + r.matches.length + ' scored)</span></summary>' +
        '<div class="round-body">' +
        r.matches.map(function (m) { return renderMatchCard(m, byId, true); }).join('') +
        renderSitOuts(r, byId) +
        '</div></details>';
    }

    // Current round
    if (current) {
      var anyScored = current.matches.some(function (m) { return m.done; });
      html += '<div class="round-current">' +
        '<div class="round-head"><h2>Round ' + current.number + '</h2>' +
        (!anyScored ? '<button class="btn small" data-action="reshuffle">Reshuffle</button>' : '') +
        '</div>' +
        current.matches.map(function (m) { return renderMatchCard(m, byId, true); }).join('') +
        renderSitOuts(current, byId) +
        '</div>';
      html += '<button class="btn primary big" data-action="next-round">Next round &rarr;</button>';
    }

    // Session standings so far
    var stats = Engine.computeStats([session]);
    var rows = leaderboardRows(stats, byId, session.playerIds);
    if (rows.trim()) {
      html += '<div class="card"><h3>Session standings</h3>' + leaderboardTable(rows) + '</div>';
    }
    return html;
  }

  function renderSitOuts(round, byId) {
    if (!round.sitOuts.length) return '';
    return '<div class="sitouts"><span class="sitout-label">Sitting out:</span> ' +
      round.sitOuts.map(function (id) {
        return '<span class="chip">' + esc(byId[id] ? byId[id].name : '?') + '</span>';
      }).join(' ') + '</div>';
  }

  /* ---------- Leaderboards ---------- */

  function leaderboardRows(stats, byId, restrictIds) {
    var ids = restrictIds || Object.keys(stats);
    var list = ids.filter(function (id) { return stats[id] && byId[id]; }).map(function (id) {
      var s = stats[id];
      return {
        id: id, name: byId[id].name, rating: byId[id].rating,
        games: s.games, wins: s.wins, losses: s.losses,
        pct: s.games ? s.wins / s.games : 0, diff: s.pf - s.pa
      };
    });
    list.sort(function (a, b) {
      if (b.pct !== a.pct) return b.pct - a.pct;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return b.diff - a.diff;
    });
    return list.map(function (r, i) {
      return '<tr data-action="player-detail" data-player="' + r.id + '">' +
        '<td>' + (i + 1) + '</td><td class="td-name">' + esc(r.name) + '</td>' +
        '<td>' + r.games + '</td><td>' + r.wins + '</td><td>' + r.losses + '</td>' +
        '<td>' + Math.round(r.pct * 100) + '%</td>' +
        '<td>' + (r.diff > 0 ? '+' : '') + r.diff + '</td>' +
        '<td>' + r.rating + '</td></tr>';
    }).join('');
  }

  function leaderboardTable(rowsHtml) {
    return '<div class="table-wrap"><table class="lb">' +
      '<thead><tr><th>#</th><th>Player</th><th>GP</th><th>W</th><th>L</th><th>Win%</th><th>+/&minus;</th><th>Rating</th></tr></thead>' +
      '<tbody>' + rowsHtml + '</tbody></table></div>';
  }

  /* ---------- Players view ---------- */

  function renderPlayers() {
    var view = document.getElementById('view-players');
    var stats = Engine.computeStats(DB.sessions);
    var roster = DB.players.filter(function (p) { return !p.archived; });
    var archived = DB.players.filter(function (p) { return p.archived; });

    var skillOpts = Engine.SKILL_LEVELS.map(function (s) {
      return '<option value="' + s + '"' + (s === '3.5' ? ' selected' : '') + '>' + s + '</option>';
    }).join('');

    var rows = roster.map(function (p) {
      var s = stats[p.id] || { games: 0, wins: 0, losses: 0 };
      return '<div class="player-row" data-action="player-detail" data-player="' + p.id + '">' +
        '<div class="player-main"><strong>' + esc(p.name) + '</strong>' +
        '<span class="muted">skill ' + esc(p.skill) + ' &middot; rating ' + p.rating + ' &middot; ' +
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
      '</div><p class="muted small-note">Skill sets the starting rating; it adjusts automatically from results.</p></div>' +
      '<div class="card"><h2>Roster (' + roster.length + ')</h2>' +
      (rows || '<p class="muted">No players yet.</p>') + archivedHtml + '</div>';
  }

  /* ---------- Stats view ---------- */

  function renderStats() {
    var view = document.getElementById('view-stats');
    var byId = playersById();
    var doneSessions = DB.sessions.filter(function (s) { return s.status === 'done'; });
    var stats = Engine.computeStats(DB.sessions);
    var rows = leaderboardRows(stats, byId);

    var sessionsHtml = DB.sessions.slice().reverse().map(function (s) {
      var games = 0;
      s.rounds.forEach(function (r) {
        r.matches.forEach(function (m) { if (m.done) games++; });
      });
      return '<div class="player-row" data-action="session-detail" data-session="' + s.id + '">' +
        '<div class="player-main"><strong>' + fmtDate(s.startedAt) + '</strong>' +
        '<span class="muted">' + s.playerIds.length + ' players &middot; ' + s.rounds.length + ' rounds &middot; ' +
        games + ' games' + (s.status === 'active' ? ' &middot; in progress' : '') + '</span></div>' +
        '<span class="chev">&rsaquo;</span></div>';
    }).join('');

    view.innerHTML =
      '<div class="card"><h2>All-time leaderboard</h2>' +
      (rows.trim() ? leaderboardTable(rows) : '<p class="muted">No games recorded yet. Finish some games in a session first.</p>') +
      '<p class="muted small-note">Tap a player for their trend and history.</p></div>' +
      '<div class="card"><h2>Sessions (' + DB.sessions.length + ')</h2>' +
      (sessionsHtml || '<p class="muted">No sessions yet.</p>') + '</div>' +
      '<div class="card"><h2>Backup</h2>' +
      '<p class="muted small-note">All data lives on this device. Export a backup file now and then.</p>' +
      '<div class="setup-actions">' +
      '<button class="btn" data-action="export-data">Export data</button>' +
      '<button class="btn" data-action="import-data">Import data</button>' +
      '<input type="file" id="import-file" accept=".json,application/json" hidden>' +
      '</div></div>';
  }

  /* ---------- Player detail / session detail modals ---------- */

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

    var sessionsHtml = DB.sessions.slice().reverse().map(function (sess) {
      var inIt = sess.rounds.some(function (r) {
        return r.matches.some(function (m) {
          return m.teamA.indexOf(playerId) >= 0 || m.teamB.indexOf(playerId) >= 0;
        });
      });
      if (!inIt) return '';
      var st = Engine.computeStats([sess])[playerId] || { wins: 0, losses: 0, pf: 0, pa: 0 };
      return '<div class="mini-row"><span>' + fmtDate(sess.startedAt) + '</span>' +
        '<span>' + st.wins + 'W&ndash;' + st.losses + 'L, ' +
        ((st.pf - st.pa) > 0 ? '+' : '') + (st.pf - st.pa) + ' pts</span></div>';
    }).join('');

    openModal(
      '<h2>' + esc(p.name) + '</h2>' +
      '<p class="muted">Skill ' + esc(p.skill) + ' &middot; Rating <strong>' + p.rating + '</strong></p>' +
      sparkline(p.ratingHistory) +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-num">' + s.games + '</div><div class="stat-lbl">Games</div></div>' +
      '<div class="stat-box"><div class="stat-num">' + s.wins + '&ndash;' + s.losses + '</div><div class="stat-lbl">W&ndash;L</div></div>' +
      '<div class="stat-box"><div class="stat-num">' + pct + '%</div><div class="stat-lbl">Win rate</div></div>' +
      '<div class="stat-box"><div class="stat-num">' + ((s.pf - s.pa) > 0 ? '+' : '') + (s.pf - s.pa) + '</div><div class="stat-lbl">Point diff</div></div>' +
      '</div>' +
      (sessionsHtml ? '<h3>By session</h3>' + sessionsHtml : '') +
      '<div class="modal-actions"><button class="btn" data-action="close-modal">Close</button></div>'
    );
  }

  function showSessionDetail(sessionId) {
    var sess = null;
    DB.sessions.forEach(function (s) { if (s.id === sessionId) sess = s; });
    if (!sess) return;
    var byId = playersById();
    var stats = Engine.computeStats([sess]);
    var rows = leaderboardRows(stats, byId, sess.playerIds);
    openModal(
      '<h2>' + fmtDate(sess.startedAt) + '</h2>' +
      '<p class="muted">' + sess.playerIds.length + ' players &middot; ' + sess.rounds.length + ' rounds' +
      (sess.status === 'active' ? ' &middot; in progress' : '') + '</p>' +
      (rows.trim() ? leaderboardTable(rows) : '<p class="muted">No scored games in this session.</p>') +
      '<div class="modal-actions"><button class="btn" data-action="close-modal">Close</button></div>'
    );
  }

  function showEditPlayer(playerId) {
    var p = playersById()[playerId];
    if (!p) return;
    var skillOpts = Engine.SKILL_LEVELS.map(function (s) {
      return '<option value="' + s + '"' + (s === p.skill ? ' selected' : '') + '>' + s + '</option>';
    }).join('');
    openModal(
      '<h2>Edit player</h2>' +
      '<div class="field"><label>Name</label>' +
      '<input type="text" id="edit-player-name" value="' + esc(p.name) + '" maxlength="30"></div>' +
      '<div class="field"><label>Skill level</label>' +
      '<select id="edit-player-skill">' + skillOpts + '</select></div>' +
      '<div class="modal-actions">' +
      '<button class="btn danger-outline" data-action="archive-player" data-player="' + p.id + '">Archive</button>' +
      '<span class="spacer"></span>' +
      '<button class="btn" data-action="close-modal">Cancel</button>' +
      '<button class="btn primary" data-action="save-player" data-player="' + p.id + '">Save</button>' +
      '</div>' +
      '<p class="muted small-note">Archiving hides a player from new sessions; their history is kept.</p>'
    );
  }

  function showManagePlayers(session) {
    var byId = playersById();
    var roster = DB.players.filter(function (p) { return !p.archived || session.playerIds.indexOf(p.id) >= 0; });
    var checks = roster.map(function (p) {
      var inSess = session.playerIds.indexOf(p.id) >= 0;
      return '<label class="check-row">' +
        '<input type="checkbox" class="manage-player" value="' + p.id + '"' + (inSess ? ' checked' : '') + '> ' +
        '<span class="check-name">' + esc(p.name) + '</span>' +
        '<span class="muted">' + esc(p.skill) + '</span></label>';
    }).join('');
    openModal(
      '<h2>Session players</h2>' +
      '<p class="muted small-note">Check people in or out. Changes apply from the next round; rounds already made are unchanged.</p>' +
      '<div class="check-list">' + checks + '</div>' +
      '<div class="modal-actions">' +
      '<button class="btn" data-action="close-modal">Cancel</button>' +
      '<button class="btn primary" data-action="apply-manage-players">Apply</button>' +
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
    var sel = document.querySelector('.court-opt.selected');
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
      rounds: [],
      status: 'active'
    };
    var round = Engine.generateRound(session, playersById());
    if (!round) { toast('Could not build a round.'); return; }
    session.rounds.push(round);
    DB.sessions.push(session);
    persist();
    renderPlay();
    toast('Session started — round 1 is up.');
  }

  function collectScore(matchId, side) {
    var input = document.querySelector('.score-input[data-match="' + matchId + '"][data-side="' + side + '"]');
    if (!input) return null;
    var v = parseInt(input.value, 10);
    return isNaN(v) ? null : v;
  }

  function findMatch(session, matchId) {
    for (var i = 0; i < session.rounds.length; i++) {
      var ms = session.rounds[i].matches;
      for (var j = 0; j < ms.length; j++) {
        if (ms[j].id === matchId) return ms[j];
      }
    }
    return null;
  }

  function saveScore(matchId) {
    var session = activeSession();
    if (!session) return;
    var m = findMatch(session, matchId);
    if (!m) return;
    var a = collectScore(matchId, 'A');
    var b = collectScore(matchId, 'B');
    if (a === null || b === null) { toast('Enter both scores.'); return; }
    if (a < 0 || b < 0) { toast('Scores cannot be negative.'); return; }
    if (a === b) { toast('Pickleball games cannot end in a tie.'); return; }
    m.scoreA = a;
    m.scoreB = b;
    m.done = true;
    var byId = playersById();
    m.ratingDeltas = Engine.computeRatingDeltas(m, byId);
    Engine.applyDeltas(m.ratingDeltas, byId, 1);
    persist();
    renderPlay();
  }

  function editScore(matchId) {
    var session = activeSession();
    if (!session) return;
    var m = findMatch(session, matchId);
    if (!m || !m.done) return;
    if (m.ratingDeltas) {
      Engine.applyDeltas(m.ratingDeltas, playersById(), -1);
      m.ratingDeltas = null;
    }
    m.done = false;
    persist();
    renderPlay();
  }

  function nextRound() {
    var session = activeSession();
    if (!session) return;
    var current = session.rounds[session.rounds.length - 1];
    var unscored = current.matches.filter(function (m) { return !m.done; }).length;
    if (unscored > 0 &&
        !confirm(unscored + ' game(s) in round ' + current.number +
          ' have no saved score. They will not count in stats. Make the next round anyway?')) {
      return;
    }
    var round = Engine.generateRound(session, playersById());
    if (!round) { toast('Not enough players for a round. Add players via the Players button.'); return; }
    session.rounds.push(round);
    persist();
    renderPlay();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function reshuffleRound() {
    var session = activeSession();
    if (!session) return;
    var current = session.rounds[session.rounds.length - 1];
    if (current.matches.some(function (m) { return m.done; })) {
      toast('Cannot reshuffle after scores are saved.');
      return;
    }
    session.rounds.pop();
    var round = Engine.generateRound(session, playersById());
    if (round) session.rounds.push(round);
    else session.rounds.push(current);
    persist();
    renderPlay();
  }

  function applyManagePlayers() {
    var session = activeSession();
    if (!session) return;
    var ids = Array.prototype.slice.call(document.querySelectorAll('.manage-player:checked'))
      .map(function (el) { return el.value; });
    if (ids.length < 4) { toast('A session needs at least 4 players.'); return; }
    var counts = Engine.sessionCounts(session);
    var meta = session.playerMeta || {};
    // Late joiners get sit-out credit equal to the least-sat current player,
    // so they are neither forced to sit immediately nor jump the whole queue.
    var effs = session.playerIds.map(function (id) {
      return (counts.sitOuts[id] || 0) + ((meta[id] && meta[id].sitCredit) || 0);
    });
    var minEff = effs.length ? Math.min.apply(null, effs) : 0;
    ids.forEach(function (id) {
      if (session.playerIds.indexOf(id) < 0) {
        meta[id] = { sitCredit: minEff, joinedRound: session.rounds.length + 1 };
      }
    });
    session.playerIds = ids;
    session.playerMeta = meta;
    persist();
    closeModal();
    renderPlay();
    toast('Player list updated — applies from the next round.');
  }

  function endSession() {
    var session = activeSession();
    if (!session) return;
    var current = session.rounds[session.rounds.length - 1];
    var unscoredMsg = '';
    if (current) {
      var unscored = current.matches.filter(function (m) { return !m.done; }).length;
      if (unscored > 0) unscoredMsg = ' ' + unscored + ' unscored game(s) will not count.';
    }
    if (!confirm('End this session?' + unscoredMsg)) return;
    // Drop entirely-unscored trailing round so it does not pollute history
    if (current && current.matches.every(function (m) { return !m.done; })) {
      session.rounds.pop();
    }
    session.status = 'done';
    session.endedAt = Date.now();
    persist();
    renderPlay();
    renderStats();
    showSessionDetail(session.id);
    toast('Session saved.');
  }

  function savePlayer(playerId) {
    var p = playersById()[playerId];
    if (!p) return;
    var name = document.getElementById('edit-player-name').value.trim();
    var skill = document.getElementById('edit-player-skill').value;
    if (!name) { toast('Name cannot be empty.'); return; }
    p.name = name;
    var hadGames = (Engine.computeStats(DB.sessions)[playerId] || { games: 0 }).games > 0;
    if (skill !== p.skill) {
      p.skill = skill;
      if (!hadGames) p.rating = Engine.initialRating(skill);
    }
    persist();
    closeModal();
    renderAll();
    toast('Saved.');
  }

  function archivePlayer(playerId) {
    var p = playersById()[playerId];
    if (!p) return;
    var session = activeSession();
    if (session && session.playerIds.indexOf(playerId) >= 0) {
      toast('Remove them from the running session first (Play tab → Players).');
      return;
    }
    if (!confirm('Archive ' + p.name + '? Their stats and history are kept.')) return;
    p.archived = true;
    persist();
    closeModal();
    renderAll();
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
      case 'pick-courts':
        document.querySelectorAll('.court-opt').forEach(function (b) { b.classList.remove('selected'); });
        t.classList.add('selected');
        break;
      case 'setup-all':
      case 'setup-none':
        document.querySelectorAll('.setup-player').forEach(function (c) { c.checked = action === 'setup-all'; });
        updateSetupCount();
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
      case 'edit-score': editScore(t.getAttribute('data-match')); break;
      case 'next-round': nextRound(); break;
      case 'reshuffle': reshuffleRound(); break;
      case 'manage-players': { var s = activeSession(); if (s) showManagePlayers(s); break; }
      case 'apply-manage-players': applyManagePlayers(); break;
      case 'end-session': endSession(); break;
      case 'add-player': addPlayer(); break;
      case 'edit-player': e.stopPropagation(); showEditPlayer(t.getAttribute('data-player')); break;
      case 'save-player': savePlayer(t.getAttribute('data-player')); break;
      case 'archive-player': archivePlayer(t.getAttribute('data-player')); break;
      case 'unarchive-player': {
        var p = playersById()[t.getAttribute('data-player')];
        if (p) { p.archived = false; persist(); renderAll(); }
        break;
      }
      case 'player-detail': showPlayerDetail(t.getAttribute('data-player')); break;
      case 'session-detail': showSessionDetail(t.getAttribute('data-session')); break;
      case 'export-data': Storage_.exportJson(DB); toast('Backup file downloaded.'); break;
      case 'import-data': importData(); break;
      case 'close-modal': closeModal(); break;
    }
  });

  document.addEventListener('change', function (e) {
    if (e.target.classList && e.target.classList.contains('setup-player')) updateSetupCount();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.id === 'new-player-name') addPlayer();
    if (e.key === 'Escape') closeModal();
  });

  document.querySelectorAll('.tab-btn').forEach(function (b) {
    b.addEventListener('click', function () { setTab(b.getAttribute('data-tab')); });
  });

  function renderAll() {
    renderPlay();
    renderPlayers();
    renderStats();
    updateSetupCount();
  }

  renderAll();
})();
