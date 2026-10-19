/* ================================================================
   Cinema Sound - engine.js
   Plays a song through a cinema's sound system.

   Two cinemas (`style`):
     - 'cinema3d': the graph from js/audioManager.js, with the same
       speakers, positions, levels, seats, reverb and compressor, built
       with plain Web Audio nodes instead of three.js objects:
         - front left and right at the edges of the screen
         - centre behind the screen (only used by 5.1 files)
         - subwoofer under the screen: the LFE channel plus the bass of
           the left and right channels below 120 Hz
         - surround left and right high on the side walls: the 5.1
           surround channels plus a quiet copy of left and right, 45 ms late
         - the theatre reverb on left and right
       tools/compare.js renders a song through this and through the
       three.js original and checks they come out the same.
     - 'theatre': the same room set up like a real movie theatre:
       surround speakers all along the side walls and on the back wall,
       each a little later than the one before, a stronger and steeper
       subwoofer, a short natural reverb with wall reflections, and the
       gentle treble roll-off cinemas are tuned to (the X-curve).
   You hear it from the seat you pick, as the 3D cinema camera does.

   Three ways to hear it (`output`):
     - 'cinema': 3D audio (HRTF), as the 3D cinema does. For headphones.
     - 'car':    stereo for speakers. The surround speakers are encoded
                 the way car and home surround systems read them (as in
                 Dolby Pro Logic II), so they come from the rear.
     - 'surround51': a 5.1 file (L, R, C, LFE, Ls, Rs) for a home
                 theatre, with the levels you would hear from the seat.

   The same graph is used for the live preview (AudioContext) and for
   converting (OfflineAudioContext), so what you hear is what you get.
   Plain script, no modules: the Android app loads it as a classic script.
   ================================================================ */
(function () {
  'use strict';

  // The 3D cinema's room (js/config.js)
  const ROOM_W = 36, ROOM_H = 23, ROOM_D = 40;
  const SCR_W = 30, SCR_Z = -18, SCR_Y = 10.8;
  const BASE_PITCH = 0.15;

  // The 3D cinema's seats (js/ui.js): camera position and where it looks
  const SEATS = {
    center: { label: 'Middle',    position: [0, 2.43, 4.66],     yaw: 0,     pitch: 0 },
    front:  { label: 'Front row', position: [0, 0.99, -1.82],    yaw: 0,     pitch: 0.31 },
    back:   { label: 'Back row',  position: [0, 4.11, 12.22],    yaw: 0,     pitch: 0.03 },
    side:   { label: 'Left side', position: [-11.5, 2.43, 4.66], yaw: -0.39, pitch: 0.10 },
  };

  const STYLES = {
    // js/audioManager.js
    cinema3d: {
      reverb: { seconds: 3.5, decay: 4.0, reflections: 0, gain: 0.08 },
      subLevel: 1.0, subSteep: false, xCurve: false,
      // [x, y, z, ref distance, side (-1 left, 1 right), delay, level]
      surrounds: [
        [-ROOM_W / 2 + 1, ROOM_H * 0.7, 5, 8, -1, 0.045, 1],
        [ROOM_W / 2 - 1, ROOM_H * 0.7, 5, 8, 1, 0.045, 1],
      ],
      bleed: 0.15,
    },
    // A real movie theatre in the same room
    theatre: {
      reverb: { seconds: 1.2, decay: 3.0, reflections: 10, gain: 0.12 },
      subLevel: 1.4, subSteep: true, xCurve: true,
      // Three speakers on each side wall and two on the back wall; each
      // side's four share the level of one, and get later towards the back
      surrounds: [
        [-ROOM_W / 2 + 1, 13, -6, 8, -1, 0.030, 0.5],
        [-ROOM_W / 2 + 1, 13, 2, 8, -1, 0.037, 0.5],
        [-ROOM_W / 2 + 1, 13, 10, 8, -1, 0.044, 0.5],
        [-ROOM_W / 4, 14, ROOM_D / 2 - 1, 8, -1, 0.052, 0.5],
        [ROOM_W / 2 - 1, 13, -6, 8, 1, 0.032, 0.5],
        [ROOM_W / 2 - 1, 13, 2, 8, 1, 0.039, 0.5],
        [ROOM_W / 2 - 1, 13, 10, 8, 1, 0.047, 0.5],
        [ROOM_W / 4, 14, ROOM_D / 2 - 1, 8, 1, 0.056, 0.5],
      ],
      bleed: 0.25,
    },
  };

  // Each slider in the middle (0.5) gives the cinema's own level
  const DEFAULTS = {
    style: 'cinema3d',
    seat: 'center',
    output: 'cinema',  // or 'car', 'surround51'
    bass: 0.5,
    surround: 0.5,
    echo: 0.5,
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

  // The reverb's impulse response: decaying noise (made the way the 3D
  // cinema makes it, but from a fixed seed), plus early wall reflections
  function impulseResponse(ctx, reverb) {
    reverb = reverb || STYLES.cinema3d.reverb;
    const length = Math.floor(ctx.sampleRate * reverb.seconds);
    const ir = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch);
      const rnd = random(1234 + ch * 777);
      for (let i = 0; i < length; i++) {
        data[i] = (rnd() * 2 - 1) * Math.pow(1 - i / length, reverb.decay);
      }
      for (let k = 0; k < reverb.reflections; k++) {
        const at = Math.floor(ctx.sampleRate * (0.006 + rnd() * 0.06));
        data[at] += (rnd() > 0.5 ? 1 : -1) * (1 - k / reverb.reflections) * 0.8;
      }
    }
    return ir;
  }

  function gain(ctx, value) {
    const g = ctx.createGain();
    g.gain.value = value;
    return g;
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
      l.positionX.value = px; l.positionY.value = py; l.positionZ.value = pz;
      l.forwardX.value = fx; l.forwardY.value = fy; l.forwardZ.value = fz;
      l.upX.value = ux; l.upY.value = uy; l.upZ.value = uz;
    } else {
      l.setPosition(px, py, pz);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  function outputChannels(options) {
    return options && options.output === 'surround51' ? 6 : 2;
  }

  // Builds the cinema between `input` and `output`. `channels` is the
  // song's channel count: 5.1 files use their own centre, LFE and
  // surround channels, as in the cinema.
  function build(ctx, input, output, options, channels) {
    const o = Object.assign({}, DEFAULTS, options);
    const style = STYLES[o.style] || STYLES.cinema3d;
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
    let last = master;
    if (style.xCurve) {
      // Cinemas are tuned to roll the treble off gently (SMPTE X-curve)
      const x1 = ctx.createBiquadFilter();
      x1.type = 'highshelf'; x1.frequency.value = 4000; x1.gain.value = -1.5;
      const x2 = ctx.createBiquadFilter();
      x2.type = 'highshelf'; x2.frequency.value = 10000; x2.gain.value = -2;
      last.connect(x1); x1.connect(x2);
      last = x2;
    }
    function compressor() {
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = -6;
      c.knee.value = 15;
      c.ratio.value = 3;
      c.attack.value = 0.005;
      c.release.value = 0.1;
      return c;
    }
    if (o.output === 'surround51') {
      // A compressor takes at most two channels: one for each pair
      // (front, centre and LFE, surrounds), all set the same
      const apart = ctx.createChannelSplitter(6);
      const together = ctx.createChannelMerger(6);
      last.connect(apart);
      for (let pair = 0; pair < 3; pair++) {
        const two = ctx.createChannelMerger(2);
        apart.connect(two, pair * 2, 0);
        apart.connect(two, pair * 2 + 1, 1);
        const c = compressor();
        two.connect(c);
        const back = ctx.createChannelSplitter(2);
        c.connect(back);
        back.connect(together, 0, pair * 2);
        back.connect(together, 1, pair * 2 + 1);
      }
      together.connect(output);
    } else {
      const c = compressor();
      last.connect(c);
      c.connect(output);
    }

    // Speaker outputs for 'car' and 'surround51': one bus per channel
    let bus = null;
    if (o.output === 'car' || o.output === 'surround51') {
      const n = o.output === 'car' ? 2 : 6;
      const merge = ctx.createChannelMerger(n);
      bus = [];
      for (let i = 0; i < n; i++) {
        bus.push(ctx.createGain());
        bus[i].connect(merge, 0, i);
      }
      merge.connect(master);
    } else {
      placeListener(ctx, frame);
    }
    const [L, R, C, LFE, SL, SR] = [0, 1, 2, 3, 4, 5];

    function distanceGain(position, ref) {
      const d = Math.hypot(position[0] - frame.position[0], position[1] - frame.position[1], position[2] - frame.position[2]);
      return Math.pow(Math.max(d, ref) / ref, -1); // exponential model, rolloff 1
    }

    // `kind`: 'front', 'centre', 'sub' or 'surround'; `side` -1 or 1 for surrounds
    function speaker(source, position, ref, kind, side) {
      if (!bus) {
        // As three.js PositionalAudio: HRTF, exponential distance model
        const pan = ctx.createPanner();
        pan.panningModel = 'HRTF';
        pan.distanceModel = 'exponential';
        pan.refDistance = ref;
        pan.rolloffFactor = 1;
        if (pan.positionX) {
          pan.positionX.value = position[0]; pan.positionY.value = position[1]; pan.positionZ.value = position[2];
        } else {
          pan.setPosition(position[0], position[1], position[2]);
        }
        source.connect(pan);
        pan.connect(master);
        return;
      }

      const loud = gain(ctx, distanceGain(position, ref));
      source.connect(loud);
      if (o.output === 'surround51') {
        // 5.1 players turn the LFE channel up by 10 dB, so it is stored 10 dB down
        if (kind === 'sub') loud.gain.value *= 0.3162;
        const ch = kind === 'sub' ? LFE : kind === 'centre' ? C
          : kind === 'surround' ? (side < 0 ? SL : SR)
          : (position[0] < 0 ? L : R);
        loud.connect(bus[ch]);
        return;
      }

      if (kind === 'surround') {
        // Matrix surround (as Dolby Pro Logic II encodes it): surround
        // sound goes into both channels with opposite signs. Car and home
        // surround processing finds that and plays it from the rear.
        const near = gain(ctx, side < 0 ? -0.8718 : 0.8718);
        const far = gain(ctx, side < 0 ? 0.4899 : -0.4899);
        loud.connect(near); loud.connect(far);
        near.connect(bus[side < 0 ? L : R]);
        far.connect(bus[side < 0 ? R : L]);
        return;
      }
      const v = position.map((x, i) => x - frame.position[i]);
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
      toLeft.connect(bus[L]); toRight.connect(bus[R]);
    }

    // Reverb on left and right only, so it doesn't muddy the centre
    const convolver = ctx.createConvolver();
    convolver.buffer = impulseResponse(ctx, style.reverb);
    const reverbGain = gain(ctx, style.reverb.gain * echo);
    const reverbMix = ctx.createGain();
    split.connect(reverbMix, 0);
    split.connect(reverbMix, 1);
    reverbMix.connect(convolver);
    convolver.connect(reverbGain);
    if (bus) {
      const rs = ctx.createChannelSplitter(2);
      reverbGain.connect(rs);
      rs.connect(bus[L], 0); rs.connect(bus[R], 1);
      if (o.output === 'surround51') {
        // In a 5.1 room the hall comes from around you as well
        const back = gain(ctx, 0.7);
        const backSplit = ctx.createChannelSplitter(2);
        reverbGain.connect(back); back.connect(backSplit);
        backSplit.connect(bus[SL], 0); backSplit.connect(bus[SR], 1);
      }
    } else {
      reverbGain.connect(master);
    }

    // Front left and right
    const flGain = gain(ctx, 0.8);
    split.connect(flGain, 0);
    speaker(flGain, [-SCR_W / 2 - 2, SCR_Y, SCR_Z], 12, 'front');
    const frGain = gain(ctx, 0.8);
    split.connect(frGain, 1);
    speaker(frGain, [SCR_W / 2 + 2, SCR_Y, SCR_Z], 12, 'front');

    // Centre (dialogue in 5.1 files)
    const centerGain = gain(ctx, 1.2);
    split.connect(centerGain, 2);
    speaker(centerGain, [0, SCR_Y, SCR_Z], 12, 'centre');

    // Subwoofer: LFE plus bass management of left and right
    const subFilter = ctx.createBiquadFilter();
    subFilter.type = 'lowpass';
    subFilter.frequency.value = 120;
    const subGain = gain(ctx, style.subLevel * bass);
    split.connect(subGain, 3);
    const bassMix = gain(ctx, 0.5);
    split.connect(bassMix, 0);
    split.connect(bassMix, 1);
    bassMix.connect(subFilter);
    if (style.subSteep) {
      // A second filter, so the sub plays only the deep bass, as in a theatre
      const subFilter2 = ctx.createBiquadFilter();
      subFilter2.type = 'lowpass';
      subFilter2.frequency.value = 120;
      subFilter.connect(subFilter2);
      subFilter2.connect(subGain);
    } else {
      subFilter.connect(subGain);
    }
    speaker(subGain, [0, 0.5, SCR_Z + 2], 12, 'sub');

    // Surrounds: the 5.1 surround channel plus a delayed bleed of the front
    for (const [x, y, z, ref, side, delayTime, level] of style.surrounds) {
      const g = gain(ctx, 0.7 * level);
      const own = gain(ctx, surround);
      split.connect(own, side < 0 ? 4 : 5);
      own.connect(g);
      const delay = ctx.createDelay();
      delay.delayTime.value = delayTime;
      const bleed = gain(ctx, style.bleed * surround);
      split.connect(delay, side < 0 ? 0 : 1);
      delay.connect(bleed);
      bleed.connect(g);
      speaker(g, [x, y, z], ref, 'surround', side);
    }

    return { tail: style.reverb.seconds };
  }

  function decode(arrayBuffer, sampleRate) {
    // Decode at the rate we convert at, so the result is not resampled twice
    const ctx = new OfflineAudioContext(2, 1, sampleRate);
    return new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  // Converting is done in pieces, so a long song (or a 5.1 file) never
  // has to be held in memory whole. Each piece starts rendering a few
  // seconds early, so the reverb and compressor are already in the same
  // state as in one long render, and only its own part is kept.
  const PIECE_SECONDS = 30;
  const WARM_UP_SECONDS = 4; // longer than the longest reverb
  const KEEP_BYTES = 160 * 1024 * 1024; // keep pieces from pass 1 up to this

  // Renders the song through the cinema and hands the WAV file over in
  // pieces: `write(bytes)` is called with the header, then each piece in
  // order, and may return a promise. The level is evened out to a peak of
  // -1 dBFS, so the song is rendered twice unless it fits in KEEP_BYTES.
  async function render(buffer, options, write, onProgress) {
    const channels = outputChannels(options);
    const rate = buffer.sampleRate;
    const style = STYLES[(options || {}).style] || STYLES.cinema3d;
    const total = Math.ceil(buffer.length + style.reverb.seconds * rate);
    const pieceFrames = PIECE_SECONDS * rate, warmFrames = WARM_UP_SECONDS * rate;
    const pieces = Math.ceil(total / pieceFrames);
    const keep = total * channels * 4 <= KEEP_BYTES;
    const progress = (p) => { if (onProgress) onProgress(Math.min(1, p)); };

    async function piece(i) {
      const start = i * pieceFrames;
      const frames = Math.min(pieceFrames, total - start);
      const warm = Math.min(warmFrames, start);
      const ctx = new OfflineAudioContext(channels, warm + frames, rate);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      build(ctx, source, ctx.destination, options, buffer.numberOfChannels);
      const from = start - warm;
      if (from < buffer.length) source.start(0, from / rate);
      const out = await ctx.startRendering();
      const data = [];
      for (let ch = 0; ch < channels; ch++) data.push(out.getChannelData(ch).subarray(warm));
      return data;
    }

    // Pass 1: find the loudest sample
    const kept = [];
    let peak = 0;
    for (let i = 0; i < pieces; i++) {
      const data = await piece(i);
      for (const d of data) for (let k = 0; k < d.length; k++) { const v = Math.abs(d[k]); if (v > peak) peak = v; }
      if (keep) kept.push(data);
      progress((i + 1) / pieces * (keep ? 0.9 : 0.5));
    }
    const scale = peak > 0 ? 0.89 / peak : 1;

    // Pass 2: write the file
    await write(wavHeader(channels, rate, total));
    for (let i = 0; i < pieces; i++) {
      const data = keep ? kept[i] : await piece(i);
      if (keep) kept[i] = null;
      await write(toPcm16(data, scale));
      progress(keep ? 0.9 + (i + 1) / pieces * 0.1 : 0.5 + (i + 1) / pieces * 0.5);
    }
    return { channels, frames: total, seconds: total / rate };
  }

  // WAV header. 5.1 files use WAVE_FORMAT_EXTENSIBLE with the standard
  // 5.1 speaker mask, so players know which channel is which.
  function wavHeader(channels, rate, frames) {
    const extensible = channels > 2;
    const fmtSize = extensible ? 40 : 16;
    const dataSize = frames * channels * 2;
    const bytes = new ArrayBuffer(20 + fmtSize + 8);
    const view = new DataView(bytes);
    const text = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, 12 + fmtSize + 8 + dataSize, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, fmtSize, true);
    view.setUint16(20, extensible ? 0xFFFE : 1, true);
    view.setUint16(22, channels, true); view.setUint32(24, rate, true);
    view.setUint32(28, rate * channels * 2, true);
    view.setUint16(32, channels * 2, true); view.setUint16(34, 16, true);
    let at = 36;
    if (extensible) {
      view.setUint16(36, 22, true);            // extra bytes
      view.setUint16(38, 16, true);            // valid bits
      view.setUint32(40, 0x3F, true);          // FL FR FC LFE BL BR
      // KSDATAFORMAT_SUBTYPE_PCM
      const guid = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71];
      guid.forEach((b, i) => view.setUint8(44 + i, b));
      at = 60;
    }
    text(at, 'data'); view.setUint32(at + 4, dataSize, true);
    return new Uint8Array(bytes);
  }

  // Interleaved 16-bit samples
  function toPcm16(data, scale) {
    const channels = data.length, frames = data[0].length;
    const out = new Int16Array(frames * channels);
    let at = 0;
    for (let i = 0; i < frames; i++) {
      for (let ch = 0; ch < channels; ch++) {
        const v = Math.max(-1, Math.min(1, data[ch][i] * scale));
        out[at++] = v < 0 ? v * 0x8000 : v * 0x7FFF;
      }
    }
    return new Uint8Array(out.buffer); // WAV is little-endian, as are phones
  }

  window.CinemaEngine = { SEATS, STYLES, DEFAULTS, build, decode, render, impulseResponse, outputChannels };
})();
