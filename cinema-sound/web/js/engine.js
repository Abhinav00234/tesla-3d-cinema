/* ================================================================
   Cinema Sound - engine.js
   Plays a song through the 3D cinema player's sound engine.

   This is the graph from js/audioManager.js, with the same speakers,
   positions, levels, seats, reverb and compressor, built with plain
   Web Audio nodes instead of three.js objects:
     - front left and right at the edges of the screen
     - centre behind the screen (only used by 5.1 files)
     - subwoofer under the screen: the LFE channel plus the bass of the
       left and right channels below 120 Hz
     - surround left and right high on the side walls: the 5.1 surround
       channels plus a quiet copy of left and right, 45 ms late
     - the theatre reverb on left and right
   You hear it from the seat you pick, as the 3D cinema camera does.
   tools/compare.js renders a song through this and through the
   three.js original and checks they come out the same.

   Two ways to hear it:
     - 'cinema': exactly as the 3D cinema (HRTF, made for headphones)
     - 'car':    the same mix, but the surround speakers are encoded the
                 way car and home surround systems read them, so the
                 car's own sound system sends them to its rear speakers.

   The same graph is used for the live preview (AudioContext) and for
   converting (OfflineAudioContext), so what you hear is what you get.
   Plain script, no modules: the Android app loads it as a classic script.
   ================================================================ */
(function () {
  'use strict';

  // The 3D cinema's room (js/config.js)
  const ROOM_W = 36, ROOM_H = 23;
  const SCR_W = 30, SCR_Z = -18, SCR_Y = 10.8;
  const BASE_PITCH = 0.15;

  // The 3D cinema's seats (js/ui.js): camera position and where it looks
  const SEATS = {
    center: { label: 'Middle',    position: [0, 2.43, 4.66],     yaw: 0,     pitch: 0 },
    front:  { label: 'Front row', position: [0, 0.99, -1.82],    yaw: 0,     pitch: 0.31 },
    back:   { label: 'Back row',  position: [0, 4.11, 12.22],    yaw: 0,     pitch: 0.03 },
    side:   { label: 'Left side', position: [-11.5, 2.43, 4.66], yaw: -0.39, pitch: 0.10 },
  };

  // The 3D cinema's speakers (js/audioManager.js)
  const SPEAKERS = {
    fl:  { position: [-SCR_W / 2 - 2, SCR_Y, SCR_Z],     ref: 12 },
    fr:  { position: [SCR_W / 2 + 2, SCR_Y, SCR_Z],      ref: 12 },
    c:   { position: [0, SCR_Y, SCR_Z],                 ref: 12 },
    lfe: { position: [0, 0.5, SCR_Z + 2],                ref: 12 },
    sl:  { position: [-ROOM_W / 2 + 1, ROOM_H * 0.7, 5], ref: 8 },
    sr:  { position: [ROOM_W / 2 - 1, ROOM_H * 0.7, 5],  ref: 8 },
  };

  // Each slider in the middle (0.5) gives the 3D cinema's own level
  const DEFAULTS = {
    seat: 'center',
    output: 'cinema',  // or 'car'
    bass: 0.5,
    surround: 0.5,
    echo: 0.5,
  };

  const REVERB_SECONDS = 3.5;
  const REVERB_DECAY = 4.0;

  // Small seeded random, so every conversion of a song comes out the same
  function random(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // The theatre reverb's impulse response, made the way the 3D cinema
  // makes it (decaying noise), but from a fixed seed
  function impulseResponse(ctx) {
    const length = Math.floor(ctx.sampleRate * REVERB_SECONDS);
    const ir = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      const rnd = random(1234 + ch * 777);
      for (let i = 0; i < length; i++) {
        data[i] = (rnd() * 2 - 1) * Math.pow(1 - i / length, REVERB_DECAY);
      }
    }
    return ir;
  }

  function gain(ctx, value) {
    const g = ctx.createGain();
    g.gain.value = value;
    return g;
  }

  function setParam(param, value) {
    param.value = value;
  }

  // Where the seat's camera looks, as three.js turns it (Euler XYZ)
  function seatFrame(seat) {
    const p = BASE_PITCH + seat.pitch, y = seat.yaw;
    const forward = [-Math.sin(y), Math.cos(y) * Math.sin(p), -Math.cos(y) * Math.cos(p)];
    const up = [0, Math.cos(p), Math.sin(p)];
    const right = [
      forward[1] * up[2] - forward[2] * up[1],
      forward[2] * up[0] - forward[0] * up[2],
      forward[0] * up[1] - forward[1] * up[0],
    ];
    return { position: seat.position, forward, up, right };
  }

  function placeListener(ctx, frame) {
    const l = ctx.listener;
    const [px, py, pz] = frame.position, [fx, fy, fz] = frame.forward, [ux, uy, uz] = frame.up;
    if (l.positionX) {
      setParam(l.positionX, px); setParam(l.positionY, py); setParam(l.positionZ, pz);
      setParam(l.forwardX, fx); setParam(l.forwardY, fy); setParam(l.forwardZ, fz);
      setParam(l.upX, ux); setParam(l.upY, uy); setParam(l.upZ, uz);
    } else {
      l.setPosition(px, py, pz);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  // Builds the cinema between `input` and `output`. `channels` is the
  // song's channel count: 5.1 files use all six speakers as in the cinema.
  function build(ctx, input, output, options, channels) {
    const o = Object.assign({}, DEFAULTS, options);
    const seat = SEATS[o.seat] || SEATS.center;
    const frame = seatFrame(seat);
    const bass = o.bass * 2, surround = o.surround * 2, echo = o.echo * 2;

    // Mono songs go to both front speakers, the rest is taken channel by channel
    let feed = input;
    if ((channels || 2) < 2) {
      feed = ctx.createGain();
      feed.channelCount = 2;
      feed.channelCountMode = 'explicit';
      feed.channelInterpretation = 'speakers';
      input.connect(feed);
    }
    const split = ctx.createChannelSplitter(6);
    feed.connect(split);

    // Master compressor, as in the cinema
    const master = ctx.createGain();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -6;
    compressor.knee.value = 15;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.1;
    master.connect(compressor);
    compressor.connect(output);

    // The car mode's two outputs: what goes to the left and right channel
    let carLeft = null, carRight = null;
    if (o.output === 'car') {
      const merge = ctx.createChannelMerger(2);
      carLeft = ctx.createGain(); carRight = ctx.createGain();
      carLeft.connect(merge, 0, 0); carRight.connect(merge, 0, 1);
      merge.connect(master);
    } else {
      placeListener(ctx, frame);
    }

    function speaker(name, source) {
      const s = SPEAKERS[name];
      if (o.output !== 'car') {
        // As three.js PositionalAudio: HRTF, exponential distance model
        const pan = ctx.createPanner();
        pan.panningModel = 'HRTF';
        pan.distanceModel = 'exponential';
        pan.refDistance = s.ref;
        pan.rolloffFactor = 1;
        if (pan.positionX) {
          setParam(pan.positionX, s.position[0]); setParam(pan.positionY, s.position[1]); setParam(pan.positionZ, s.position[2]);
        } else {
          pan.setPosition(s.position[0], s.position[1], s.position[2]);
        }
        source.connect(pan);
        pan.connect(master);
        return;
      }

      // Car: the same distance loudness, and a direction a stereo car
      // system understands
      const v = s.position.map((x, i) => x - frame.position[i]);
      const d = Math.hypot(v[0], v[1], v[2]);
      const loud = gain(ctx, Math.pow(Math.max(d, s.ref) / s.ref, -1));
      source.connect(loud);
      if (name === 'sl' || name === 'sr') {
        // Matrix surround (as Dolby Pro Logic II encodes it): surround
        // sound goes into both channels with opposite signs. Car and home
        // surround processing finds that and plays it from the rear.
        const near = gain(ctx, name === 'sl' ? -0.8718 : 0.8718);
        const far = gain(ctx, name === 'sl' ? 0.4899 : -0.4899);
        loud.connect(near); loud.connect(far);
        near.connect(name === 'sl' ? carLeft : carRight);
        far.connect(name === 'sl' ? carRight : carLeft);
      } else {
        const across = v[0] * frame.right[0] + v[1] * frame.right[1] + v[2] * frame.right[2];
        const ahead = v[0] * frame.forward[0] + v[1] * frame.forward[1] + v[2] * frame.forward[2];
        const angle = Math.atan2(across, ahead);
        // Tangent law for speakers 30 degrees either side (as in a car or
        // a stereo setup): wider than that goes all the way to one side
        const pan = Math.abs(angle) >= Math.PI / 2 ? Math.sign(angle)
          : Math.max(-1, Math.min(1, Math.tan(angle) / Math.tan(Math.PI / 6)));
        // Equal-power, as a StereoPannerNode does
        const x = (pan + 1) / 2;
        const toLeft = gain(ctx, Math.cos(x * Math.PI / 2));
        const toRight = gain(ctx, Math.sin(x * Math.PI / 2));
        loud.connect(toLeft); loud.connect(toRight);
        toLeft.connect(carLeft); toRight.connect(carRight);
      }
    }

    // Reverb on left and right only, so it doesn't muddy the centre
    const convolver = ctx.createConvolver();
    convolver.buffer = impulseResponse(ctx);
    const reverbGain = gain(ctx, 0.08 * echo);
    const reverbMix = ctx.createGain();
    split.connect(reverbMix, 0);
    split.connect(reverbMix, 1);
    reverbMix.connect(convolver);
    convolver.connect(reverbGain);
    if (o.output === 'car') {
      const rs = ctx.createChannelSplitter(2);
      reverbGain.connect(rs);
      rs.connect(carLeft, 0); rs.connect(carRight, 1);
    } else {
      reverbGain.connect(master);
    }

    // Front left and right
    const flGain = gain(ctx, 0.8);
    split.connect(flGain, 0);
    speaker('fl', flGain);
    const frGain = gain(ctx, 0.8);
    split.connect(frGain, 1);
    speaker('fr', frGain);

    // Centre (dialogue in 5.1 files)
    const centerGain = gain(ctx, 1.2);
    split.connect(centerGain, 2);
    speaker('c', centerGain);

    // Subwoofer: LFE plus bass management of left and right
    const subFilter = ctx.createBiquadFilter();
    subFilter.type = 'lowpass';
    subFilter.frequency.value = 120;
    const subGain = gain(ctx, 1.0 * bass);
    split.connect(subGain, 3);
    const bassMix = gain(ctx, 0.5);
    split.connect(bassMix, 0);
    split.connect(bassMix, 1);
    bassMix.connect(subFilter);
    subFilter.connect(subGain);
    speaker('lfe', subGain);

    // Surrounds: the 5.1 surround channel plus a delayed bleed of the front
    for (const [name, ch, front] of [['sl', 4, 0], ['sr', 5, 1]]) {
      const g = gain(ctx, 0.7);
      const own = gain(ctx, surround);
      split.connect(own, ch);
      own.connect(g);
      const delay = ctx.createDelay();
      delay.delayTime.value = 0.045;
      const bleed = gain(ctx, 0.15 * surround);
      split.connect(delay, front);
      delay.connect(bleed);
      bleed.connect(g);
      speaker(name, g);
    }

    return { tail: REVERB_SECONDS };
  }

  function decode(arrayBuffer, sampleRate) {
    // Decode at the rate we convert at, so the result is not resampled twice
    const ctx = new OfflineAudioContext(2, 1, sampleRate);
    return new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  // Renders the whole song through the cinema. Resolves to a stereo AudioBuffer.
  function render(buffer, options, onProgress) {
    const length = Math.ceil(buffer.length + REVERB_SECONDS * buffer.sampleRate);
    const ctx = new OfflineAudioContext(2, length, buffer.sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    build(ctx, source, ctx.destination, options, buffer.numberOfChannels);
    source.start(0);

    let timer = null;
    if (onProgress) {
      timer = setInterval(() => onProgress(Math.min(1, ctx.currentTime / (length / buffer.sampleRate))), 200);
    }
    return ctx.startRendering().then((out) => {
      clearInterval(timer);
      if (onProgress) onProgress(1);
      normalize(out, 0.89); // peak at -1 dBFS
      return out;
    }, (err) => { clearInterval(timer); throw err; });
  }

  function normalize(buffer, peak) {
    let max = 0;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const d = buffer.getChannelData(ch);
      for (let i = 0; i < d.length; i++) {
        const v = Math.abs(d[i]);
        if (v > max) max = v;
      }
    }
    if (max === 0) return;
    const k = peak / max;
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const d = buffer.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] *= k;
    }
  }

  // 16-bit PCM WAV
  function toWav(buffer) {
    const channels = buffer.numberOfChannels;
    const frames = buffer.length;
    const bytes = new ArrayBuffer(44 + frames * channels * 2);
    const view = new DataView(bytes);
    const text = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + frames * channels * 2, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * channels * 2, true);
    view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, frames * channels * 2, true);

    const data = [];
    for (let ch = 0; ch < channels; ch++) data.push(buffer.getChannelData(ch));
    let at = 44;
    for (let i = 0; i < frames; i++) {
      for (let ch = 0; ch < channels; ch++) {
        const v = Math.max(-1, Math.min(1, data[ch][i]));
        view.setInt16(at, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
        at += 2;
      }
    }
    return new Uint8Array(bytes);
  }

  window.CinemaEngine = { SEATS, DEFAULTS, build, decode, render, toWav, impulseResponse };
})();
