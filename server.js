'use strict';

const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const VERSION = require('./package.json').version;
const VIDEO_EXT = /\.(mp4|mkv|webm|mov|m4v|ogv)$/i;
const CAR_COPY_SUFFIX = '.car.mp4';
const CONTENT_TYPES = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.ogv': 'video/ogg',
};
// Subtitle codecs FFmpeg can turn into WebVTT / mov_text. Picture-based ones (PGS, DVD) can't.
const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);

// ── Settings ───────────────────────────────────────────────────────
// Read from config.json next to this file, with environment variables on top.
function expandHome(p) {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

function loadConfig(overrides = {}) {
  let file = {};
  const configPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      file = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      console.error(`config.json could not be read (${err.message}). Using defaults.`);
    }
  }
  const pick = (envName, key, fallback) => overrides[key] ?? process.env[envName] ?? file[key] ?? fallback;
  return {
    port: Number(pick('PORT', 'port', 3000)),
    moviesDir: path.resolve(__dirname, expandHome(String(pick('MOVIES_DIR', 'moviesDir', 'movies')))),
    thumbnailsDir: path.resolve(__dirname, expandHome(String(pick('THUMBNAILS_DIR', 'thumbnailsDir', 'thumbnails')))),
    pin: String(pick('ACCESS_PIN', 'pin', '')).trim(),
  };
}

// ── FFmpeg ─────────────────────────────────────────────────────────
// The bundled binaries don't exist for every platform (Android/Termux has none),
// so fall back to whatever `ffmpeg` / `ffprobe` is installed on the system.
function binaryRuns(bin) {
  const result = spawnSync(bin, ['-version'], { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function pickBinary(envName, loadBundled, systemName) {
  if (process.env[envName]) return process.env[envName];
  // ffprobe-static calls process.exit() on Android instead of throwing, so don't load it there.
  if (process.platform === 'android') return systemName;
  try {
    const bundled = loadBundled();
    if (bundled && fs.existsSync(bundled) && binaryRuns(bundled)) return bundled;
  } catch (err) {
    // optional dependency not installed
  }
  return systemName;
}

const ffmpegPath = pickBinary('FFMPEG_PATH', () => require('ffmpeg-static'), 'ffmpeg');
const ffprobePath = pickBinary('FFPROBE_PATH', () => require('ffprobe-static').path, 'ffprobe');
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

function getLanAddresses() {
  const addresses = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) addresses.push(iface.address);
    }
  }
  return addresses;
}

function createApp(config) {
  for (const dir of [config.moviesDir, config.thumbnailsDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const app = express();
  app.disable('x-powered-by');
  // A reverse proxy on this machine may sit in front; trust its forwarded headers.
  app.set('trust proxy', 'loopback');

  // ── Access PIN ───────────────────────────────────────────────────
  // The session cookie is derived from the PIN and a secret kept on disk, so a
  // restart doesn't sign the car out but changing the PIN does.
  const secretPath = config.secretFile || path.join(__dirname, '.theater-secret');
  let secret;
  try {
    secret = fs.readFileSync(secretPath, 'utf8').trim();
  } catch (err) {
    secret = crypto.randomBytes(32).toString('hex');
    try { fs.writeFileSync(secretPath, secret, { mode: 0o600 }); } catch (writeErr) { /* keep in memory */ }
  }
  const sessionToken = crypto.createHmac('sha256', secret).update(`session:${config.pin}`).digest('hex');

  function safeEqual(a, b) {
    const x = crypto.createHash('sha256').update(String(a)).digest();
    const y = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
  }

  function readCookie(req, name) {
    const header = req.headers.cookie || '';
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq > -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return '';
  }

  const isAuthed = (req) => !config.pin || safeEqual(readCookie(req, 'theater_session'), sessionToken);

  // Wrong-PIN limiter: 8 tries per visitor and 40 in total every 5 minutes.
  const attempts = new Map();
  const WINDOW_MS = 5 * 60 * 1000;
  function tooManyAttempts(key, limit) {
    const now = Date.now();
    const entry = attempts.get(key);
    if (!entry || now > entry.resetAt) {
      attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
      return false;
    }
    entry.count += 1;
    return entry.count > limit;
  }

  app.get('/login', (req, res) => {
    if (isAuthed(req)) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'login.html'));
  });

  app.post('/api/login', express.json({ limit: '1kb' }), (req, res) => {
    if (!config.pin) return res.json({ ok: true });
    const visitor = req.headers['cf-connecting-ip'] || req.ip || 'unknown';
    if (tooManyAttempts(`ip:${visitor}`, 8) || tooManyAttempts('all', 40)) {
      return res.status(429).json({ error: 'Too many tries. Wait 5 minutes and try again.' });
    }
    if (!safeEqual(req.body?.pin ?? '', config.pin)) {
      return res.status(401).json({ error: 'Wrong PIN.' });
    }
    attempts.delete(`ip:${visitor}`);
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `theater_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`);
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'theater_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
    res.json({ ok: true });
  });

  app.use((req, res, next) => {
    if (isAuthed(req)) return next();
    // Only a browser asking for a page is sent to the PIN screen; everything else just gets refused.
    const wantsPage = req.method === 'GET' && String(req.headers.accept || '').includes('text/html');
    if (wantsPage && !req.path.startsWith('/api/')) return res.redirect('/login');
    res.status(401).json({ error: 'PIN required' });
  });

  // ── Front end ────────────────────────────────────────────────────
  // Only these folders are public. The project root also holds config.json
  // (with the PIN) and the server code, so it must not be served as a whole.
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  app.use('/css', express.static(path.join(__dirname, 'css')));
  app.use('/js', express.static(path.join(__dirname, 'js')));
  app.use('/assets', express.static(path.join(__dirname, 'assets')));
  const threeDir = path.join(__dirname, 'node_modules', 'three');
  app.use('/vendor/three/build', express.static(path.join(threeDir, 'build')));
  app.use('/vendor/three/examples/jsm', express.static(path.join(threeDir, 'examples', 'jsm')));

  // ── Movie files ──────────────────────────────────────────────────
  // A movie name must be a plain file name inside the movies folder.
  function resolveMovie(name) {
    if (typeof name !== 'string' || !name || name !== path.basename(name) || name.startsWith('.')) return null;
    if (!VIDEO_EXT.test(name)) return null;
    const file = path.join(config.moviesDir, name);
    try {
      return fs.statSync(file).isFile() ? file : null;
    } catch (err) {
      return null;
    }
  }

  function movieParam(req, res, next) {
    const file = resolveMovie(req.params.filename);
    if (!file) return res.status(404).json({ error: 'Movie not found' });
    req.movieFile = file;
    next();
  }

  const probeCache = new Map();
  function probe(name) {
    const file = path.join(config.moviesDir, name);
    const stat = fs.statSync(file);
    const key = `${stat.size}:${stat.mtimeMs}`;
    const cached = probeCache.get(name);
    if (cached && cached.key === key) return Promise.resolve(cached.info);

    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(file, (err, metadata) => {
        if (err) return reject(err);
        const info = { size: stat.size, duration: Number(metadata.format?.duration) || 0, video: null, audioTracks: [], subtitleTracks: [] };
        for (const stream of metadata.streams) {
          const tags = stream.tags || {};
          const language = tags.language || tags.LANGUAGE || 'Unknown';
          if (stream.codec_type === 'video' && !info.video && stream.disposition?.attached_pic !== 1) {
            info.video = {
              codec: stream.codec_name,
              width: stream.width,
              height: stream.height,
              hdr: ['smpte2084', 'arib-std-b67'].includes(stream.color_transfer),
            };
          } else if (stream.codec_type === 'audio') {
            info.audioTracks.push({
              index: stream.index,
              language,
              title: tags.title || tags.TITLE || `Audio Track ${info.audioTracks.length + 1}`,
              codec: stream.codec_name,
              channels: stream.channels,
            });
          } else if (stream.codec_type === 'subtitle') {
            info.subtitleTracks.push({
              index: stream.index,
              language,
              title: tags.title || tags.TITLE || `Subtitle Track ${info.subtitleTracks.length + 1}`,
              codec: stream.codec_name,
              text: TEXT_SUBS.has(stream.codec_name),
            });
          }
        }
        probeCache.set(name, { key, info });
        resolve(info);
      });
    });
  }

  const carCopyName = (name) => name.replace(VIDEO_EXT, '') + CAR_COPY_SUFFIX;

  // 1. Library: every movie with what the page needs to draw its card.
  //    A "<name>.car.mp4" next to "<name>.mkv" is that movie's converted copy,
  //    so it is reported on the original instead of as its own movie.
  app.get('/api/movies', async (req, res) => {
    let files;
    try {
      files = (await fs.promises.readdir(config.moviesDir)).filter((f) => resolveMovie(f));
    } catch (err) {
      return res.status(500).json({ error: 'Failed to read movies directory' });
    }
    const all = new Set(files);
    const isCopyOfListed = (f) => f.endsWith(CAR_COPY_SUFFIX)
      && files.some((o) => o !== f && !o.endsWith(CAR_COPY_SUFFIX) && carCopyName(o) === f);

    const movies = [];
    for (const name of files.filter((f) => !isCopyOfListed(f)).sort((a, b) => a.localeCompare(b))) {
      const movie = { name, title: name.replace(CAR_COPY_SUFFIX, '').replace(VIDEO_EXT, ''), carCopy: null };
      try {
        const info = await probe(name);
        Object.assign(movie, {
          size: info.size,
          duration: info.duration,
          video: info.video,
          audioCount: info.audioTracks.length,
          surround: info.audioTracks.some((t) => t.channels >= 6),
          subtitleCount: info.subtitleTracks.filter((t) => t.text).length,
        });
        const copy = carCopyName(name);
        if (copy !== name && all.has(copy)) {
          const copyInfo = await probe(copy);
          movie.carCopy = { name: copy, video: copyInfo.video, size: copyInfo.size };
        }
      } catch (err) {
        movie.error = 'This file could not be read.';
      }
      movies.push(movie);
    }
    res.json(movies);
  });

  // 2. Audio and subtitle tracks of one movie.
  app.get('/api/metadata/:filename', movieParam, async (req, res) => {
    try {
      const info = await probe(req.params.filename);
      res.json({
        duration: info.duration,
        video: info.video,
        audioTracks: info.audioTracks,
        subtitleTracks: info.subtitleTracks.filter((t) => t.text),
      });
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ error: 'Failed to probe file' });
    }
  });

  // 3. Stream the video file, with byte ranges so seeking works.
  app.get('/stream/:filename', movieParam, (req, res) => {
    const file = req.movieFile;
    const fileSize = fs.statSync(file).size;
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;

    if (!range) {
      res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': type, 'Accept-Ranges': 'bytes' });
      return fs.createReadStream(file).pipe(res);
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = match && match[1] !== '' ? parseInt(match[1], 10) : NaN;
    let end = match && match[2] !== '' ? parseInt(match[2], 10) : fileSize - 1;
    if (match && match[1] === '' && match[2] !== '') {
      // "bytes=-500" means the last 500 bytes
      start = Math.max(0, fileSize - parseInt(match[2], 10));
      end = fileSize - 1;
    }
    end = Math.min(end, fileSize - 1);
    if (!match || Number.isNaN(start) || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      return res.end();
    }

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  });

  // 4. Extract one subtitle track as WebVTT on the fly.
  app.get('/subtitles/:filename/:trackIndex', movieParam, (req, res) => {
    const trackIndex = parseInt(req.params.trackIndex, 10);
    if (!Number.isInteger(trackIndex) || trackIndex < 0) return res.status(400).send('Bad track');

    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=3600');

    const command = ffmpeg(req.movieFile)
      .outputOptions([`-map 0:${trackIndex}`, '-f webvtt'])
      .on('error', () => { /* expected when the browser disconnects */ });
    command.pipe(res, { end: true });
    req.on('close', () => command.kill('SIGKILL'));
  });

  // 5. Transcode one audio track to WebM Opus on the fly (keeps 5.1 surround).
  app.get('/audio/:filename/:trackIndex', movieParam, (req, res) => {
    const trackIndex = parseInt(req.params.trackIndex, 10);
    if (!Number.isInteger(trackIndex) || trackIndex < 0) return res.status(400).send('Bad track');
    const start = Math.max(0, parseFloat(req.query.start) || 0);

    res.setHeader('Content-Type', 'audio/webm');

    const command = ffmpeg(req.movieFile)
      .setStartTime(start)
      .outputOptions([`-map 0:${trackIndex}`, '-c:a libopus', '-b:a 320k', '-ac 6', '-f webm'])
      .on('error', () => { /* expected when the browser disconnects while seeking */ });
    command.pipe(res);

    // Without this, an FFmpeg process is left running every time the browser seeks.
    req.on('close', () => command.kill('SIGKILL'));
  });

  // 6. Poster frame, made once and then kept in the thumbnails folder.
  app.get('/thumbnail/:filename', movieParam, async (req, res) => {
    const thumbName = `${req.params.filename}.jpg`;
    const thumbPath = path.join(config.thumbnailsDir, thumbName);
    if (fs.existsSync(thumbPath)) return res.sendFile(thumbPath);

    let seconds = 600;
    try {
      const info = await probe(req.params.filename);
      if (info.duration) seconds = Math.min(600, info.duration * 0.1);
    } catch (err) { /* fall back to the 10 minute mark */ }

    ffmpeg(req.movieFile)
      .screenshots({ timestamps: [seconds], filename: thumbName, folder: config.thumbnailsDir, size: '480x270' })
      .on('end', () => {
        if (fs.existsSync(thumbPath)) res.sendFile(thumbPath);
        else res.status(500).send('Error generating thumbnail');
      })
      .on('error', (err) => {
        console.error('Thumbnail error:', err.message);
        if (!res.headersSent) res.status(500).send('Error generating thumbnail');
      });
  });

  // 7. Convert a movie to H.264 MP4, the format car and phone browsers can play.
  //    One conversion at a time. The result is "<name>.car.mp4" in the movies folder.
  let job = null;
  let hasToneMapping = null;

  const jobStatus = () => (job ? {
    name: job.name, output: job.output, height: job.height, state: job.state,
    percent: job.percent, error: job.error, startedAt: job.startedAt,
  } : null);

  app.get('/api/convert', (req, res) => res.json({ job: jobStatus() }));

  app.post('/api/convert/:filename', movieParam, async (req, res) => {
    if (job && job.state === 'running') {
      return res.status(409).json({ error: `Already converting "${job.name}". Wait for it to finish or cancel it.`, job: jobStatus() });
    }
    const name = req.params.filename;
    if (name.endsWith(CAR_COPY_SUFFIX)) return res.status(400).json({ error: 'This is already a converted copy.' });
    const height = [480, 720, 1080].includes(Number(req.query.height)) ? Number(req.query.height) : 1080;

    let info;
    try {
      info = await probe(name);
    } catch (err) {
      return res.status(500).json({ error: 'This file could not be read.' });
    }
    if (!info.video) return res.status(400).json({ error: 'This file has no video.' });

    if (hasToneMapping === null) {
      const filters = spawnSync(ffmpegPath, ['-hide_banner', '-filters'], { encoding: 'utf8' });
      hasToneMapping = / zscale /.test(filters.stdout || '') && / tonemap /.test(filters.stdout || '');
    }

    const output = carCopyName(name);
    const finalPath = path.join(config.moviesDir, output);
    const partPath = `${finalPath}.part`;

    // Never upscale; keep the width even. HDR needs tone mapping or it looks washed out.
    const filters = [`scale=-2:'min(ih,${height})'`];
    if (info.video.hdr && hasToneMapping) {
      filters.push('zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709',
        'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv');
    }
    filters.push('format=yuv420p');

    const options = ['-map', '0:v:0', '-map', '0:a?'];
    const textSubs = info.subtitleTracks.filter((t) => t.text);
    for (const sub of textSubs) options.push('-map', `0:${sub.index}`);
    options.push(
      '-vf', filters.join(','),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '320k',
      '-movflags', '+faststart', '-max_muxing_queue_size', '4096', '-f', 'mp4',
    );
    if (textSubs.length) options.push('-c:s', 'mov_text');

    job = { name, output, height, state: 'running', percent: 0, error: null, startedAt: Date.now(), command: null };
    const thisJob = job;
    const cleanup = () => fs.rm(partPath, { force: true }, () => {});

    thisJob.command = ffmpeg(req.movieFile)
      .outputOptions(options)
      .on('progress', (progress) => {
        const parts = String(progress.timemark || '').split(':').map(Number);
        if (parts.length === 3 && info.duration && parts.every((n) => !Number.isNaN(n))) {
          const done = parts[0] * 3600 + parts[1] * 60 + parts[2];
          thisJob.percent = Math.max(0, Math.min(99.9, (done / info.duration) * 100));
        }
      })
      .on('end', () => {
        fs.rename(partPath, finalPath, (err) => {
          if (err) {
            thisJob.state = 'error';
            thisJob.error = 'The converted file could not be saved.';
            return cleanup();
          }
          thisJob.state = 'done';
          thisJob.percent = 100;
        });
      })
      .on('error', (err) => {
        if (thisJob.state === 'cancelled') return cleanup();
        thisJob.state = 'error';
        thisJob.error = String(err.message || err).split('\n').pop().slice(0, 300);
        console.error('Convert error:', err.message);
        cleanup();
      })
      .save(partPath);

    res.status(202).json({ job: jobStatus() });
  });

  app.delete('/api/convert', (req, res) => {
    if (job && job.state === 'running') {
      job.state = 'cancelled';
      job.command.kill('SIGKILL');
    }
    res.json({ job: jobStatus() });
  });

  // 8. What the Help panel shows.
  app.get('/api/info', (req, res) => {
    res.json({ version: VERSION, pinEnabled: Boolean(config.pin), port: config.port, addresses: getLanAddresses() });
  });

  app.stopJobs = () => {
    if (job && job.state === 'running') {
      job.state = 'cancelled';
      job.command.kill('SIGKILL');
    }
  };

  return app;
}

function start(overrides = {}) {
  const config = loadConfig(overrides);
  const app = createApp(config);

  return new Promise((resolve, reject) => {
    const server = app.listen(config.port, '0.0.0.0', () => {
      console.log('===========================================');
      console.log('🍿 3D Cinema Media Server is running!');
      console.log(`🎬 On this device:    http://localhost:${config.port}`);
      for (const addr of getLanAddresses()) {
        console.log(`📶 Same WiFi/hotspot: http://${addr}:${config.port}`);
      }
      console.log(`📁 Movies folder:     ${config.moviesDir}`);
      console.log(config.pin ? '🔒 A PIN is required to open the library.' : '🔓 No PIN set (fine at home, not for sharing over the internet).');
      if (!binaryRuns(ffmpegPath) || !binaryRuns(ffprobePath)) {
        console.log('⚠️  FFmpeg was not found. Install it (on Termux: pkg install ffmpeg) or movies will not load.');
      }
      console.log('===========================================');
      resolve({ server, app, config });
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${config.port} is already in use. Close the other server or set PORT to another number.`);
      }
      reject(err);
    });
    server.on('close', () => app.stopJobs());
  });
}

module.exports = { start, loadConfig, createApp, getLanAddresses };

if (require.main === module) {
  start().catch(() => process.exit(1));
}
