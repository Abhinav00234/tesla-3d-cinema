import { BASE_PITCH } from './config.js';
import { fmtTime, showToast, showErr, el } from './utils.js';
import { video, state, loadVideoUrl, unloadVideo, loadSubtitleTrack, setNativeSubtitles } from './videoManager.js';
import { initAudio, resumeAudio, switchAudioTrack, stopExternalAudio, setVolume, hold } from './audioManager.js';
import { api, urls } from './api.js';
import { settings, saveSetting, getProgress, saveProgress, clearProgress } from './store.js';
import { initLibrary, pickSource, closeDialog } from './library.js';

const $ = (id) => document.getElementById(id);

const SEATS = {
  center: { label: 'Middle', position: [0, 2.43, 4.66], yaw: 0, pitch: 0 },          // Row 7
  front:  { label: 'Front Row', position: [0, 0.99, -1.82], yaw: 0, pitch: 0.31 },   // Row 1, looking up
  back:   { label: 'Back Row', position: [0, 4.11, 12.22], yaw: 0, pitch: 0.03 },    // Row 14
  side:   { label: 'Left Side', position: [-11.5, 2.43, 4.66], yaw: -0.39, pitch: 0.10 },
};
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const QUALITIES = {
  auto:   { label: 'Auto', hint: 'Lowers the sharpness by itself when the picture stutters' },
  smooth: { label: 'Smooth', hint: 'Lightest. Best for car screens and older devices' },
  best:   { label: 'Best', hint: 'Sharpest picture with glow. Needs a strong graphics card' },
};

export function initUI(deps) {
  const { camera, lights, scene, engine } = deps;
  const stage = $('stage');
  const hudEl = $('hud');
  const panel = $('panel');

  // What is on screen right now.
  const current = { movie: null, source: null, tracks: null, audioIndex: null, subIndex: null, failed: new Set(), loading: false };
  let seat = 'center';
  let lightsOn = false;
  let waiting = false;

  // ── Looking around ───────────────────────────────────────────────
  const look = { yaw: 0, pitch: 0, sens: 0.0027, maxYaw: 1.2, maxPitch: 0.5 };
  let seatPitchOffset = 0;
  let seatYawOffset = 0;
  let currentFov = camera.fov;

  deps.updateCamera = () => {
    camera.rotation.order = 'YXZ';
    camera.rotation.y = seatYawOffset + look.yaw;
    camera.rotation.x = BASE_PITCH + seatPitchOffset + look.pitch;
  };

  function setSeat(name) {
    const s = SEATS[name];
    seat = name;
    camera.position.set(...s.position);
    seatYawOffset = s.yaw;
    seatPitchOffset = s.pitch;
    look.yaw = 0;
    look.pitch = 0;
  }

  // One finger or the mouse: a drag looks around, a tap shows or hides the
  // controls, and a double tap on the left or right side jumps 10 seconds.
  let pointer = null;
  let lastTap = { time: 0, side: '' };

  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, time: performance.now(), moved: false };
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pointer || e.pointerId !== pointer.id) return;
    if (!pointer.moved && Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) > 10) {
      pointer.moved = true;
      stage.classList.add('dragging');
    }
    if (pointer.moved && settings.view === 'theatre') {
      look.yaw -= (e.clientX - pointer.lx) * look.sens;
      look.pitch -= (e.clientY - pointer.ly) * look.sens;
      look.yaw = Math.max(-look.maxYaw, Math.min(look.maxYaw, look.yaw));
      look.pitch = Math.max(-look.maxPitch, Math.min(look.maxPitch, look.pitch));
    }
    pointer.lx = e.clientX;
    pointer.ly = e.clientY;
  });

  function endPointer(e) {
    if (!pointer || e.pointerId !== pointer.id) return;
    const wasTap = !pointer.moved && performance.now() - pointer.time < 450;
    pointer = null;
    stage.classList.remove('dragging');
    if (wasTap && e.type === 'pointerup') onTap(e.clientX);
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);

  function onTap(x) {
    if (!panel.hidden) return closePanel();
    if (!state.hasVideo) return;

    const now = performance.now();
    const ratio = x / window.innerWidth;
    const side = ratio < 0.35 ? 'back' : ratio > 0.65 ? 'fwd' : '';
    if (side && lastTap.side === side && now - lastTap.time < 350) {
      lastTap = { time: 0, side: '' };
      seekBy(side === 'back' ? -10 : 10, true);
    } else {
      lastTap = { time: now, side };
    }
    // The first tap of a double tap toggles the controls and the second toggles them back.
    if (hudEl.classList.contains('hud-hidden')) showHUD();
    else hideHUD();
  }

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    currentFov = Math.max(20, Math.min(110, currentFov + e.deltaY * 0.05));
    camera.fov = currentFov;
    camera.updateProjectionMatrix();
  }, { passive: false });

  // ── Controls bar ─────────────────────────────────────────────────
  let hudTimer = null;

  // `inert` keeps hidden controls away from the keyboard and screen readers.
  function showHUD() {
    hudEl.classList.remove('hud-hidden');
    hudEl.inert = false;
    clearTimeout(hudTimer);
    hudTimer = setTimeout(() => {
      if (wantsToPlay() && panel.hidden && !pointerOnHud) hideHUD();
    }, 4000);
  }

  function hideHUD() {
    clearTimeout(hudTimer);
    hudEl.classList.add('hud-hidden');
    hudEl.inert = true;
    closePanel();
  }

  // Using a control keeps the bar up; a mouse moving over the picture brings it back.
  let pointerOnHud = false;
  hudEl.addEventListener('pointerdown', () => { pointerOnHud = true; showHUD(); });
  window.addEventListener('pointerup', () => { if (pointerOnHud) { pointerOnHud = false; showHUD(); } });
  hudEl.addEventListener('input', showHUD);
  stage.addEventListener('mousemove', (e) => { if (state.hasVideo && !pointer && (e.movementX || e.movementY)) showHUD(); });

  // ── Play state ───────────────────────────────────────────────────
  // While the sound is catching up the picture is held, but the movie still
  // counts as playing so the button doesn't flicker.
  const wantsToPlay = () => (hold.active ? hold.resume : !video.paused);

  function syncUi() {
    const playing = wantsToPlay();
    $('play-icon').hidden = playing;
    $('pause-icon').hidden = !playing;
    const busy = current.loading || (state.hasVideo && ((hold.active && hold.resume) || video.seeking || waiting));
    $('buffering-overlay').hidden = !busy;
  }
  setInterval(syncUi, 400);

  function togglePlay() {
    if (!state.hasVideo) return;
    resumeAudio();
    if (hold.active) hold.resume = !hold.resume;
    else if (video.paused) video.play().catch(() => {});
    else video.pause();
    syncUi();
    showHUD();
  }

  function seekBy(seconds, flash = false) {
    if (!state.hasVideo) return;
    video.currentTime = Math.max(0, Math.min((video.duration || 0) - 1, video.currentTime + seconds));
    if (flash) {
      const f = $('seek-flash');
      f.textContent = seconds < 0 ? `Back ${-seconds} seconds` : `Forward ${seconds} seconds`;
      f.className = seconds < 0 ? 'flash-left' : 'flash-right';
      void f.offsetWidth; // restart the animation
      f.classList.add('flash-on');
    }
  }

  video.addEventListener('play', () => { waiting = false; syncUi(); showHUD(); });
  video.addEventListener('playing', () => { waiting = false; syncUi(); });
  video.addEventListener('waiting', () => { waiting = true; syncUi(); });
  video.addEventListener('canplay', () => { waiting = false; syncUi(); });
  video.addEventListener('seeked', syncUi);
  video.addEventListener('pause', () => {
    syncUi();
    if (!hold.active) { showHUD(); rememberProgress(); }
    if (lights.screenGlow) lights.screenGlow.intensity = 0.55;
  });
  video.addEventListener('ended', () => {
    if (current.movie) clearProgress(current.movie.name);
    syncUi();
    showHUD();
  });

  // ── Seek bar ─────────────────────────────────────────────────────
  const seekBar = $('seek-bar');
  let isSeeking = false;

  function drawSeek(fraction) {
    const f = Math.max(0, Math.min(1, fraction));
    $('seek-progress').style.transform = `scaleX(${f.toFixed(5)})`;
    $('seek-thumb').style.left = (f * 100).toFixed(3) + '%';
  }

  seekBar.addEventListener('pointerdown', () => { isSeeking = true; });
  seekBar.addEventListener('input', () => {
    isSeeking = true;
    const fraction = seekBar.value / 10000;
    $('current-time').textContent = fmtTime(fraction * (video.duration || 0));
    drawSeek(fraction);
  });
  seekBar.addEventListener('change', () => {
    if (state.hasVideo) video.currentTime = (seekBar.value / 10000) * (video.duration || 0);
    isSeeking = false;
  });

  let lastSave = 0;
  function rememberProgress() {
    if (current.movie && state.hasVideo) saveProgress(current.movie.name, video.currentTime, video.duration);
  }

  video.addEventListener('timeupdate', () => {
    if (!video.duration) return;
    if (!isSeeking) {
      const fraction = video.currentTime / video.duration;
      seekBar.value = Math.round(fraction * 10000);
      drawSeek(fraction);
      $('current-time').textContent = fmtTime(video.currentTime);
    }
    if (video.buffered.length > 0) {
      const end = video.buffered.end(video.buffered.length - 1);
      $('seek-buffered').style.transform = `scaleX(${Math.min(1, end / video.duration).toFixed(4)})`;
    }
    if (performance.now() - lastSave > 5000) { lastSave = performance.now(); rememberProgress(); }
  });
  window.addEventListener('pagehide', rememberProgress);

  // ── Volume ───────────────────────────────────────────────────────
  const volBar = $('volume-bar');
  let muted = false;

  function applyVolume() {
    const silent = muted || Number(volBar.value) === 0;
    setVolume(silent ? 0 : volBar.value / 100);
    $('vol-icon').hidden = silent;
    $('muted-icon').hidden = !silent;
  }
  volBar.value = settings.volume;
  volBar.addEventListener('input', () => { muted = false; saveSetting('volume', Number(volBar.value)); applyVolume(); });
  function toggleMute() {
    muted = !muted;
    if (!muted && Number(volBar.value) === 0) { volBar.value = 50; saveSetting('volume', 50); }
    applyVolume();
  }
  function nudgeVolume(step) {
    volBar.value = Math.max(0, Math.min(100, Number(volBar.value) + step));
    muted = false;
    saveSetting('volume', Number(volBar.value));
    applyVolume();
  }
  applyVolume();

  // ── Full screen ──────────────────────────────────────────────────
  function toggleFS() {
    const root = document.documentElement;
    if (document.fullscreenElement) return document.exitFullscreen();
    if (!root.requestFullscreen) return showToast('This browser has no full screen button. Open Help in the library for the car trick.');
    root.requestFullscreen().catch(() => showToast('This browser did not allow full screen. Open Help in the library for the car trick.'));
  }
  document.addEventListener('fullscreenchange', () => {
    const on = Boolean(document.fullscreenElement);
    $('fs-expand').hidden = on;
    $('fs-collapse').hidden = !on;
  });

  // ── Lights, view, quality ────────────────────────────────────────
  function toggleLights() {
    lightsOn = !lightsOn;
    lights.ceilSpots.forEach((s) => { s.intensity = lightsOn ? 4000.0 : 0; });
    lights.ambientLight.intensity = lightsOn ? 8.0 : 1.0;
    $('lights-btn').classList.toggle('active', lightsOn);
    $('lights-btn').setAttribute('aria-pressed', String(lightsOn));
  }

  function updateEngine() {
    engine.setActive(settings.view === 'theatre' && Boolean(current.movie) && !library.isOpen());
  }

  function setView(view) {
    saveSetting('view', view);
    document.body.classList.toggle('view-flat', view === 'flat');
    setNativeSubtitles(view === 'flat');
    updateEngine();
  }

  // ── Option panel ─────────────────────────────────────────────────
  function closePanel() {
    panel.hidden = true;
    hudEl.classList.remove('panel-open');
    delete panel.dataset.name;
    document.querySelectorAll('.ctrl-btn[data-panel]').forEach((b) => b.classList.remove('active'));
  }

  function option(label, active, run, hint) {
    return el('button', { class: 'option' + (active ? ' active' : ''), 'aria-pressed': String(active), onclick: () => { run(); openPanel(panel.dataset.name, true); } },
      el('span', { class: 'option-text' }, el('span', { text: label }), hint && el('small', { text: hint })),
      checkIcon(),
    );
  }

  // Material "check" glyph, same icon family as the rest of the controls
  function checkIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'option-check');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z');
    svg.append(path);
    return svg;
  }

  const section = (title, ...rows) => [el('h4', { text: title }), ...rows.flat()];

  const panels = {
    tracks: () => {
      const audio = current.tracks ? current.tracks.audioTracks : [];
      const subs = current.tracks ? current.tracks.subtitleTracks : [];
      const describe = (t) => (t.language && t.language !== 'Unknown' ? `${t.title} (${t.language})` : t.title);
      return {
        title: 'Audio & Subtitles',
        body: [
          ...section('Audio', audio.length
            ? audio.map((t) => option(describe(t), current.audioIndex === t.index, () => selectAudio(t.index), `${String(t.codec).toUpperCase()}, ${t.channels >= 6 ? '5.1 surround' : t.channels === 1 ? 'mono' : 'stereo'}`))
            : [el('p', { class: 'panel-note', text: 'This movie has one sound track.' })]),
          ...section('Subtitles',
            option('Off', current.subIndex === null, () => selectSubtitle(null)),
            subs.map((t) => option(describe(t), current.subIndex === t.index, () => selectSubtitle(t.index))),
            subs.length === 0 && el('p', { class: 'panel-note', text: 'This movie has no subtitles that can be shown.' })),
        ],
      };
    },
    seat: () => ({
      title: 'Seat',
      body: Object.entries(SEATS).map(([name, s]) => option(s.label, seat === name, () => setSeat(name))),
    }),
    speed: () => ({
      title: 'Speed',
      body: SPEEDS.map((r) => option(r === 1 ? 'Normal' : `${r}x`, video.playbackRate === r, () => {
        video.playbackRate = r;
        $('speed-label').textContent = `${r}x`;
      })),
    }),
    picture: () => ({
      title: 'Picture',
      body: [
        ...section('View',
          option('3D Cinema', settings.view === 'theatre', () => setView('theatre'), 'Sit in the theatre and look around'),
          option('Flat Screen', settings.view === 'flat', () => setView('flat'), 'Just the movie. Lightest on the device')),
        ...section('3D Quality', Object.entries(QUALITIES).map(([name, q]) => option(q.label, settings.quality === name, () => {
          saveSetting('quality', name);
          engine.setQuality(name);
        }, q.hint))),
        ...section('Which File to Play',
          option('Smaller converted copy when there is one', settings.preferCarCopy, () => saveSetting('preferCarCopy', true), 'Smoother over mobile internet'),
          option('Original file when this screen can play it', !settings.preferCarCopy, () => saveSetting('preferCarCopy', false), 'Best picture')),
      ],
    }),
  };

  function openPanel(name, keepOpen = false) {
    if (!keepOpen && panel.dataset.name === name) return closePanel();
    const { title, body } = panels[name]();
    $('panel-title').textContent = title;
    $('panel-body').replaceChildren(...body.filter(Boolean));
    panel.dataset.name = name;
    panel.hidden = false;
    hudEl.classList.add('panel-open');
    document.querySelectorAll('.ctrl-btn[data-panel]').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
    showHUD();
  }

  document.querySelectorAll('.ctrl-btn[data-panel]').forEach((btn) => {
    btn.addEventListener('click', () => openPanel(btn.dataset.panel));
  });
  $('panel-close').addEventListener('click', closePanel);
  panel.addEventListener('pointerdown', showHUD);

  // ── Tracks ───────────────────────────────────────────────────────
  function selectAudio(index, { autoplay = false } = {}) {
    current.audioIndex = index;
    // Always go through FFmpeg: it keeps 5.1 and plays codecs the browser can't.
    switchAudioTrack(urls.audio(current.source, index), { autoplay });
    syncUi();
  }

  function selectSubtitle(index) {
    current.subIndex = index;
    loadSubtitleTrack(index === null ? null : urls.subtitles(current.source, index));
  }

  // ── Opening and closing a movie ──────────────────────────────────
  function openMovie(movie, source, { keepFailed = false } = {}) {
    if (!keepFailed) current.failed = new Set();
    rememberProgress();

    initAudio(camera, scene, video);
    resumeAudio();
    applyVolume();
    stopExternalAudio();
    closePanel();
    closeDialog();

    Object.assign(current, { movie, source, tracks: null, audioIndex: null, subIndex: null, loading: true });
    $('hud-filename').textContent = movie.title;
    $('total-time').textContent = fmtTime(movie.duration || 0);
    $('current-time').textContent = fmtTime(0);
    drawSeek(0);
    $('lib-resume-btn').hidden = true;
    library.hide();
    hideHUD();
    syncUi();

    const saved = getProgress(movie.name);
    const startAt = saved ? saved.time : 0;
    const tracksPromise = api.metadata(source).catch(() => null);

    loadVideoUrl(urls.stream(source), {
      startAt,
      onReady: async () => {
        const tracks = await tracksPromise;
        if (current.source !== source) return; // another movie was opened meanwhile
        current.tracks = tracks;
        current.loading = false;
        $('total-time').textContent = fmtTime(video.duration || movie.duration || 0);
        video.playbackRate = 1;
        $('speed-label').textContent = '1x';

        if (tracks && tracks.audioTracks.length) selectAudio(tracks.audioTracks[0].index, { autoplay: true });
        else video.play().catch(() => {});

        showHUD();
        syncUi();
        if (startAt > 0) {
          showToast(`Picked up at ${fmtTime(startAt)}.`, { action: { label: 'Start Over', run: () => { video.currentTime = 0; } } });
        } else if (settings.view === 'theatre') {
          const hint = $('drag-hint');
          hint.hidden = false;
          setTimeout(() => { hint.hidden = true; }, 5000);
        }
      },
      onError: () => {
        if (current.source !== source) return;
        current.loading = false;
        current.failed.add(source);
        const next = pickSource(movie, current.failed);
        if (next) {
          showToast('That file would not play here. Trying the other copy.');
          return openMovie(movie, next, { keepFailed: true });
        }
        closeMovie();
        if (!movie.carCopy) library.offerConvert(movie);
        else showErr(`“${movie.title}” could not be played on this screen. Try the flat view, or convert it again.`);
      },
    });
  }

  function closeMovie() {
    rememberProgress();
    stopExternalAudio();
    unloadVideo();
    Object.assign(current, { movie: null, source: null, tracks: null, loading: false });
    hideHUD();
    syncUi();
    $('lib-resume-btn').hidden = true;
    if (!library.isOpen()) library.show();
  }

  // The Library button keeps the movie loaded and paused so it can be picked up again.
  function openLibrary() {
    if (state.hasVideo) {
      if (hold.active) hold.resume = false;
      else video.pause();
      rememberProgress();
      $('lib-resume-btn').hidden = false;
    }
    hideHUD();
    library.show();
  }

  function backToMovie() {
    library.hide();
    showHUD();
  }

  const library = initLibrary({ onPlay: openMovie, onShow: updateEngine, onHide: updateEngine });

  // ── Buttons and keys ─────────────────────────────────────────────
  $('play-btn').addEventListener('click', togglePlay);
  $('seek-back-btn').addEventListener('click', () => seekBy(-10));
  $('seek-fwd-btn').addEventListener('click', () => seekBy(10));
  $('mute-btn').addEventListener('click', toggleMute);
  $('lights-btn').addEventListener('click', toggleLights);
  $('fullscreen-btn').addEventListener('click', toggleFS);
  $('back-btn').addEventListener('click', openLibrary);
  $('lib-resume-btn').addEventListener('click', backToMovie);

  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) && e.target.type !== 'range') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.key === ' ' || e.key === 'Enter') && e.target.tagName === 'BUTTON') return; // the button handles it
    if (e.key === 'Escape') { if (!panel.hidden) closePanel(); return; }
    if (library.isOpen()) {
      if ((e.key === 'o' || e.key === 'O') && state.hasVideo) backToMovie();
      return;
    }
    // Tab brings the controls back so there is something to move through
    if (e.key === 'Tab' && state.hasVideo && hudEl.classList.contains('hud-hidden')) { showHUD(); return; }
    switch (e.key) {
      case ' ':          e.preventDefault(); togglePlay(); break;
      case 'ArrowLeft':  e.preventDefault(); seekBy(-10); showHUD(); break;
      case 'ArrowRight': e.preventDefault(); seekBy(10); showHUD(); break;
      case 'ArrowUp':    e.preventDefault(); nudgeVolume(10); showHUD(); break;
      case 'ArrowDown':  e.preventDefault(); nudgeVolume(-10); showHUD(); break;
      case 'f': case 'F': toggleFS(); break;
      case 'l': case 'L': toggleLights(); break;
      case 'm': case 'M': toggleMute(); break;
      case 'o': case 'O': openLibrary(); break;
    }
  });

  // ── Start ────────────────────────────────────────────────────────
  hudEl.inert = true;
  setView(settings.view);

  const bar = $('loading-bar'), ls = $('loading-screen');
  let pct = 0;
  const ti = setInterval(() => {
    pct += Math.random() * 16 + 7;
    bar.style.width = Math.min(pct, 95) + '%';
    if (pct >= 95) {
      clearInterval(ti);
      bar.style.width = '100%';
      setTimeout(() => {
        library.show();
        ls.classList.add('curtains-open');
        setTimeout(() => { ls.style.display = 'none'; }, 1300);
      }, 400);
    }
  }, 130);
}
