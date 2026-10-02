'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server');

const ffmpegBin = (() => {
  try { return require('ffmpeg-static') || 'ffmpeg'; } catch (err) { return 'ffmpeg'; }
})();

let tmp;
const servers = [];

// Starts the app on a free port and returns its base URL.
function listen(config) {
  const app = createApp({ port: 0, moviesDir: path.join(tmp, 'movies'), thumbnailsDir: path.join(tmp, 'thumbs'), secretFile: path.join(tmp, 'secret'), pin: '', ...config });
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      servers.push(server);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'theater-test-'));
  fs.mkdirSync(path.join(tmp, 'movies'));
  // A 3 second clip in a format browsers can't play (MPEG-4 Part 2 in MKV), with stereo sound and one subtitle.
  fs.writeFileSync(path.join(tmp, 'subs.srt'), '1\n00:00:00,500 --> 00:00:02,000\nHello from the test\n');
  const made = spawnSync(ffmpegBin, [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-i', path.join(tmp, 'subs.srt'),
    '-map', '0:v', '-map', '1:a', '-map', '2:s', '-c:v', 'mpeg4', '-c:a', 'ac3', '-ac', '2', '-c:s', 'srt',
    path.join(tmp, 'movies', 'Test Movie.mkv'),
  ]);
  assert.equal(made.status, 0, `could not make the test clip: ${made.stderr}`);
  fs.writeFileSync(path.join(tmp, 'movies', 'notes.txt'), 'not a movie');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'outside the movies folder');
});

after(() => {
  for (const server of servers) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('library lists movies with their details and ignores other files', async () => {
  const base = await listen();
  const movies = await (await fetch(`${base}/api/movies`)).json();
  assert.equal(movies.length, 1);
  assert.equal(movies[0].name, 'Test Movie.mkv');
  assert.equal(movies[0].title, 'Test Movie');
  assert.equal(movies[0].video.codec, 'mpeg4');
  assert.equal(movies[0].video.height, 360);
  assert.ok(movies[0].duration > 2.5 && movies[0].duration < 3.5);
  assert.equal(movies[0].subtitleCount, 1);
  assert.equal(movies[0].carCopy, null);
});

test('files outside the movies folder cannot be reached', async () => {
  const base = await listen();
  for (const name of ['..%2Fsecret.txt', '..%2F..%2Fetc%2Fpasswd', 'notes.txt', '.hidden.mp4']) {
    for (const route of ['stream', 'api/metadata', 'thumbnail']) {
      const res = await fetch(`${base}/${route}/${name}`);
      assert.equal(res.status, 404, `${route}/${name}`);
    }
  }
});

test('server code and settings are not served as web pages', async () => {
  const base = await listen();
  for (const file of ['server.js', 'config.json', 'package.json', '.theater-secret', 'node_modules/express/package.json']) {
    const res = await fetch(`${base}/${file}`);
    assert.equal(res.status, 404, file);
  }
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/js/main.js`)).status, 200);
  assert.equal((await fetch(`${base}/vendor/three/build/three.module.js`)).status, 200);
});

test('streaming supports byte ranges', async () => {
  const base = await listen();
  const url = `${base}/stream/${encodeURIComponent('Test Movie.mkv')}`;
  const size = fs.statSync(path.join(tmp, 'movies', 'Test Movie.mkv')).size;

  const part = await fetch(url, { headers: { Range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-99/${size}`);
  assert.equal((await part.arrayBuffer()).byteLength, 100);

  const tail = await fetch(url, { headers: { Range: 'bytes=-10' } });
  assert.equal(tail.status, 206);
  assert.equal((await tail.arrayBuffer()).byteLength, 10);

  const bad = await fetch(url, { headers: { Range: `bytes=${size + 5}-` } });
  assert.equal(bad.status, 416);
});

test('subtitles come out as WebVTT and audio as WebM', async () => {
  const base = await listen();
  const name = encodeURIComponent('Test Movie.mkv');
  const meta = await (await fetch(`${base}/api/metadata/${name}`)).json();
  assert.equal(meta.audioTracks.length, 1);
  assert.equal(meta.subtitleTracks.length, 1);

  const vtt = await (await fetch(`${base}/subtitles/${name}/${meta.subtitleTracks[0].index}`)).text();
  assert.match(vtt, /^WEBVTT/);
  assert.match(vtt, /Hello from the test/);

  const audio = await fetch(`${base}/audio/${name}/${meta.audioTracks[0].index}?start=1`);
  assert.equal(audio.headers.get('content-type'), 'audio/webm');
  const bytes = new Uint8Array(await audio.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 4)], [0x1a, 0x45, 0xdf, 0xa3], 'starts with the WebM header');
});

test('with a PIN set, nothing opens until the right PIN is entered', async () => {
  const base = await listen({ pin: '4821' });

  assert.equal((await fetch(`${base}/api/movies`)).status, 401);
  assert.equal((await fetch(`${base}/stream/${encodeURIComponent('Test Movie.mkv')}`)).status, 401);
  const page = await fetch(`${base}/`, { redirect: 'manual', headers: { Accept: 'text/html' } });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');
  assert.equal((await fetch(`${base}/login`)).status, 200);

  const post = (pin) => fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
  });
  assert.equal((await post('0000')).status, 401);

  const ok = await post('4821');
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await fetch(`${base}/api/movies`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${base}/api/movies`, { headers: { Cookie: 'theater_session=wrong' } })).status, 401);
});

test('repeated wrong PINs get locked out', async () => {
  const base = await listen({ pin: '4821' });
  const post = (pin) => fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
  });
  for (let i = 0; i < 8; i++) assert.equal((await post('1111')).status, 401);
  assert.equal((await post('1111')).status, 429);
  assert.equal((await post('4821')).status, 429, 'even the right PIN waits out the lock');
});

test('converting makes a car copy that the library attaches to the original', async () => {
  const base = await listen();
  const name = encodeURIComponent('Test Movie.mkv');

  const started = await fetch(`${base}/api/convert/${name}?height=720`, { method: 'POST' });
  assert.equal(started.status, 202);
  assert.equal((await fetch(`${base}/api/convert/${name}`, { method: 'POST' })).status, 409, 'one conversion at a time');

  let job;
  for (let i = 0; i < 100; i++) {
    job = (await (await fetch(`${base}/api/convert`)).json()).job;
    if (job.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.equal(job.state, 'done', job.error || 'conversion did not finish');
  assert.equal(job.output, 'Test Movie.car.mp4');
  assert.ok(!fs.existsSync(path.join(tmp, 'movies', 'Test Movie.car.mp4.part')));

  const movies = await (await fetch(`${base}/api/movies`)).json();
  assert.equal(movies.length, 1, 'the copy is not listed as a second movie');
  assert.equal(movies[0].carCopy.name, 'Test Movie.car.mp4');
  assert.equal(movies[0].carCopy.video.codec, 'h264');
  assert.equal(movies[0].carCopy.video.height, 360, 'never upscaled');

  const copyMeta = await (await fetch(`${base}/api/metadata/${encodeURIComponent('Test Movie.car.mp4')}`)).json();
  assert.equal(copyMeta.audioTracks[0].codec, 'aac');
  assert.equal(copyMeta.subtitleTracks.length, 1, 'subtitles are kept');
});
