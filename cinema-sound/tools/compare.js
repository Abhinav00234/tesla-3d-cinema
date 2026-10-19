// Checks that Cinema Sound's engine sounds the same as the 3D Cinema's.
//
// Renders the same audio file twice in Chromium: once through
// web/js/engine.js, and once through the 3D Cinema's own graph built with
// three.js AudioListener and PositionalAudio exactly as js/audioManager.js
// builds it (with an audio buffer as the source instead of the video).
// Both use the same reverb impulse response, since the 3D Cinema makes
// its own from Math.random.
//
// In the repository root:
//   npm install
//   npm install --no-save playwright && npx playwright install chromium
//   node cinema-sound/tools/compare.js song.mp3
//
// Prints, for every seat, how far apart the two are. Below -60 dB means
// they are the same apart from rounding.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..');
const HOST = 'https://compare.local';

async function main() {
  const song = process.argv[2];
  if (!song) {
    console.error('Usage: node cinema-sound/tools/compare.js <audio file>');
    process.exit(2);
  }
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.route(HOST + '/**', (route) => {
    const url = new URL(route.request().url());
    const files = {
      '/': ['<!doctype html><meta charset="utf-8"><body>', 'text/html'],
      '/song': [fs.readFileSync(song), 'application/octet-stream'],
      '/engine.js': [fs.readFileSync(path.join(ROOT, 'cinema-sound/web/js/engine.js')), 'text/javascript'],
      '/three.module.js': [fs.readFileSync(path.join(ROOT, 'node_modules/three/build/three.module.js')), 'text/javascript'],
      '/config.js': [fs.readFileSync(path.join(ROOT, 'js/config.js')), 'text/javascript'],
    };
    const f = files[url.pathname];
    if (!f) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ body: f[0], contentType: f[1] });
  });
  await page.goto(HOST + '/');
  await page.addScriptTag({ url: HOST + '/engine.js' });

  const results = await page.evaluate(async () => {
    const THREE = await import('/three.module.js');
    const { ROOM_W, ROOM_H, SCR_W, SCR_Z, SCR_Y, BASE_PITCH } = await import('/config.js');
    const E = window.CinemaEngine;
    const RATE = 44100;
    const bytes = await (await fetch('/song')).arrayBuffer();
    const buffer = await E.decode(bytes, RATE);
    // The 3D Cinema plays a mono track from the left speaker only; Cinema
    // Sound sends it to both, so the two can't match
    if (buffer.numberOfChannels < 2) return null;
    const length = buffer.length + Math.ceil(3.5 * RATE);

    // js/audioManager.js initAudio(), with `buffer` in place of the video
    async function original(seat) {
      const ctx = new OfflineAudioContext(2, length, RATE);
      THREE.AudioContext.setContext(ctx);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera();
      camera.position.set(...seat.position);
      camera.rotation.y = seat.yaw;
      camera.rotation.x = BASE_PITCH + seat.pitch;
      scene.add(camera);

      const audioListener = new THREE.AudioListener();
      camera.add(audioListener);
      const masterCompressor = ctx.createDynamicsCompressor();
      masterCompressor.threshold.value = -6;
      masterCompressor.knee.value = 15;
      masterCompressor.ratio.value = 3;
      masterCompressor.attack.value = 0.005;
      masterCompressor.release.value = 0.1;
      audioListener.gain.disconnect();
      audioListener.gain.connect(masterCompressor);
      masterCompressor.connect(ctx.destination);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const videoGainNode = ctx.createGain();
      source.connect(videoGainNode);
      const audioSplitter = ctx.createChannelSplitter(6);
      videoGainNode.connect(audioSplitter);

      const convolver = ctx.createConvolver();
      convolver.buffer = E.impulseResponse(ctx); // the 3D Cinema's is random
      const reverbGain = ctx.createGain(); reverbGain.gain.value = 0.08;
      convolver.connect(reverbGain);
      reverbGain.connect(audioListener.getInput());
      const reverbMix = ctx.createGain();
      audioSplitter.connect(reverbMix, 0);
      audioSplitter.connect(reverbMix, 1);
      reverbMix.connect(convolver);

      function createSpeaker(x, y, z, refDist = 12) {
        const speaker = new THREE.PositionalAudio(audioListener);
        speaker.setRefDistance(refDist);
        speaker.setRolloffFactor(1);
        speaker.setDistanceModel('exponential');
        speaker.position.set(x, y, z);
        scene.add(speaker);
        return speaker;
      }
      const frontLeft = createSpeaker(-SCR_W / 2 - 2, SCR_Y, SCR_Z);
      const flGain = ctx.createGain(); flGain.gain.value = 0.8;
      audioSplitter.connect(flGain, 0); frontLeft.setNodeSource(flGain);
      const frontRight = createSpeaker(SCR_W / 2 + 2, SCR_Y, SCR_Z);
      const frGain = ctx.createGain(); frGain.gain.value = 0.8;
      audioSplitter.connect(frGain, 1); frontRight.setNodeSource(frGain);
      const center = createSpeaker(0, SCR_Y, SCR_Z);
      const centerGain = ctx.createGain(); centerGain.gain.value = 1.2;
      audioSplitter.connect(centerGain, 2); center.setNodeSource(centerGain);
      const sub = createSpeaker(0, 0.5, SCR_Z + 2);
      const subFilter = ctx.createBiquadFilter();
      subFilter.type = 'lowpass'; subFilter.frequency.value = 120;
      const subGain = ctx.createGain(); subGain.gain.value = 1.0;
      audioSplitter.connect(subGain, 3);
      const bassMix = ctx.createGain(); bassMix.gain.value = 0.5;
      audioSplitter.connect(bassMix, 0); audioSplitter.connect(bassMix, 1);
      bassMix.connect(subFilter); subFilter.connect(subGain);
      sub.setNodeSource(subGain);
      const surrLeft = createSpeaker(-ROOM_W / 2 + 1, ROOM_H * 0.7, 5, 8);
      const slGain = ctx.createGain(); slGain.gain.value = 0.7;
      audioSplitter.connect(slGain, 4);
      const slDelay = ctx.createDelay(); slDelay.delayTime.value = 0.045;
      const slBleed = ctx.createGain(); slBleed.gain.value = 0.15;
      audioSplitter.connect(slDelay, 0); slDelay.connect(slBleed); slBleed.connect(slGain);
      surrLeft.setNodeSource(slGain);
      const surrRight = createSpeaker(ROOM_W / 2 - 1, ROOM_H * 0.7, 5, 8);
      const srGain = ctx.createGain(); srGain.gain.value = 0.7;
      audioSplitter.connect(srGain, 5);
      const srDelay = ctx.createDelay(); srDelay.delayTime.value = 0.045;
      const srBleed = ctx.createGain(); srBleed.gain.value = 0.15;
      audioSplitter.connect(srDelay, 1); srDelay.connect(srBleed); srBleed.connect(srGain);
      surrRight.setNodeSource(srGain);

      // Places the listener and speakers. three.js moves them with short
      // ramps that finish within a frame on the live page; an offline
      // render starts at time 0, so set where they end up directly.
      scene.updateMatrixWorld(true);
      const e = audioListener.matrixWorld.elements;
      const settle = (param, value) => { param.cancelScheduledValues(0); param.value = value; };
      const L = ctx.listener;
      settle(L.positionX, e[12]); settle(L.positionY, e[13]); settle(L.positionZ, e[14]);
      settle(L.forwardX, -e[8]); settle(L.forwardY, -e[9]); settle(L.forwardZ, -e[10]);
      settle(L.upX, e[4]); settle(L.upY, e[5]); settle(L.upZ, e[6]);
      for (const s of [frontLeft, frontRight, center, sub, surrLeft, surrRight]) {
        settle(s.panner.positionX, s.position.x); settle(s.panner.positionY, s.position.y); settle(s.panner.positionZ, s.position.z);
      }
      source.start(0);
      return ctx.startRendering();
    }

    function ported(seatName) {
      const ctx = new OfflineAudioContext(2, length, RATE);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      E.build(ctx, source, ctx.destination, { seat: seatName, output: 'cinema' }, buffer.numberOfChannels);
      source.start(0);
      return ctx.startRendering();
    }

    function db(x) { return x > 0 ? (20 * Math.log10(x)).toFixed(1) : '-inf'; }
    const out = [];
    for (const name of Object.keys(E.SEATS)) {
      const a = await original(E.SEATS[name]);
      const b = await ported(name);
      let diff = 0, level = 0;
      for (let ch = 0; ch < 2; ch++) {
        const x = a.getChannelData(ch), y = b.getChannelData(ch);
        for (let i = 0; i < x.length; i++) { diff += (x[i] - y[i]) ** 2; level += x[i] ** 2; }
      }
      out.push({ seat: name, channels: buffer.numberOfChannels, level: db(Math.sqrt(level / (2 * a.length))) + ' dB',
        difference: db(Math.sqrt(diff / level)) + ' dB' });
    }
    return out;
  });
  if (!results) {
    console.error('This is a mono file. Cinema Sound plays mono on both front speakers and the 3D Cinema on the left one only, so use a stereo or 5.1 file.');
    process.exit(2);
  }
  console.table(results);
  await browser.close();
  const worst = Math.max(...results.map((r) => parseFloat(r.difference)));
  if (!(worst < -60)) { console.error('The engines differ.'); process.exit(1); }
}

main().catch((err) => { console.error(err); process.exit(1); });
