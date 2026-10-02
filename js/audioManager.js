import * as THREE from 'three';
import { ROOM_W, ROOM_H, SCR_W, SCR_Z, SCR_Y } from './config.js';

let initialized = false;
let audioListener = null;
let currentExternalAudio = null;
let currentSourceNode = null;
let videoSourceNode = null;
let videoGainNode = null;
let audioSplitter = null;
let audioCtx = null;
let mainVideo = null;
let currentExternalStartTime = 0;
let masterVolume = 1;

// While a soundtrack is being fetched the picture is held so both start
// together. `resume` says whether to start playing once the sound is ready.
export const hold = { active: false, resume: false };
let holdTimer = null;
let driftTimer = null;
let badDriftChecks = 0;
let lastResync = 0;
let resyncCount = 0;

// Generate a synthetic impulse response for the theatre reverb
function createImpulseResponse(duration, decay, ctx) {
  const length = ctx.sampleRate * duration;
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  const left = impulse.getChannelData(0);
  const right = impulse.getChannelData(1);
  for (let i = 0; i < length; i++) {
    left[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    right[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
  }
  return impulse;
}

export function initAudio(camera, scene, video) {
  if (initialized) return;
  
  // 1. Create listener (the user's ears) and attach to camera
  audioListener = new THREE.AudioListener();
  camera.add(audioListener);
  
  const ctx = audioListener.context;
  
  // Insert a Master Compressor to prevent clipping and "ducking" when signals sum
  const masterCompressor = ctx.createDynamicsCompressor();
  masterCompressor.threshold.value = -6;
  masterCompressor.knee.value = 15;
  masterCompressor.ratio.value = 3;
  masterCompressor.attack.value = 0.005;
  masterCompressor.release.value = 0.1;
  
  audioListener.gain.disconnect();
  audioListener.gain.connect(masterCompressor);
  masterCompressor.connect(ctx.destination);
  
  // Ensure AudioContext is running
  if (ctx.state === 'suspended') {
    ctx.resume();
  }

  // Mute the original HTML video element so we don't hear double audio natively
  video.muted = false; 
  mainVideo = video;
  audioCtx = ctx;
  
  videoSourceNode = ctx.createMediaElementSource(video);
  videoGainNode = ctx.createGain();
  videoGainNode.gain.value = 1.0;
  videoSourceNode.connect(videoGainNode);
  
  // Split source into 6 channels to fully support 5.1 Surround Sound
  audioSplitter = ctx.createChannelSplitter(6);
  videoGainNode.connect(audioSplitter);
  
  // Keep the separate soundtrack in step with the picture.
  mainVideo.addEventListener('play', () => { if (currentExternalAudio && !hold.active) currentExternalAudio.play().catch(() => {}); });
  mainVideo.addEventListener('pause', () => { if (currentExternalAudio) currentExternalAudio.pause(); });
  mainVideo.addEventListener('waiting', () => { if (currentExternalAudio) currentExternalAudio.pause(); });
  mainVideo.addEventListener('playing', () => {
    if (currentExternalAudio && !hold.active && currentExternalAudio.paused) currentExternalAudio.play().catch(() => {});
  });
  mainVideo.addEventListener('seeking', () => {
    // Stop the old sound while the seek bar is being dragged
    if (currentExternalAudio) currentExternalAudio.pause();
  });
  mainVideo.addEventListener('seeked', () => {
    // The FFmpeg stream is a live pipe and can't be seeked, so ask for a new
    // one that starts at the new position, once the seek has finished.
    if (currentExternalAudio && currentExternalAudio.dataset.rawUrl) {
      resyncCount = 0;
      switchAudioTrack(currentExternalAudio.dataset.rawUrl);
    }
  });
  mainVideo.addEventListener('ratechange', () => {
    if (currentExternalAudio) currentExternalAudio.playbackRate = mainVideo.playbackRate;
  });

  audioListener.setMasterVolume(masterVolume);
  driftTimer = setInterval(checkDrift, 3000);

  // 2. Global Theatre Reverb (Convolver)
  const convolver = ctx.createConvolver();
  convolver.buffer = createImpulseResponse(3.5, 4.0, ctx);
  const reverbGain = ctx.createGain();
  reverbGain.gain.value = 0.08; // Slight reverb for the entire mix
  convolver.connect(reverbGain);
  reverbGain.connect(audioListener.getInput());
  
  // Feed only L and R into reverb so we don't muddy the center dialogue
  const reverbMix = ctx.createGain();
  audioSplitter.connect(reverbMix, 0);
  audioSplitter.connect(reverbMix, 1);
  reverbMix.connect(convolver);

  // Helper to create physical virtual speakers
  function createSpeaker(x, y, z, refDist = 12) {
    const speaker = new THREE.PositionalAudio(audioListener);
    speaker.setRefDistance(refDist);
    speaker.setRolloffFactor(1);
    speaker.setDistanceModel('exponential');
    speaker.position.set(x, y, z);
    scene.add(speaker);
    return speaker;
  }

  // 3. Front Left Speaker (Channel 0)
  const frontLeft = createSpeaker(-SCR_W/2 - 2, SCR_Y, SCR_Z);
  const flGain = ctx.createGain(); flGain.gain.value = 0.8;
  audioSplitter.connect(flGain, 0);
  frontLeft.setNodeSource(flGain);

  // 4. Front Right Speaker (Channel 1)
  const frontRight = createSpeaker(SCR_W/2 + 2, SCR_Y, SCR_Z);
  const frGain = ctx.createGain(); frGain.gain.value = 0.8;
  audioSplitter.connect(frGain, 1);
  frontRight.setNodeSource(frGain);

  // 5. Center Speaker (Channel 2 - DIALOGUE)
  const center = createSpeaker(0, SCR_Y, SCR_Z);
  const centerGain = ctx.createGain(); centerGain.gain.value = 1.2; 
  audioSplitter.connect(centerGain, 2);
  center.setNodeSource(centerGain);

  // 6. Subwoofer (Channel 3 LFE + Bass Management from L/R)
  const sub = createSpeaker(0, 0.5, SCR_Z + 2);
  const subFilter = ctx.createBiquadFilter();
  subFilter.type = 'lowpass';
  subFilter.frequency.value = 120;
  
  const subGain = ctx.createGain(); subGain.gain.value = 1.0;
  audioSplitter.connect(subGain, 3); // True LFE channel
  
  // Bass management for stereo tracks (mix L/R into sub)
  const bassMix = ctx.createGain(); bassMix.gain.value = 0.5;
  audioSplitter.connect(bassMix, 0);
  audioSplitter.connect(bassMix, 1);
  bassMix.connect(subFilter);
  subFilter.connect(subGain);
  
  sub.setNodeSource(subGain);

  // 7. Surround Left (Channel 4 True Surround + delayed bleed for stereo)
  const surrLeft = createSpeaker(-ROOM_W/2 + 1, ROOM_H * 0.7, 5, 8);
  const slGain = ctx.createGain(); slGain.gain.value = 0.7;
  audioSplitter.connect(slGain, 4); // True SL
  
  const slDelay = ctx.createDelay(); slDelay.delayTime.value = 0.045;
  const slBleed = ctx.createGain(); slBleed.gain.value = 0.15;
  audioSplitter.connect(slDelay, 0); slDelay.connect(slBleed); slBleed.connect(slGain);
  
  surrLeft.setNodeSource(slGain);

  // 8. Surround Right (Channel 5 True Surround + delayed bleed for stereo)
  const surrRight = createSpeaker(ROOM_W/2 - 1, ROOM_H * 0.7, 5, 8);
  const srGain = ctx.createGain(); srGain.gain.value = 0.7;
  audioSplitter.connect(srGain, 5); // True SR
  
  const srDelay = ctx.createDelay(); srDelay.delayTime.value = 0.045;
  const srBleed = ctx.createGain(); srBleed.gain.value = 0.15;
  audioSplitter.connect(srDelay, 1); srDelay.connect(srBleed); srBleed.connect(srGain);
  
  surrRight.setNodeSource(srGain);

  initialized = true;
}

export function resumeAudio() {
  if (audioListener && audioListener.context.state === 'suspended') {
    audioListener.context.resume();
  }
}

// 0 to 1. Works for both the movie's own sound and a separate soundtrack.
export function setVolume(v) {
  masterVolume = Math.max(0, Math.min(1, v));
  if (audioListener) audioListener.setMasterVolume(masterVolume);
}

function endHold() {
  clearTimeout(holdTimer);
  if (!hold.active) return;
  hold.active = false;
  if (hold.resume) mainVideo.play().catch(() => {});
}

// How far the soundtrack is from the picture, in seconds (0 when there is none).
export function audioDrift() {
  if (!currentExternalAudio || !currentExternalAudio.dataset.rawUrl) return 0;
  return currentExternalStartTime + currentExternalAudio.currentTime - mainVideo.currentTime;
}

// The soundtrack can slip when the connection stalls. If it stays out of step,
// restart it at the picture's position. Capped so it can never loop forever.
function checkDrift() {
  if (!currentExternalAudio || !currentExternalAudio.dataset.rawUrl) return;
  if (hold.active || mainVideo.paused || mainVideo.seeking || currentExternalAudio.paused) { badDriftChecks = 0; return; }
  badDriftChecks = Math.abs(audioDrift()) > 0.35 ? badDriftChecks + 1 : 0;
  const now = performance.now();
  if (badDriftChecks >= 2 && now - lastResync > 12000 && resyncCount < 3) {
    resyncCount++;
    switchAudioTrack(currentExternalAudio.dataset.rawUrl);
  }
}

// Stops the separate soundtrack and goes back to the movie's own sound.
export function stopExternalAudio() {
  clearTimeout(holdTimer);
  hold.active = false;
  hold.resume = false;
  if (currentExternalAudio) {
    currentExternalAudio.pause();
    currentExternalAudio.oncanplay = null;
    delete currentExternalAudio.dataset.rawUrl;
    currentExternalAudio.removeAttribute('src');
    currentExternalAudio.load(); // Forces browser to abort the HTTP connection
  }
  if (videoGainNode) videoGainNode.gain.value = 1.0;
}

// `autoplay: true` starts the movie once the sound is ready even if it was paused.
export function switchAudioTrack(url, { autoplay = false } = {}) {
  if (!url) {
    stopExternalAudio();
    return;
  }

  if (!currentExternalAudio) {
    currentExternalAudio = new Audio();
    currentSourceNode = audioCtx.createMediaElementSource(currentExternalAudio);
    currentSourceNode.connect(audioSplitter);
  } else {
    currentExternalAudio.pause();
    currentExternalAudio.removeAttribute('src');
    currentExternalAudio.load(); // Abort the old connection instantly
  }

  // ALWAYS mute the native video track when using an external track!
  videoGainNode.gain.value = 0.0;

  // Hold the picture until the new sound is ready, so they start together.
  // (FFmpeg needs a moment to start, more so over a mobile connection.)
  if (!hold.active) {
    hold.resume = autoplay || !mainVideo.paused;
    hold.active = true;
    mainVideo.pause();
  } else if (autoplay) {
    hold.resume = true;
  }
  lastResync = performance.now();
  badDriftChecks = 0;
  currentExternalStartTime = mainVideo.currentTime;

  currentExternalAudio.dataset.rawUrl = url;
  currentExternalAudio.playbackRate = mainVideo.playbackRate;
  currentExternalAudio.src = `${url}?start=${currentExternalStartTime}`;
  currentExternalAudio.oncanplay = () => { currentExternalAudio.oncanplay = null; endHold(); };
  currentExternalAudio.onerror = (e) => {
    console.error("External audio failed to load!", e);
    endHold();
  };
  clearTimeout(holdTimer);
  holdTimer = setTimeout(endHold, 8000);
}
