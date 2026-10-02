export function fmtTime(s) {
  if (!isFinite(s) || isNaN(s)) return '0:00:00';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = Math.floor(s % 60);
  return h + ':' + String(m).padStart(2, '0') + ':' + String(sc).padStart(2, '0');
}

// "2 h 14 min" for movie cards
export function fmtDuration(s) {
  if (!s || !isFinite(s)) return '';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  if (h === 0) return m < 1 ? `${Math.round(s)} sec` : `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function fmtSize(bytes) {
  if (!bytes) return '';
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function resolutionLabel(video) {
  if (!video || !video.height) return '';
  const w = video.width || 0, h = video.height;
  if (w >= 3200 || h >= 1800) return '4K';
  if (w >= 1800 || h >= 1000) return '1080p';
  if (w >= 1200 || h >= 700) return '720p';
  return `${h}p`;
}

// Build an element: el('div', { class: 'x', text: 'hi', onclick: fn }, child, child)
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child);
  }
  return node;
}

let toastTimer = null;

// A short message at the bottom. `action` adds a button: { label, run }.
export function showToast(msg, { error = false, action = null, ms = 5000 } = {}) {
  const toast = document.getElementById('toast');
  const btn = document.getElementById('toast-action');
  document.getElementById('toast-msg').textContent = msg;
  toast.classList.toggle('toast-error', error);
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => { toast.hidden = true; action.run(); };
  }
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, ms);
}

export const showErr = (msg) => showToast(msg, { error: true, ms: 7000 });
