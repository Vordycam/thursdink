/* App: UI wiring for Play / Players / Stats views (continuous court flow). */
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
      '<button class="btn primary big" data-action="start-session">Start session</button>' +
      '</div>';
  }

  function teamNames(team, byId) {
    return team.map(function (id) {
      return '<span class="pname">' + esc(byId[id] ? byId[id].name : '?') + '</span>';
    }).join(' &amp; ');
  }

  function renderActiveGameCard(m, byId) {
    var scoreRow = function (side, team) {
      var v = side === 'A' ? m.scoreA : m.scoreB;
      var val = (v === null || v === undefined) ? '' : v;
      return '<div class="team-row">' +
        '<div class="team-names">' + teamNames(team, byId) + '</div>' +
        '<div class="score-ctl">' +
        '<button class="step-btn" data-action="score-step" data-match="' + m.id + '" data-side="' + side + '" data-d="-1">&minus;</button>' +
        '<input type="number" class="score-input" inputmode="numeric" min="0" max="99" ' +
        'data-match="' + m.id + '" data-side="' + side + '" value="' + val + '" placeholder="0">' +
        '<button class="step-btn" data-action="score-step" data-match="' + m.id + '" data-side="' + side + '" data-d="1">+</button>' +
        '</div></div>';
    };
    return '<div class="match-card">' +
      '<div class="court-label">Court ' + m.court + '</div>' +
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

  function renderFreeCourtCard(court, poolCount) {
    return '<div class="match-card free-court">' +
      '<div class="court-label">Court ' + court + '</div>' +
      '<p class="muted free-note">Free &mdash; ' +
      (poolCount > 0 ? 'only ' + poolCount + ' waiting, needs 4.' : 'no one is waiting.') +
      '</p></div>';
  }

  function renderFinishedGameRow(m, byId) {
    var aWon = m.scoreA > m.scoreB;
    return '<div class="finished-row">' +
      '<span class="finished-court muted">C' + m.court + '</span>' +
      '<span class="finished-teams">' +
      '<span class="' + (aWon ? 'fin-win' : '') + '">' + teamNames(m.teamA, byId) + ' ' + m.scoreA + '</span>' +
      ' &ndash; ' +
      '<span class="' + (!aWon ? 'fin-win' : '') + '">' + m.scoreB + ' ' + teamNames(m.teamB, byId) + '</span>' +
      '</span>' +
      '<button class="btn small" data-action="edit-finished" data-match="' + m.id + '">Edit</button>' +
      '</div>';
  }

  function renderActiveSession(session) {
    var byId = playersById();
    var actives = Engine.activeGames(session);
    var finished = (session.games || []).filter(function (g) { return g.done; });
    var pool = Engine.waitingPool(session);
    var counts = Engine.sessionCounts(session);

    var html = '<div class="session-bar">' +
      '<div><strong>Session</strong> &middot; ' + fmtDate(session.startedAt) +
      ' &middot; ' + session.playerIds.length + ' players &middot; ' + session.courtCount + ' courts</div>' +
      '<div class="session-bar-actions">' +
      '<button class="btn small" data-action="manage-players">Players</button>' +
      '<button class="btn small danger-outline" data-action="end-session">End session</button>' +
      '</div></div>';

    html += '<div class="courts-grid">';
    for (var c = 1; c <= session.courtCount; c++) {
      var g = null;
      actives.forEach(function (a) { if (a.court === c) g = a; });
      html += g ? renderActiveGameCard(g, byId) : renderFreeCourtCard(c, pool.length);
    }
    html += '</div>';

    if (pool.length) {
      // Longest wait first. Each chip carries its own clock and a colour for
      // where it sits: red fills the next court, yellow the one after, green
      // just sat down or just arrived.
      var queue = Engine.queueOrder(session, byId);
      var bands = Engine.waitBands(queue);
      html += '<div class="sitouts"><span class="sitout-label">Waiting to play, longest wait first:</span> ' +
        queue.map(function (q, i) {
          return '<span class="chip chip-' + bands[i] + '" data-since="' + q.since + '">' +
            '<span class="muted">' + (i + 1) + '.</span> ' +
            esc(byId[q.id] ? byId[q.id].name : '?') +
            ' <span class="wait-time">' + fmtWait(Date.now() - q.since) + '</span>' +
            ' <span class="muted">(' + (counts.games[q.id] || 0) + ')</span></span>';
        }).join(' ') +
        '<div class="muted small-note">' +
        '<span class="legend legend-red">Red</span> waited longest &middot; ' +
        '<span class="legend legend-yellow">Yellow</span> next &middot; ' +
        '<span class="legend legend-green">Green</span> most recent to sit down or arrive. ' +
        'Time = how long they have been waiting; brackets = games played.</div></div>';
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
    var rows = leaderboardRows(stats, byId, null);
    if (rows.trim()) {
      html += '<div class="card"><h3>Session standings</h3>' + leaderboardTable(rows) + '</div>';
    }
    return html;
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

  function countDoneGames(session) {
    var n = 0;
    Engine.sessionMatches(session).forEach(function (m) { if (m.done) n++; });
    return n;
  }

  function renderStats() {
    var view = document.getElementById('view-stats');
    var byId = playersById();
    var stats = Engine.computeStats(DB.sessions);
    var rows = leaderboardRows(stats, byId);

    var sessionsHtml = DB.sessions.slice().reverse().map(function (s) {
      return '<div class="player-row" data-action="session-detail" data-session="' + s.id + '">' +
        '<div class="player-main"><strong>' + fmtDate(s.startedAt) + '</strong>' +
        '<span class="muted">' + Engine.sessionParticipants(s).length + ' players &middot; ' +
        countDoneGames(s) + ' games' + (s.status === 'active' ? ' &middot; in progress' : '') + '</span></div>' +
        '<span class="chev">&rsaquo;</span></div>';
    }).join('');

    view.innerHTML =
      '<div class="card"><h2>All-time leaderboard</h2>' +
      (rows.trim() ? leaderboardTable(rows) : '<p class="muted">No games recorded yet. Finish some games in a session first.</p>') +
      '<p class="muted small-note">Tap a player for their trend and history.</p></div>' +
      '<div class="card"><h2>Sessions (' + DB.sessions.length + ')</h2>' +
      (sessionsHtml || '<p class="muted">No sessions yet.</p>') + '</div>' +
      '<div class="card"><h2>Export &amp; backup</h2>' +
      '<p class="muted small-note">The PDF is a readable report you can share or print. ' +
      'The JSON backup is for restoring or moving your data to another device.</p>' +
      '<div class="setup-actions">' +
      '<button class="btn primary" data-action="export-pdf">Export report (PDF)</button>' +
      '<button class="btn" data-action="export-data">Export backup (JSON)</button>' +
      '<button class="btn" data-action="import-data">Import backup</button>' +
      '<input type="file" id="import-file" accept=".json,application/json" hidden>' +
      '</div></div>';
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

    var sessionsHtml = DB.sessions.slice().reverse().map(function (sess) {
      var inIt = Engine.sessionMatches(sess).some(function (m) {
        return m.teamA.indexOf(playerId) >= 0 || m.teamB.indexOf(playerId) >= 0;
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
    var rows = leaderboardRows(stats, byId, null);   // includes players who left early
    openModal(
      '<h2>' + fmtDate(sess.startedAt) + '</h2>' +
      '<p class="muted">' + Engine.sessionParticipants(sess).length + ' players &middot; ' + countDoneGames(sess) + ' games' +
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
      '<p class="muted small-note">Check people in or out. Anyone mid-game finishes that game; ' +
      'checked-out players just get no new games.</p>' +
      '<div class="check-list">' + checks + '</div>' +
      '<div class="modal-actions">' +
      '<button class="btn" data-action="close-modal">Cancel</button>' +
      '<button class="btn primary" data-action="apply-manage-players">Apply</button>' +
      '</div>'
    );
  }

  function showEditMatchup(matchId) {
    var session = activeSession();
    if (!session) return;
    var m = findGame(session, matchId);
    if (!m || m.done) return;
    var byId = playersById();
    // Anyone on this court plus anyone waiting; players on other courts stay put
    var eligible = m.teamA.concat(m.teamB, Engine.waitingPool(session))
      .filter(function (id) { return byId[id]; });
    function slot(label, idx, selectedId) {
      var opts = eligible.map(function (id) {
        return '<option value="' + id + '"' + (id === selectedId ? ' selected' : '') + '>' +
          esc(byId[id].name) + '</option>';
      }).join('');
      return '<div class="field"><label>' + label + '</label>' +
        '<select class="matchup-slot" data-slot="' + idx + '">' + opts + '</select></div>';
    }
    openModal(
      '<h2>Edit matchup</h2>' +
      '<p class="muted small-note">Court ' + m.court + '. Pick from the four on court or anyone waiting; ' +
      'whoever you swap out goes back to the waiting list.</p>' +
      '<div class="matchup-grid">' +
      '<div class="matchup-team"><h3>Team 1</h3>' + slot('Player 1', 0, m.teamA[0]) + slot('Player 2', 1, m.teamA[1]) + '</div>' +
      '<div class="matchup-team"><h3>Team 2</h3>' + slot('Player 1', 2, m.teamB[0]) + slot('Player 2', 3, m.teamB[1]) + '</div>' +
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
      games: [],
      nextSeq: 1,
      status: 'active'
    };
    var started = Engine.fillCourts(session, playersById());
    if (!started.length) { toast('Could not build a game.'); return; }
    DB.sessions.push(session);
    persist();
    renderPlay();
    toast('Session started — games are up on ' + started.length + ' court(s).');
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

  /* USA Pickleball scoring rules live in the engine; this just surfaces them.
     The group plays to 11, win by 2, so anything else is refused outright. */
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
    // The engine credits newcomers with the lightest current load and clocks
    // their wait from now, so they join the back of the line rather than
    // jumping people who were already waiting.
    Engine.setSessionPlayers(session, ids);
    var started = Engine.fillCourts(session, playersById());
    persist();
    closeModal();
    renderPlay();
    toast(started.length ? 'Players updated — a free court just filled!' : 'Player list updated.');
  }

  function endSession() {
    var session = activeSession();
    if (!session) return;
    var unscored = Engine.activeGames(session).length;
    var msg = 'End this session?' + (unscored ? ' ' + unscored + ' game(s) in progress have no score and will not count.' : '');
    if (!confirm(msg)) return;
    session.games = (session.games || []).filter(function (g) { return g.done; });
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
      case 'reshuffle-game': reshuffleGame(t.getAttribute('data-match')); break;
      case 'edit-matchup': showEditMatchup(t.getAttribute('data-match')); break;
      case 'save-matchup': saveMatchup(t.getAttribute('data-match')); break;
      case 'edit-finished': showEditFinished(t.getAttribute('data-match')); break;
      case 'save-finished': saveFinished(t.getAttribute('data-match')); break;
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
      case 'export-pdf': PdfReport.download(DB); toast('PDF report downloaded.'); break;
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

  function renderAll() {
    renderPlay();
    renderPlayers();
    renderStats();
    updateSetupCount();
  }

  renderAll();
})();
