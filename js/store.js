// Settings and watch progress, remembered in this browser.
// Everything still works when storage is blocked; it just isn't remembered.

export const isCarBrowser = /Tesla\/|QtCarBrowser/i.test(navigator.userAgent);

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // storage full or blocked
  }
}

// A car's computer is much weaker than a laptop's graphics card, so it starts
// in the lighter picture mode and prefers the smaller converted copies.
const defaults = {
  quality: isCarBrowser ? 'smooth' : 'auto',   // 'auto' | 'smooth' | 'best'
  view: 'theatre',                             // 'theatre' | 'flat'
  preferCarCopy: isCarBrowser,
  volume: 100,
};

export const settings = { ...defaults, ...read('cinema.settings', {}) };

export function saveSetting(key, value) {
  settings[key] = value;
  write('cinema.settings', settings);
}

// ── Watch progress ─────────────────────────────────────────────────
const progress = read('cinema.progress', {});

export function getProgress(name) {
  return progress[name] || null;
}

export function saveProgress(name, time, duration) {
  if (!name || !duration) return;
  // Near the end counts as finished: forget it so the movie starts over next time.
  if (time > duration - Math.min(120, duration * 0.05)) delete progress[name];
  else if (time > 20) progress[name] = { time, duration, at: Date.now() };
  else return;
  write('cinema.progress', progress);
}

export function clearProgress(name) {
  delete progress[name];
  write('cinema.progress', progress);
}

export function recentProgress() {
  return Object.entries(progress)
    .map(([name, p]) => ({ name, ...p }))
    .sort((a, b) => b.at - a.at);
}
