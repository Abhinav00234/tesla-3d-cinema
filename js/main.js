import * as THREE from 'three';
import { videoTexture, updateVideo, updateScreenGlow } from './videoManager.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { buildRoom, buildScreen, buildCurtains, buildSeats, buildStage, buildLighting, updateBeam } from './sceneBuilder.js';
import { initPost, updatePost, resizePost } from './postprocessing.js';
import { initUI } from './ui.js';
import { settings } from './store.js';

const canvas = document.getElementById('theatre-canvas');
// Smooth mode is for weak graphics chips (car screens): no anti-aliasing, no bloom, 1x resolution.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: settings.quality !== 'smooth', powerPreference:'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.NoToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.fog = new THREE.FogExp2(0x000000, 0.016);
const camera = new THREE.PerspectiveCamera(58, window.innerWidth/window.innerHeight, 0.1, 120);
camera.position.set(0, 2.43, 4.66);

buildRoom(scene);
buildScreen(scene, videoTexture);
buildCurtains(scene);
buildSeats(scene);
buildStage(scene);

RectAreaLightUniformsLib.init();
const lights = buildLighting(scene);

const post = initPost(renderer, scene, camera);

// ── Picture quality ────────────────────────────────────────────────
let quality = settings.quality;
const maxPixelRatio = () => (quality === 'smooth' ? 1 : Math.min(window.devicePixelRatio, 2));
const minPixelRatio = () => (quality === 'best' ? maxPixelRatio() : quality === 'smooth' ? 0.6 : 0.75);
let pxR = maxPixelRatio();

function applyPixelRatio() {
  renderer.setPixelRatio(pxR);
  resizePost(window.innerWidth, window.innerHeight);
}
applyPixelRatio();

function setQuality(q) {
  quality = q;
  pxR = maxPixelRatio();
  applyPixelRatio();
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  resizePost(window.innerWidth, window.innerHeight);
});

let fpsF=0, fpsL=0;
const fpsEl=document.getElementById('fps-counter');

function animate(t) {
  fpsF++;
  if (t - fpsL > 1000) {
    const fps = fpsF; fpsEl.textContent = fps + ' fps'; fpsF = 0; fpsL = t;
    // Trade sharpness for smoothness when the frame rate drops, and back again.
    if (fps < 40 && pxR > minPixelRatio()) { pxR = Math.max(minPixelRatio(), pxR - 0.25); applyPixelRatio(); }
    else if (fps > 56 && pxR < maxPixelRatio()) { pxR = Math.min(maxPixelRatio(), pxR + 0.25); applyPixelRatio(); }
  }

  updatePost(t);
  updateVideo();
  updateScreenGlow(lights.screenGlow);
  updateBeam(t);

  if (uiDeps.updateCamera) uiDeps.updateCamera();
  if (quality === 'smooth') renderer.render(scene, camera);
  else post.composer.render();
}

// ── Running / paused ───────────────────────────────────────────────
// Drawing the theatre is wasted work while the library covers it or the flat
// view is showing, so the loop only runs when the theatre can be seen.
let active = false;   // the library opens first, so nothing is drawn until a movie starts
function updateLoop() {
  renderer.setAnimationLoop(active && !document.hidden ? animate : null);
}
function setActive(on) {
  active = on;
  updateLoop();
}
document.addEventListener('visibilitychange', updateLoop);

const uiDeps = { camera, renderer, lights, scene, engine: { setQuality, setActive, renderOnce: () => animate(performance.now()) } };
initUI(uiDeps);
updateLoop();
