/* ================================================================
   Cinema Sound - engine.js
   Makes a song sound like a movie soundtrack in a cinema hall.

   The idea comes from the 3D cinema player's sound engine
   (js/audioManager.js): split the sound into 5.1 channels, place
   each one on a speaker in the room, add the theatre reverb and send
   the bass to a subwoofer. A song is only stereo, so it is first
   upmixed to 5.1 the way cinema processors do it:
     - centre    = what both sides share (the voice), band-limited
     - surround  = what differs between the sides (the ambience), delayed
     - LFE       = the shared low end below 110 Hz
   The speakers are placed in the same room as the 3D cinema
   (36 wide, 40 deep, screen 30 wide) and heard from the chosen seat.

   The same graph is used for the live preview (AudioContext) and for
   converting (OfflineAudioContext), so what you hear is what you get.
   Plain script, no modules: the Android app loads it from file://.
   ================================================================ */
(function () {
  'use strict';

  // The 3D cinema's room (js/config.js)
  const ROOM_W = 36, ROOM_D = 40, SCR_W = 30, SCR_Z = -18, SCR_Y = 10.8;
  // Room units to metres, for the time sound takes to reach the seat
  const METRES_PER_UNIT = 0.6;
  const SPEED_OF_SOUND = 343;

  const HALLS = {
    small:    { label: 'Screening room', decay: 1.2, wet: 0.13, preDelay: 0.012, shape: 3.2 },
    standard: { label: 'Cinema',         decay: 2.2, wet: 0.18, preDelay: 0.022, shape: 3.6 },
    imax:     { label: 'IMAX',           decay: 3.4, wet: 0.24, preDelay: 0.034, shape: 4.0 },
  };

  // Where the listener sits, and how the seat changes the mix
  const SEATS = {
    front:  { label: 'Front row', z: -7, eye: 3.2, wet: 0.7,  surround: 0.85 },
    middle: { label: 'Middle',    z: 3,  eye: 5.5, wet: 1.0,  surround: 1.0 },
    back:   { label: 'Back row',  z: 13, eye: 8.0, wet: 1.35, surround: 1.15 },
  };

  // Speakers: screen channels behind the screen, surround arrays on the
  // side walls and the back wall, the sub under the screen.
  const SPEAKERS = {
    fl:  [-SCR_W / 2 + 1, SCR_Y, SCR_Z],
    c:   [0, SCR_Y, SCR_Z],
    fr:  [SCR_W / 2 - 1, SCR_Y, SCR_Z],
    lfe: [0, 0.5, SCR_Z + 2],
    sl:  [-ROOM_W / 2 + 1, 13, 2],
    sr:  [ROOM_W / 2 - 1, 13, 2],
    bl:  [-ROOM_W / 4, 14, ROOM_D / 2 - 2],
    br:  [ROOM_W / 4, 14, ROOM_D / 2 - 2],
  };

  const DEFAULTS = {
    hall: 'standard',
    seat: 'middle',
    output: 'headphones',  // or 'speakers'
    bass: 0.6,             // 0..1, subwoofer level
    surround: 0.6,         // 0..1, how much comes from around you
    echo: 0.5,             // 0..1, how much of the hall you hear
  };

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

  // Theatre reverb: a few early reflections off the walls, then a
  // decaying diffuse tail. Left and right differ so the hall feels wide.
  function impulseResponse(ctx, hall) {
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * hall.decay);
    const ir = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      const rnd = random(1234 + ch * 777);
      for (let i = 0; i < length; i++) {
        data[i] = (rnd() * 2 - 1) * Math.pow(1 - i / length, hall.shape);
      }
      // Wall reflections in the first 80 ms
      for (let k = 0; k < 8; k++) {
        const at = Math.floor(rate * (0.008 + rnd() * 0.072));
        data[at] += (rnd() > 0.5 ? 1 : -1) * (0.9 - k * 0.08);
      }
    }
    return ir;
  }

  function gain(ctx, value) {
    const g = ctx.createGain();
    g.gain.value = value;
    return g;
  }

  function filter(ctx, type, frequency, q) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    if (q !== undefined) f.Q.value = q;
    return f;
  }

  // Builds the cinema between `input` (any channel count) and `output`.
  // Returns { tail } - seconds of reverb left after the song ends.
  function build(ctx, input, output, options) {
    const o = Object.assign({}, DEFAULTS, options);
    const hall = HALLS[o.hall] || HALLS.standard;
    const seat = SEATS[o.seat] || SEATS.middle;
    const listener = [0, seat.eye, seat.z];

    // Mono songs go to both sides, 5.1 files are folded to stereo first
    const stereo = ctx.createGain();
    stereo.channelCount = 2;
    stereo.channelCountMode = 'explicit';
    stereo.channelInterpretation = 'speakers';
    input.connect(stereo);
    const split = ctx.createChannelSplitter(2);
    stereo.connect(split);

    const left = gain(ctx, 1), right = gain(ctx, 1);
    split.connect(left, 0);
    split.connect(right, 1);

    // What both sides share
    const mid = gain(ctx, 0.5);
    left.connect(mid); right.connect(mid);
    // What differs between them
    const side = gain(ctx, 0.5);
    const rightInverted = gain(ctx, -1);
    left.connect(side); right.connect(rightInverted); rightInverted.connect(side);

    const master = ctx.createGain();
    const xCurve = filter(ctx, 'highshelf', 9000); // cinemas roll off the top a little
    xCurve.gain.value = -2;
    const compressor = ctx.createDynamicsCompressor(); // as in the cinema player
    compressor.threshold.value = -10;
    compressor.knee.value = 15;
    compressor.ratio.value = 3;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.15;
    master.connect(xCurve);
    xCurve.connect(compressor);
    compressor.connect(output);

    // Puts a channel on its speaker as heard from the seat: direction,
    // loudness from the distance, and the delay of sound travelling.
    const distances = {};
    for (const name in SPEAKERS) {
      const p = SPEAKERS[name];
      distances[name] = Math.hypot(p[0] - listener[0], p[1] - listener[1], p[2] - listener[2]);
    }
    const nearest = Math.min.apply(null, Object.values(distances));

    function speaker(name, source, level) {
      const p = SPEAKERS[name];
      const rel = [p[0] - listener[0], p[1] - listener[1], p[2] - listener[2]];
      const d = distances[name];

      const loud = gain(ctx, level * Math.pow(nearest / d, 0.6));
      const delay = ctx.createDelay(1);
      delay.delayTime.value = (d - nearest) * METRES_PER_UNIT / SPEED_OF_SOUND;
      source.connect(loud);
      loud.connect(delay);

      if (o.output === 'headphones') {
        const pan = ctx.createPanner();
        pan.panningModel = 'HRTF';
        pan.distanceModel = 'inverse';
        pan.refDistance = 1;
        pan.rolloffFactor = 0; // loudness is set above
        if (pan.positionX) {
          pan.positionX.value = rel[0]; pan.positionY.value = rel[1]; pan.positionZ.value = rel[2];
        } else {
          pan.setPosition(rel[0], rel[1], rel[2]);
        }
        delay.connect(pan);
        pan.connect(master);
      } else {
        // On speakers there is nothing behind you, so surround channels
        // go wide to the sides instead.
        const pan = ctx.createStereoPanner();
        const across = rel[0] / Math.hypot(rel[0], rel[2]);
        pan.pan.value = Math.max(-1, Math.min(1, across * (rel[2] > 0 ? 1 : 0.9)));
        delay.connect(pan);
        pan.connect(master);
      }
    }

    // Screen channels
    speaker('fl', left, 0.75);
    speaker('fr', right, 0.75);
    const voice = filter(ctx, 'highpass', 140, 0.7);
    const voiceTop = filter(ctx, 'lowpass', 8000, 0.7);
    mid.connect(voice); voice.connect(voiceTop);
    speaker('c', voiceTop, 0.65);

    // Subwoofer: the shared low end, filtered steeply
    const sub1 = filter(ctx, 'lowpass', 110, 0.7);
    const sub2 = filter(ctx, 'lowpass', 110, 0.7);
    mid.connect(sub1); sub1.connect(sub2);
    speaker('lfe', sub2, o.bass * 1.8);

    // Surrounds: the ambience, band-limited and a little late, as in a
    // cinema processor. Each wall gets its own delay so they don't fuse.
    const amb = filter(ctx, 'lowpass', 7000, 0.7);
    const ambLow = filter(ctx, 'highpass', 120, 0.7);
    side.connect(amb); amb.connect(ambLow);
    const surroundLevel = o.surround * seat.surround * 1.3;
    function late(seconds, sign) {
      const d = ctx.createDelay(1);
      d.delayTime.value = seconds;
      const g = gain(ctx, sign);
      ambLow.connect(d); d.connect(g);
      return g;
    }
    speaker('sl', late(0.018, 1), surroundLevel);
    speaker('sr', late(0.021, -1), surroundLevel);
    speaker('bl', late(0.027, 1), surroundLevel * 0.8);
    speaker('br', late(0.031, -1), surroundLevel * 0.8);

    // The hall
    const preDelay = ctx.createDelay(1);
    preDelay.delayTime.value = hall.preDelay;
    const convolver = ctx.createConvolver();
    convolver.normalize = true;
    convolver.buffer = impulseResponse(ctx, hall);
    const wet = gain(ctx, hall.wet * seat.wet * (o.echo * 2));
    stereo.connect(preDelay);
    preDelay.connect(convolver);
    convolver.connect(wet);
    wet.connect(master);

    return { tail: hall.decay };
  }

  function decode(arrayBuffer, sampleRate) {
    // Decode at the rate we convert at, so the result is not resampled twice
    const ctx = new OfflineAudioContext(2, 1, sampleRate);
    return new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  // Renders the whole song through the cinema. Resolves to an AudioBuffer.
  function render(buffer, options, onProgress) {
    const tail = (HALLS[(options || {}).hall] || HALLS.standard).decay;
    const length = Math.ceil(buffer.length + tail * buffer.sampleRate);
    const ctx = new OfflineAudioContext(2, length, buffer.sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    build(ctx, source, ctx.destination, options);
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

  window.CinemaEngine = { HALLS, SEATS, DEFAULTS, build, decode, render, toWav };
})();
