/* Storage: on-device persistence via localStorage, plus JSON export/import. */
(function () {
  'use strict';

  var KEY = 'pbr-data-v1';

  function defaultData() {
    return {
      version: 1,
      players: [],   // {id, name, skill, rating, ratingHistory:[{t,r}], archived}
      sessions: []   // {id, startedAt, endedAt, courtCount, playerIds, playerMeta, pairs, games, status}
    };
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return defaultData();
      var data = JSON.parse(raw);
      if (!data || !Array.isArray(data.players) || !Array.isArray(data.sessions)) {
        return defaultData();
      }
      return data;
    } catch (e) {
      console.error('Failed to load data:', e);
      return defaultData();
    }
  }

  function save(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      console.error('Failed to save data:', e);
      return false;
    }
  }

  function exportJson(data) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var d = new Date();
    var stamp = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    a.href = url;
    a.download = 'thursdink-backup-' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function importJson(file, onDone) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.players) || !Array.isArray(data.sessions)) {
          onDone(null, 'That file does not look like a Pickleball Rotation backup.');
          return;
        }
        onDone(data, null);
      } catch (e) {
        onDone(null, 'Could not read that file as JSON.');
      }
    };
    reader.onerror = function () { onDone(null, 'Could not read the file.'); };
    reader.readAsText(file);
  }

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  window.Storage_ = {
    load: load,
    save: save,
    exportJson: exportJson,
    importJson: importJson,
    newId: newId
  };
})();
