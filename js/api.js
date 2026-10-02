// All requests go to the same address the page was opened from, so the app
// works the same on this computer, over WiFi and over the internet.

const enc = encodeURIComponent;

export const urls = {
  stream: (name) => `/stream/${enc(name)}`,
  thumbnail: (name) => `/thumbnail/${enc(name)}`,
  audio: (name, index) => `/audio/${enc(name)}/${index}`,
  subtitles: (name, index) => `/subtitles/${enc(name)}/${index}`,
};

async function request(path, options) {
  const res = await fetch(path, options);
  if (res.status === 401) {
    // The PIN was changed or the session ran out.
    location.href = '/login';
    throw new Error('PIN required');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The server answered with an error (${res.status}).`);
  return data;
}

export const api = {
  movies: () => request('/api/movies'),
  metadata: (name) => request(`/api/metadata/${enc(name)}`),
  info: () => request('/api/info'),
  convertStatus: () => request('/api/convert'),
  convert: (name, height) => request(`/api/convert/${enc(name)}?height=${height}`, { method: 'POST' }),
  cancelConvert: () => request('/api/convert', { method: 'DELETE' }),
  logout: () => request('/api/logout', { method: 'POST' }),
};
