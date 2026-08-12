/* PdfReport: dependency-free PDF generator for the stats report.
   Emits PDF 1.4 with base-14 Helvetica fonts — no embedding needed. */
(function () {
  'use strict';

  var PAGE_W = 612, PAGE_H = 792;       // US Letter, points
  var MARGIN = 54, TOP = PAGE_H - 60, BOTTOM = 60;

  function sanitize(s) {
    var out = '';
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      out += (c >= 32 && c <= 255) ? s[i] : '?';
    }
    return out.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }

  function Doc() {
    this.pages = [];
    this._newPage();
  }

  Doc.prototype._newPage = function () {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = TOP;
  };

  Doc.prototype.ensure = function (needed) {
    if (this.y - needed < BOTTOM) this._newPage();
  };

  Doc.prototype.text = function (x, str, size, bold, dy) {
    this.ops.push('BT /' + (bold ? 'F2' : 'F1') + ' ' + size + ' Tf ' +
      x + ' ' + this.y.toFixed(1) + ' Td (' + sanitize(str) + ') Tj ET');
    if (dy !== 0) this.y -= (dy || size * 1.45);
  };

  Doc.prototype.row = function (cols, size, bold) {
    for (var i = 0; i < cols.length; i++) {
      this.ops.push('BT /' + (bold ? 'F2' : 'F1') + ' ' + size + ' Tf ' +
        cols[i].x + ' ' + this.y.toFixed(1) + ' Td (' + sanitize(cols[i].t) + ') Tj ET');
    }
    this.y -= size * 1.55;
  };

  Doc.prototype.rule = function () {
    this.y += 4;
    this.ops.push('0.75 w 0.6 0.6 0.6 RG ' + MARGIN + ' ' + this.y.toFixed(1) +
      ' m ' + (PAGE_W - MARGIN) + ' ' + this.y.toFixed(1) + ' l S');
    this.y -= 12;
  };

  Doc.prototype.space = function (n) { this.y -= n; };

  Doc.prototype.build = function () {
    var objects = [];
    function add(body) { objects.push(body); return objects.length; } // 1-based ids
    var catalogId = add(null);   // placeholder, filled last
    var pagesId = add(null);
    var f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    var f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
    var kids = [];
    for (var i = 0; i < this.pages.length; i++) {
      var stream = this.pages[i].join('\n');
      var contentId = add('<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream');
      var pageId = add('<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + PAGE_W + ' ' + PAGE_H + '] ' +
        '/Resources << /Font << /F1 ' + f1 + ' 0 R /F2 ' + f2 + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>');
      kids.push(pageId + ' 0 R');
    }
    objects[catalogId - 1] = '<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>';
    objects[pagesId - 1] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + this.pages.length + ' >>';

    var out = '%PDF-1.4\n';
    var offsets = [];
    for (var n = 0; n < objects.length; n++) {
      offsets.push(out.length);
      out += (n + 1) + ' 0 obj\n' + objects[n] + '\nendobj\n';
    }
    var xref = out.length;
    out += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
    for (var k = 0; k < offsets.length; k++) {
      out += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
    }
    out += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root ' + catalogId + ' 0 R >>\n' +
      'startxref\n' + xref + '\n%%EOF';

    var bytes = new Uint8Array(out.length);
    for (var b = 0; b < out.length; b++) bytes[b] = out.charCodeAt(b) & 0xFF;
    return bytes;
  };

  /* ---------- Report content ---------- */

  var LB_COLS = { rank: MARGIN, name: MARGIN + 28, gp: 300, w: 340, l: 375, pct: 410, diff: 460, rating: 510 };

  function fmtDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function leaderboardList(stats, byId, restrictIds) {
    var ids = restrictIds || Object.keys(stats);
    var list = ids.filter(function (id) { return stats[id] && byId[id]; }).map(function (id) {
      var s = stats[id];
      return {
        name: byId[id].name, rating: byId[id].rating,
        games: s.games, wins: s.wins, losses: s.losses,
        pct: s.games ? s.wins / s.games : 0, diff: s.pf - s.pa
      };
    });
    list.sort(function (a, b) {
      if (b.pct !== a.pct) return b.pct - a.pct;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return b.diff - a.diff;
    });
    return list;
  }

  function writeLeaderboard(doc, list) {
    doc.ensure(40);
    doc.row([
      { x: LB_COLS.rank, t: '#' }, { x: LB_COLS.name, t: 'Player' }, { x: LB_COLS.gp, t: 'GP' },
      { x: LB_COLS.w, t: 'W' }, { x: LB_COLS.l, t: 'L' }, { x: LB_COLS.pct, t: 'Win%' },
      { x: LB_COLS.diff, t: '+/-' }, { x: LB_COLS.rating, t: 'Rating' }
    ], 10, true);
    list.forEach(function (r, i) {
      doc.ensure(20);
      doc.row([
        { x: LB_COLS.rank, t: String(i + 1) }, { x: LB_COLS.name, t: r.name }, { x: LB_COLS.gp, t: String(r.games) },
        { x: LB_COLS.w, t: String(r.wins) }, { x: LB_COLS.l, t: String(r.losses) },
        { x: LB_COLS.pct, t: Math.round(r.pct * 100) + '%' },
        { x: LB_COLS.diff, t: (r.diff > 0 ? '+' : '') + r.diff },
        { x: LB_COLS.rating, t: String(r.rating) }
      ], 10, false);
    });
  }

  function download(db) {
    var byId = {};
    db.players.forEach(function (p) { byId[p.id] = p; });
    var doc = new Doc();

    doc.text(MARGIN, 'ThursDink Rotation and Progress Tracker', 18, true);
    doc.text(MARGIN, 'Progress report - generated ' + fmtDate(Date.now()), 10, false);
    doc.space(6);
    doc.rule();

    doc.text(MARGIN, 'All-time leaderboard', 14, true);
    doc.space(4);
    var allStats = Engine.computeStats(db.sessions);
    var allList = leaderboardList(allStats, byId);
    if (allList.length) writeLeaderboard(doc, allList);
    else doc.text(MARGIN, 'No games recorded yet.', 10, false);

    var done = db.sessions.filter(function (s) {
      return Engine.sessionMatches(s).some(function (m) { return m.done; });
    });
    if (done.length) {
      doc.space(10);
      doc.rule();
      doc.text(MARGIN, 'Sessions', 14, true);
      doc.space(4);
      done.slice().reverse().forEach(function (sess) {
        var games = 0;
        Engine.sessionMatches(sess).forEach(function (m) { if (m.done) games++; });
        doc.ensure(70);
        doc.text(MARGIN, fmtDate(sess.startedAt) + '  -  ' + sess.playerIds.length + ' players, ' +
          games + ' games' + (sess.status === 'active' ? ' (in progress)' : ''), 12, true);
        doc.space(2);
        writeLeaderboard(doc, leaderboardList(Engine.computeStats([sess]), byId, sess.playerIds));
        doc.space(8);
      });
    }

    var bytes = doc.build();
    var blob = new Blob([bytes], { type: 'application/pdf' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var d = new Date();
    a.href = url;
    a.download = 'thursdink-report-' + d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0') + '.pdf';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  window.PdfReport = { download: download, _Doc: Doc };
})();
