import * as THREE from 'three';
import { updateScreenMasking, updateSubtitles } from './sceneBuilder.js';

export const video = document.getElementById('cinema-video');
video.volume = 1.0;
export const videoTexture = new THREE.VideoTexture(video);
videoTexture.minFilter = THREE.LinearFilter;
videoTexture.magFilter = THREE.LinearFilter;
videoTexture.colorSpace = THREE.SRGBColorSpace;


export const vrfc = 'requestVideoFrameCallback' in video;
export function scheduleVRFC() {
  video.requestVideoFrameCallback(() => {
    videoTexture.needsUpdate = true;
    if (!video.paused && !video.ended) scheduleVRFC();
  });
}

// Screen Wake Lock API to prevent laptop screen from sleeping while watching a movie
let wakeLock = null;
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
    } catch (err) {
      console.error('WakeLock Error:', err);
    }
  }
}
function releaseWakeLock() {
  if (wakeLock !== null) {
    wakeLock.release();
    wakeLock = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !video.paused) {
    requestWakeLock();
  }
});

video.addEventListener('play', () => { 
  requestWakeLock();
  if (vrfc) scheduleVRFC(); 
});

video.addEventListener('pause', () => {
  releaseWakeLock();
});

export const state = { hasVideo: false, nativeSubtitles: false };
let loadId = 0;
let lastVT = -1;

export function updateVideo() {
  if (!vrfc && !video.paused && video.currentTime !== lastVT) {
    videoTexture.needsUpdate = true;
    lastVT = video.currentTime;
  }
  
  // Read active subtitle cues for the 3D Subtitle Mesh
  let subText = '';
  if (video.textTracks && video.textTracks.length > 0) {
    const activeCues = video.textTracks[0].activeCues;
    if (activeCues && activeCues.length > 0) {
      subText = activeCues[0].text;
    }
  }
  updateSubtitles(subText);
}

const sampleCanvas = document.createElement('canvas');
sampleCanvas.width = 16;
sampleCanvas.height = 16;
const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

const targetColor = new THREE.Color(0,0,0);
const currentColor = new THREE.Color(0,0,0);
let targetIntensity = 0;
let currentIntensity = 0;

let lastGlowTime = 0;

export function updateScreenGlow(glowLight) {
  if (!state.hasVideo || video.paused || video.ended || !glowLight) return;

  const now = performance.now();
  if (now - lastGlowTime > 100) { // Throttle pixel extraction to 10 fps
    lastGlowTime = now;
    sampleCtx.drawImage(video, 0, 0, 16, 16);
    const frame = sampleCtx.getImageData(0, 0, 16, 16).data;
    
    let r=0, g=0, b=0;
    for(let i=0; i<frame.length; i+=4) {
      r += frame[i];
      g += frame[i+1];
      b += frame[i+2];
    }
    const count = frame.length / 4;
  
  // Three.js colors require setting from sRGB if source is sRGB
  targetColor.setRGB(r/255/count, g/255/count, b/255/count, THREE.SRGBColorSpace);

  // Get true luminance of the scene before modifying the color
  const luminance = 0.2126 * targetColor.r + 0.7152 * targetColor.g + 0.0722 * targetColor.b;

    // Extract HSL to boost saturation and normalize lightness.
    // This ensures bright daylight scenes don't just emit pure white,
    // but instead emit the beautiful true dominant hue of the scene.
    const hsl = {h: 0, s: 0, l: 0};
    targetColor.getHSL(hsl);
    
    // Boost saturation by 50% for a more cinematic lighting feel, cap at 1.0
    // Normalize lightness to 0.5 so the color itself doesn't influence brightness
    targetColor.setHSL(hsl.h, Math.min(1.0, hsl.s * 1.5), 0.5);

    // Intensity is now purely driven by the true luminance. 
    // Lowered the multiplier so it doesn't overexpose the front stage.
    targetIntensity = luminance * 20.0;
  }

  currentColor.lerp(targetColor, 0.08); // Smooth color transition
  currentIntensity += (targetIntensity - currentIntensity) * 0.08; // Smooth intensity transition

  glowLight.color.copy(currentColor);
  glowLight.intensity = currentIntensity * glowLight.userData.scale;
}

// Loads a movie and calls onReady once it can be played (it does not start it).
// A newer call cancels the callbacks of an older one.
export function loadVideoUrl(url, { startAt = 0, onReady, onError } = {}) {
  const id = ++loadId;
  state.hasVideo = false;
  video.pause();
  loadSubtitleTrack(null);

  const done = () => {
    video.removeEventListener('loadedmetadata', onMeta);
    video.removeEventListener('error', onErr);
  };
  const onMeta = () => {
    if (id !== loadId) return;
    done();
    // Sound but no picture means the browser can't decode this video format.
    if (!video.videoWidth) { if (onError) onError(null); return; }
    state.hasVideo = true;
    updateScreenMasking(video.videoWidth / video.videoHeight, videoTexture);
    if (startAt > 0 && startAt < (video.duration || Infinity)) video.currentTime = startAt;
    if (onReady) onReady();
  };
  const onErr = () => {
    if (id !== loadId) return;
    done();
    if (onError) onError(video.error);
  };
  video.addEventListener('loadedmetadata', onMeta);
  video.addEventListener('error', onErr);

  video.src = url;
  video.load();
}

export function unloadVideo() {
  loadId++;
  state.hasVideo = false;
  video.pause();
  loadSubtitleTrack(null);
  video.removeAttribute('src');
  video.load();
}

// In the 3D theatre the subtitles are drawn on the cinema screen ('hidden' keeps
// the browser reading the cues without drawing them). In the flat view the
// browser draws them itself.
function applySubtitleMode() {
  for (const track of video.textTracks) {
    track.mode = state.nativeSubtitles ? 'showing' : 'hidden';
  }
}

export function setNativeSubtitles(on) {
  state.nativeSubtitles = on;
  applySubtitleMode();
}

export function loadSubtitleTrack(url) {
  Array.from(video.querySelectorAll('track')).forEach(t => t.remove());
  if (url) {
    const track = document.createElement('track');
    track.src = url;
    track.kind = 'subtitles';
    track.default = true;

    video.appendChild(track);

    // The mode must be set AFTER appending, and again once the track has
    // loaded, or the browser falls back to its own default.
    applySubtitleMode();
    track.addEventListener('load', applySubtitleMode);
  }
}
