/* ================================================================
   Cinema Sound - app.js
   Picking a song, the live preview and saving the converted file.
   In the Android app, saving and the list of songs on the phone go
   through the `CinemaAndroid` bridge (MainActivity.java); in a normal
   browser the file is downloaded and songs are picked as files.
   ================================================================ */
(function () {
  'use strict';

  const E = window.CinemaEngine;
  const SAMPLE_RATE = 44100;
  const STORE_KEY = 'cinema-sound-settings';
  const $ = (id) => document.getElementById(id);

  const settings = Object.assign({}, E.DEFAULTS, loadSettings());
  let song = null;          // { name, buffer }
  let ctx = null;           // AudioContext for the preview
  let player = null;        // { source, out, startedAt, offset }
  let position = 0;         // seconds, while paused
  let mode = 'cinema';      // or 'original'
  let busy = false;
  let rebuildTimer = null;
  let phoneSongs = [];      // from the Android music library
  let currentSongId = null;

  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (err) { return {}; }
  }
  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (err) { /* private mode */ }
  }

  function clock(s) {
    s = Math.max(0, Math.floor(s));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function setStatus(el, text, isError) {
    el.textContent = text || '';
    el.classList.toggle('error', !!isError);
  }

  // ── Settings controls ──────────────────────────────────────────
  function showSettings() {
    document.querySelectorAll('.seg[data-setting]').forEach((seg) => {
      seg.querySelectorAll('button').forEach((b) => {
        b.setAttribute('aria-checked', String(b.dataset.value === settings[seg.dataset.setting]));
      });
    });
    document.querySelectorAll('input[type=range][data-setting]').forEach((r) => {
      r.value = settings[r.dataset.setting];
    });
    $('output-hint').textContent = settings.output === 'headphones'
      ? 'Sound is placed all around you, including behind. Best with headphones or earbuds.'
      : 'A wide cinema sound for phone, car or room speakers.';
  }

  document.querySelectorAll('.seg[data-setting]').forEach((seg) => {
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || busy) return;
      settings[seg.dataset.setting] = b.dataset.value;
      changed();
    });
  });
  document.querySelectorAll('input[type=range][data-setting]').forEach((r) => {
    r.addEventListener('input', () => {
      settings[r.dataset.setting] = parseFloat(r.value);
      changed();
    });
  });

  function changed() {
    saveSettings();
    showSettings();
    // Hear the change straight away
    if (player) {
      clearTimeout(rebuildTimer);
      rebuildTimer = setTimeout(() => { if (player) play(currentTime()); }, 120);
    }
  }

  $('compare').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    mode = b.dataset.value;
    $('compare').querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    if (player) play(currentTime());
  });

  // ── Choosing a song ────────────────────────────────────────────
  $('pick-btn').addEventListener('click', () => { if (!busy) $('file-input').click(); });

  $('file-input').addEventListener('change', () => {
    const file = $('file-input').files[0];
    $('file-input').value = '';
    if (!file) return;
    currentSongId = null;
    showSongs();
    openSong(file.name.replace(/\.[^.]+$/, ''), () => file.arrayBuffer());
  });

  // `read` resolves to the file's bytes
  let opening = 0;
  async function openSong(name, read) {
    if (busy) return;
    const ticket = ++opening;
    stop();
    position = 0;
    song = null;
    updateTransport();
    setStatus($('save-status'), '');
    setStatus($('status'), 'Opening ' + name + '…');
    try {
      const bytes = await read();
      const buffer = await E.decode(bytes, SAMPLE_RATE);
      if (ticket !== opening) return; // another song was picked meanwhile
      song = { name, buffer };
      $('song-name').textContent = song.name;
      $('song-length').textContent = clock(buffer.duration);
      $('song').hidden = false;
      $('pick-label').textContent = 'Choose another song file';
      setStatus($('status'), buffer.duration > 15 * 60
        ? 'This is a long track. Converting it needs a lot of memory and may fail on older phones.'
        : '');
    } catch (err) {
      if (ticket !== opening) return;
      $('song').hidden = true;
      setStatus($('status'), 'This song could not be opened. Try an MP3, M4A, WAV, FLAC or OGG file.', true);
    }
    updateTransport();
  }

  // ── Songs on the phone (Android app only) ──────────────────────
  const bridge = window.CinemaAndroid;
  if (bridge && bridge.findSongs) {
    // The song list is the main way in; picking a file comes second
    $('find-btn').hidden = false;
    $('find-btn').classList.add('btn-primary');
    $('pick-btn').classList.remove('btn-primary');
    $('library').after($('pick-btn'));
  }

  $('find-btn').addEventListener('click', () => {
    $('find-btn').disabled = true;
    setStatus($('status'), 'Looking for songs…');
    bridge.findSongs();
  });

  // Called by MainActivity with a JSON list, or null and why not
  window.cinemaSongs = (json, problem) => {
    $('find-btn').disabled = false;
    if (problem === 'denied') {
      setStatus($('status'), '');
      $('status').append('Cinema Sound needs access to your music to list your songs. ');
      const a = document.createElement('button');
      a.className = 'link';
      a.textContent = 'Open settings';
      a.addEventListener('click', () => bridge.openSettings());
      $('status').append(a);
      $('status').classList.add('error');
      return;
    }
    if (problem) {
      setStatus($('status'), 'Your songs could not be listed. You can still choose a song file.', true);
      return;
    }
    phoneSongs = JSON.parse(json);
    setStatus($('status'), phoneSongs.length ? '' : 'No songs were found on this phone.');
    $('library').hidden = !phoneSongs.length;
    $('find-btn').hidden = !!phoneSongs.length;
    showSongs();
  };

  const LIST_LIMIT = 150;
  function showSongs() {
    if ($('library').hidden) return;
    const q = $('search').value.trim().toLowerCase();
    const found = q
      ? phoneSongs.filter((s) => (s.title + ' ' + s.artist).toLowerCase().includes(q))
      : phoneSongs;
    const list = $('songs');
    list.textContent = '';
    for (const s of found.slice(0, LIST_LIMIT)) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.id = s.id;
      b.setAttribute('aria-current', String(s.id === currentSongId));
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = s.title;
      const a = document.createElement('span');
      a.className = 'a';
      a.textContent = (s.artist ? s.artist + ' · ' : '') + clock(s.ms / 1000);
      b.append(t, a);
      li.append(b);
      list.append(li);
    }
    $('songs-note').textContent = found.length > LIST_LIMIT
      ? 'Showing ' + LIST_LIMIT + ' of ' + found.length + ' songs. Search to find the others.'
      : found.length + (found.length === 1 ? ' song' : ' songs');
  }

  $('search').addEventListener('input', showSongs);

  $('songs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || busy) return;
    const s = phoneSongs.find((x) => String(x.id) === b.dataset.id);
    if (!s) return;
    currentSongId = s.id;
    showSongs();
    openSong(s.title, () => fetch('song/' + s.id).then((r) => {
      if (!r.ok) throw new Error('not found');
      return r.arrayBuffer();
    }));
  });

  // ── Preview ────────────────────────────────────────────────────
  function audio() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function currentTime() {
    if (!player) return position;
    return Math.min(song.buffer.duration, player.offset + (ctx.currentTime - player.startedAt));
  }

  function play(from) {
    const c = audio();
    stop(true);
    const source = c.createBufferSource();
    source.buffer = song.buffer;
    const out = c.createGain();
    out.connect(c.destination);
    if (mode === 'cinema') {
      E.build(c, source, out, settings);
    } else {
      source.connect(out);
    }
    const offset = from >= song.buffer.duration ? 0 : from;
    source.start(0, offset);
    source.onended = () => {
      if (player && player.source === source) { player = null; position = 0; updateTransport(); }
    };
    player = { source, out, startedAt: c.currentTime, offset };
    updateTransport();
    tick();
  }

  // `quiet`: being replaced by a new player, keep the position as it is
  function stop(quiet) {
    if (!player) return;
    const p = player;
    if (!quiet) position = currentTime();
    player = null;
    p.source.onended = null;
    try { p.source.stop(); } catch (err) { /* not started */ }
    p.out.disconnect();
    if (!quiet) updateTransport();
  }

  function tick() {
    if (!player) return;
    if (!seeking) {
      $('seek').value = currentTime();
      $('time-now').textContent = clock(currentTime());
    }
    requestAnimationFrame(tick);
  }

  $('play-btn').addEventListener('click', () => {
    if (!song) return;
    if (player) stop(); else play(position);
  });

  let seeking = false;
  $('seek').addEventListener('input', () => {
    seeking = true;
    $('time-now').textContent = clock(parseFloat($('seek').value));
  });
  $('seek').addEventListener('change', () => {
    seeking = false;
    position = parseFloat($('seek').value);
    if (player) play(position); else updateTransport();
  });

  function updateTransport() {
    const ready = !!song && !busy;
    $('play-btn').disabled = !ready;
    $('seek').disabled = !ready;
    $('convert-btn').disabled = !ready;
    $('play-btn').setAttribute('aria-label', player ? 'Pause preview' : 'Play preview');
    $('play-icon').setAttribute('d', player ? 'M6 5h4v14H6zM14 5h4v14h-4z' : 'M8 5v14l11-7z');
    if (song) {
      $('seek').max = song.buffer.duration;
      $('time-end').textContent = clock(song.buffer.duration);
      if (!player) { $('seek').value = position; $('time-now').textContent = clock(position); }
    } else {
      $('seek').value = 0;
      $('time-now').textContent = '0:00';
      $('time-end').textContent = '0:00';
    }
  }

  // ── Converting and saving ──────────────────────────────────────
  $('convert-btn').addEventListener('click', convert);

  async function convert() {
    if (!song || busy) return;
    stop();
    busy = true;
    updateTransport();
    keepAwake(true);
    $('progress').hidden = false;
    $('bar').style.width = '0%';
    setStatus($('save-status'), 'Converting…');
    const fileName = song.name + ' (Cinema).wav';
    try {
      const out = await E.render(song.buffer, settings, (p) => {
        $('bar').style.width = Math.round(p * 90) + '%';
      });
      setStatus($('save-status'), 'Saving…');
      const wav = E.toWav(out);
      const where = await save(fileName, wav, (p) => { $('bar').style.width = Math.round(90 + p * 10) + '%'; });
      $('bar').style.width = '100%';
      setStatus($('save-status'), 'Saved "' + fileName + '"' + (where ? ' to ' + where : '') + '.');
    } catch (err) {
      setStatus($('save-status'), 'Converting failed: ' + (err && err.message ? err.message : err), true);
    } finally {
      busy = false;
      keepAwake(false);
      setTimeout(() => { if (!busy) $('progress').hidden = true; }, 1500);
      updateTransport();
    }
  }

  function keepAwake(on) {
    if (window.CinemaAndroid) window.CinemaAndroid.keepAwake(on);
  }

  // Resolves to a description of where the file went
  async function save(fileName, bytes, onProgress) {
    const android = window.CinemaAndroid;
    if (!android) {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return 'your downloads';
    }

    // The bridge only takes strings, so the file is sent in base64 pieces
    if (!android.begin(fileName)) throw new Error('could not create the file');
    const CHUNK = 384 * 1024; // a multiple of 3, so pieces join cleanly
    try {
      for (let at = 0; at < bytes.length; at += CHUNK) {
        const part = bytes.subarray(at, Math.min(bytes.length, at + CHUNK));
        let s = '';
        for (let i = 0; i < part.length; i += 0x8000) {
          s += String.fromCharCode.apply(null, part.subarray(i, i + 0x8000));
        }
        if (!android.append(btoa(s))) throw new Error('could not write the file');
        onProgress(Math.min(1, (at + CHUNK) / bytes.length));
        await new Promise((r) => setTimeout(r, 0)); // let the page draw
      }
    } catch (err) {
      android.cancel();
      throw err;
    }
    const where = android.finish();
    if (!where) throw new Error('could not finish the file');
    return where;
  }

  showSettings();
  updateTransport();
})();
