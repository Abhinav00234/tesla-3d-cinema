import { api, urls } from './api.js';
import { settings, getProgress, recentProgress, isCarBrowser } from './store.js';
import { el, fmtDuration, fmtSize, resolutionLabel, showToast, showErr } from './utils.js';

// What this browser can decode, asked once per codec.
const CODEC_TESTS = {
  h264: ['video/mp4; codecs="avc1.640028"'],
  hevc: ['video/mp4; codecs="hvc1.1.6.L153.B0"', 'video/mp4; codecs="hev1.1.6.L153.B0"'],
  vp9: ['video/webm; codecs="vp9"'],
  vp8: ['video/webm; codecs="vp8"'],
  av1: ['video/mp4; codecs="av01.0.08M.08"'],
  theora: ['video/ogg; codecs="theora"'],
};
const CODEC_NAMES = { h264: 'H.264', hevc: 'HEVC', vp9: 'VP9', vp8: 'VP8', av1: 'AV1', mpeg4: 'MPEG-4', mpeg2video: 'MPEG-2' };
const probeVideo = document.createElement('video');
const codecCache = new Map();

export function canPlayCodec(codec) {
  if (!codecCache.has(codec)) {
    const tests = CODEC_TESTS[codec] || [];
    codecCache.set(codec, tests.some((type) => probeVideo.canPlayType(type) !== ''));
  }
  return codecCache.get(codec);
}

export const codecName = (codec) => CODEC_NAMES[codec] || String(codec || 'unknown').toUpperCase();

// Which file to play for a movie on this screen, or null when it needs converting.
// `failed` holds file names that already refused to play here.
export function pickSource(movie, failed = new Set()) {
  const original = movie.video && canPlayCodec(movie.video.codec) && !failed.has(movie.name) ? movie.name : null;
  const copy = movie.carCopy && !failed.has(movie.carCopy.name) ? movie.carCopy.name : null;
  if (settings.preferCarCopy) return copy || original;
  return original || copy;
}

// ── Dialog ─────────────────────────────────────────────────────────
const backdrop = document.getElementById('dialog-backdrop');
const dialogEl = document.getElementById('dialog');
let focusBefore = null;

export function closeDialog() {
  if (backdrop.hidden) return;
  backdrop.hidden = true;
  // Give the keyboard back to whatever opened the dialog
  if (focusBefore && focusBefore.isConnected) focusBefore.focus({ preventScroll: true });
  focusBefore = null;
}

export function openDialog({ title, body, actions }) {
  document.getElementById('dialog-title').textContent = title;
  const bodyEl = document.getElementById('dialog-body');
  bodyEl.replaceChildren(...(Array.isArray(body) ? body : [body]).map((b) => (typeof b === 'string' ? el('p', { text: b }) : b)));
  const actionsEl = document.getElementById('dialog-actions');
  actionsEl.replaceChildren(...actions.map((a) => el('button', {
    class: 'dialog-btn' + (a.primary ? ' primary' : ''),
    text: a.label,
    onclick: () => { closeDialog(); if (a.run) a.run(); },
  })));
  if (backdrop.hidden) focusBefore = document.activeElement;
  backdrop.hidden = false;
  dialogEl.scrollTop = 0;
  dialogEl.focus({ preventScroll: true });
}

// Keep Tab inside the open dialog
dialogEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const items = dialogEl.querySelectorAll('button, a[href]');
  if (!items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogEl)) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeDialog(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !backdrop.hidden) closeDialog(); });

// ── Library screen ─────────────────────────────────────────────────
export function initLibrary({ onPlay, onShow, onHide }) {
  const root = document.getElementById('library');
  const grid = document.getElementById('movie-grid');
  const message = document.getElementById('lib-message');
  const search = document.getElementById('lib-search');
  const continueSection = document.getElementById('continue-section');
  const continueRow = document.getElementById('continue-row');
  const banner = document.getElementById('convert-banner');

  let movies = [];
  let job = null;
  let pollTimer = null;

  function setMessage(text, isError = false) {
    message.hidden = !text;
    message.textContent = text || '';
    message.classList.toggle('lib-message-error', isError);
  }

  // ── Cards ────────────────────────────────────────────────────────
  function statusChip(movie) {
    if (movie.error) return el('span', { class: 'chip chip-warn', text: 'Can’t Be Read' });
    if (job && job.state === 'running' && job.name === movie.name) {
      return el('span', { class: 'chip chip-busy', text: `Converting ${Math.floor(job.percent)}%` });
    }
    if (!pickSource(movie)) return el('span', { class: 'chip chip-warn', text: 'Needs Converting' });
    return null;
  }

  function metaLine(movie) {
    const playing = pickSource(movie);
    const video = playing && movie.carCopy && playing === movie.carCopy.name ? movie.carCopy.video : movie.video;
    return [
      fmtDuration(movie.duration),
      resolutionLabel(video),
      movie.surround ? '5.1' : '',
      movie.subtitleCount ? 'Subtitles' : '',
    ].filter(Boolean).join(', ');
  }

  function card(movie, { compact = false } = {}) {
    const saved = getProgress(movie.name);
    const img = el('img', { class: 'card-thumb', src: urls.thumbnail(movie.name), alt: '', width: 480, height: 270, loading: 'lazy', decoding: 'async' });
    img.addEventListener('error', () => img.classList.add('card-thumb-missing'));
    const left = saved ? fmtDuration(Math.max(60, saved.duration - saved.time)) + ' left' : '';

    return el('button', { class: 'movie-card' + (compact ? ' compact' : ''), 'data-name': movie.name, onclick: () => choose(movie) },
      el('div', { class: 'card-thumb-wrap' },
        img,
        statusChip(movie),
        saved && el('div', { class: 'card-progress' }, el('i', { style: `width:${Math.min(100, (saved.time / saved.duration) * 100)}%` })),
      ),
      el('div', { class: 'card-title', text: movie.title }),
      el('div', { class: 'card-meta', text: compact && left ? left : metaLine(movie) }),
    );
  }

  function render() {
    const query = search.value.trim().toLowerCase();
    const shown = query ? movies.filter((m) => m.title.toLowerCase().includes(query)) : movies;
    grid.replaceChildren(...shown.map((m) => card(m)));

    document.getElementById('lib-count').textContent = movies.length ? `${movies.length} ${movies.length === 1 ? 'movie' : 'movies'}` : '';
    document.getElementById('all-heading').hidden = movies.length === 0;

    const byName = new Map(movies.map((m) => [m.name, m]));
    const recent = query ? [] : recentProgress().map((p) => byName.get(p.name)).filter(Boolean).slice(0, 6);
    continueSection.hidden = recent.length === 0;
    continueRow.replaceChildren(...recent.map((m) => card(m, { compact: true })));

    if (movies.length === 0) setMessage('No movies yet. Put .mp4 or .mkv files in the movies folder on the computer that runs the server, then press Refresh.');
    else if (shown.length === 0) setMessage(`No movie matches “${search.value.trim()}”.`);
    else setMessage('');
  }

  async function refresh() {
    if (movies.length === 0) setMessage('Loading movies…');
    try {
      movies = await api.movies();
      render();
    } catch (err) {
      grid.replaceChildren();
      setMessage(`Could not load the library. ${err.message === 'Failed to fetch' ? 'Is the server still running?' : err.message}`, true);
    }
  }

  // ── Choosing a movie ─────────────────────────────────────────────
  function choose(movie) {
    if (movie.error) return showErr(`“${movie.title}” could not be read. Check that the file has finished copying, then press Refresh.`);
    const source = pickSource(movie);
    if (source) return onPlay(movie, source);
    offerConvert(movie);
  }

  function offerConvert(movie) {
    if (job && job.state === 'running') {
      const same = job.name === movie.name;
      return openDialog({
        title: same ? 'Still Converting' : 'Another Movie Is Converting',
        body: same
          ? `“${movie.title}” is ${Math.floor(job.percent)}% converted. You can play it here when it finishes.`
          : 'Only one movie can be converted at a time. Try again when the current one is done.',
        actions: [{ label: 'OK', primary: true }],
      });
    }
    const format = movie.video ? codecName(movie.video.codec) : 'unknown';
    const start = (height) => async () => {
      try {
        job = (await api.convert(movie.name, height)).job;
        showToast(`Converting “${movie.title}”. You can keep using the app.`);
        watchJob();
      } catch (err) {
        showErr(err.message);
      }
    };
    openDialog({
      title: 'This Screen Can’t Play This Movie Yet',
      body: [
        `“${movie.title}” is in a video format (${format}) that this browser can’t show.`,
        'The computer that holds your movies can make a copy that plays here. The copy keeps every sound track and the subtitles, and the original file is not changed.',
        'A full movie can take an hour or more. You can keep watching other movies while it works.',
      ],
      actions: [
        { label: 'Convert in 1080p', primary: true, run: start(1080) },
        { label: 'Convert in 720p (Smaller File)', run: start(720) },
        { label: 'Not Now' },
      ],
    });
  }

  // ── Conversion progress ──────────────────────────────────────────
  function drawJob() {
    const running = job && job.state === 'running';
    banner.hidden = !running;
    if (running) {
      const movie = movies.find((m) => m.name === job.name);
      const title = movie ? movie.title : job.name;
      const minutes = (Date.now() - job.startedAt) / 60000;
      const remaining = job.percent > 1 ? (minutes / job.percent) * (100 - job.percent) : null;
      document.getElementById('convert-title').textContent = `Converting “${title}” to ${job.height}p`;
      document.getElementById('convert-detail').textContent =
        `${Math.floor(job.percent)}%` + (remaining !== null ? `, about ${remaining < 1 ? '1 min' : Math.ceil(remaining) + ' min'} left` : '');
      document.getElementById('convert-fill').style.transform = `scaleX(${(job.percent / 100).toFixed(4)})`;
    }
    // Only the chips change, so update them in place instead of redrawing every card.
    for (const cardEl of root.querySelectorAll('.movie-card')) {
      const movie = movies.find((m) => m.name === cardEl.dataset.name);
      if (!movie) continue;
      const wrap = cardEl.querySelector('.card-thumb-wrap');
      wrap.querySelector('.chip')?.remove();
      const chip = statusChip(movie);
      if (chip) wrap.append(chip);
    }
  }

  async function watchJob() {
    clearTimeout(pollTimer);
    try {
      const before = job;
      job = (await api.convertStatus()).job;
      if (before && before.state === 'running' && job && job.state !== 'running') {
        const movie = movies.find((m) => m.name === job.name);
        const title = movie ? movie.title : job.name;
        if (job.state === 'done') {
          showToast(`“${title}” is ready to watch.`, { ms: 8000 });
          await refresh();
        } else if (job.state === 'error') {
          showErr(`Converting “${title}” failed. ${job.error || 'Try again, or pick 720p.'}`);
        }
      }
    } catch (err) {
      // the server may be restarting; try again on the next tick
    }
    drawJob();
    if (job && job.state === 'running') pollTimer = setTimeout(watchJob, 2000);
  }

  document.getElementById('convert-cancel-btn').addEventListener('click', () => {
    openDialog({
      title: 'Stop Converting?',
      body: 'The part that is already converted will be thrown away.',
      actions: [
        { label: 'Keep Converting', primary: true },
        { label: 'Stop Converting', run: async () => { try { job = (await api.cancelConvert()).job; } catch (err) { showErr(err.message); } drawJob(); } },
      ],
    });
  });

  // ── Help ─────────────────────────────────────────────────────────
  async function showHelp() {
    let info = null;
    try { info = await api.info(); } catch (err) { /* show the help without the addresses */ }

    const body = [
      el('h3', { text: 'Add Movies' }),
      el('p', { text: 'Copy .mp4 or .mkv files into the movies folder on the computer that runs the server, then press Refresh.' }),
      el('h3', { text: 'Open It on Another Screen' }),
    ];
    if (info && info.addresses.length) {
      body.push(
        el('p', { text: 'On the same WiFi or phone hotspot, type one of these into the browser:' }),
        el('ul', { class: 'address-list' }, info.addresses.map((a) => el('li', {}, el('code', { text: `http://${a}:${info.port}` })))),
      );
    } else {
      body.push(el('p', { text: 'Connect the other device to the same WiFi or phone hotspot and open this computer’s address with the port the server printed when it started.' }));
    }
    body.push(
      el('h3', { text: 'Movies Marked “Needs Converting”' }),
      el('p', { text: 'Some movies use a video format this screen can’t show. Tap the movie and the computer makes a copy that plays here.' }),
      el('h3', { text: 'Controls' }),
      el('p', { text: 'Tap the picture to show or hide the controls. Double-tap the left or right side to jump 10 seconds. Drag to look around the cinema.' }),
      el('p', { text: 'Keyboard: Space plays and pauses, the arrow keys seek and change the volume, F is full screen, L is the lights, O opens the library.' }),
    );
    if (isCarBrowser) {
      body.push(
        el('h3', { text: 'Full Screen in the Car' }),
        el('p', { text: 'The car’s browser has no full screen button of its own. A known trick is to open the page through a YouTube link, which the car shows full screen. It only works when this page is opened from an internet address, and it may stop working after a car software update.' }),
        el('p', {}, el('a', { class: 'dialog-link', href: `https://www.youtube.com/redirect?q=${encodeURIComponent(location.origin + '/')}`, text: 'Open in Full Screen' })),
      );
    }
    if (info) body.push(el('p', { class: 'dialog-small', text: `Version ${info.version}` }));

    const actions = [{ label: 'Close', primary: true }];
    if (info && info.pinEnabled) {
      actions.push({ label: 'Lock the Library', run: async () => { try { await api.logout(); } finally { location.href = '/login'; } } });
    }
    openDialog({ title: 'Help', body, actions });
  }

  // ── Wiring ───────────────────────────────────────────────────────
  search.addEventListener('input', render);
  document.getElementById('lib-refresh-btn').addEventListener('click', async () => {
    await refresh();
    if (!message.classList.contains('lib-message-error')) showToast('Library refreshed.', { ms: 2000 });
  });
  document.getElementById('lib-help-btn').addEventListener('click', showHelp);

  const library = {
    isOpen: () => !root.hidden,
    show() {
      root.hidden = false;
      render();   // progress bars may have changed while watching
      drawJob();
      if (onShow) onShow();
    },
    hide() {
      root.hidden = true;
      if (onHide) onHide();
    },
    refresh,
    offerConvert,
    findMovie: (name) => movies.find((m) => m.name === name),
    fmtSize,
  };

  refresh().then(watchJob);
  return library;
}
