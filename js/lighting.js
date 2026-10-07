import * as THREE from 'three';
import { ROOM_H, SCR_W, SCR_H, SCR_Z, SCR_Y } from './config.js';

// Brightness of the spotlight glow relative to the area light, matched by eye on the walls.
const SPOT_SCALE = 550;

let beam;
export function buildBeam(scene) {
  const geo = new THREE.ConeGeometry(1.1, 28, 24, 1, true);
  const mat = new THREE.MeshBasicMaterial({ color:0xffffff, transparent:true, opacity:0.016, side:THREE.BackSide, depthWrite:false, blending:THREE.AdditiveBlending });
  beam = new THREE.Mesh(geo, mat);
  beam.rotation.x = -Math.PI/2;
  beam.position.set(0, 10.8, SCR_Z+16);
  scene.add(beam);

  // Physical projector box
  const projMat = new THREE.MeshStandardMaterial({ color:0x0a0a0a, metalness:0.85, roughness:0.2 });
  const proj = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.0, 2.6), projMat);
  proj.position.set(0, 10.8, SCR_Z+17.5);
  scene.add(proj);

  const lensMat = new THREE.MeshStandardMaterial({ color:0x000000, metalness:1, roughness:0.0 });
  const lensGeo = new THREE.CylinderGeometry(0.18, 0.22, 0.25, 20); lensGeo.rotateX(Math.PI/2);
  const lens = new THREE.Mesh(lensGeo, lensMat);
  lens.position.set(0, 10.8, SCR_Z+16.3);
  scene.add(lens);

  // Lens glow
  const lensGlow = new THREE.PointLight(0xddeeff, 0.4, 3);
  lensGlow.position.set(0, 10.8, SCR_Z+16.1);
  scene.add(lensGlow);
}

export function updateBeam(t) {
  if(beam) beam.material.opacity = 0.014 + Math.sin(t*0.0007)*0.004;
}

export function buildLighting(scene) {
  const ambientLight = new THREE.AmbientLight(0x08050a, 1.0); scene.add(ambientLight);

  // Screen area glow (dynamic, driven by video colour)
  const screenArea = new THREE.RectAreaLight(0xffffff, 0, SCR_W, SCR_H);
  screenArea.position.set(0, SCR_Y, SCR_Z + 0.5);
  // Tilt the light slightly upwards and towards the back seats so it doesn't
  // overexpose the stage floor directly in front of the screen.
  screenArea.lookAt(0, SCR_Y + 15, 10);
  screenArea.userData.scale = 1;
  scene.add(screenArea);

  // The area light is the most expensive light type, so the lighter quality
  // modes use a wide soft spotlight from behind the screen instead.
  const screenSpot = new THREE.SpotLight(0xffffff, 0, 0, Math.PI/3, 0.6, 2);
  screenSpot.position.set(0, SCR_Y, SCR_Z - 12);
  screenSpot.target.position.set(0, SCR_Y + 2, 10);
  screenSpot.userData.scale = SPOT_SCALE;
  screenSpot.visible = false;
  scene.add(screenSpot); scene.add(screenSpot.target);

  // Ceiling down-spots (togglable house lights). Hidden while off: three.js
  // still shades every visible light even at intensity 0.
  const ceilSpots = [];
  [[-12,ROOM_H-0.3,-2],[12,ROOM_H-0.3,-2],[-12,ROOM_H-0.3,8],[12,ROOM_H-0.3,8],
   [-12,ROOM_H-0.3,18],[12,ROOM_H-0.3,18],[0,ROOM_H-0.3,4],[0,ROOM_H-0.3,14]].forEach(([x,y,z]) => {
    const s = new THREE.SpotLight(0xffe8c0, 0, 0, Math.PI/7, 0.4);
    s.position.set(x,y,z); s.target.position.set(x,-0.5,z); s.visible = false;
    scene.add(s); scene.add(s.target); ceilSpots.push(s);
  });

  return { ambientLight, screenGlow: screenArea, screenArea, screenSpot, ceilSpots };
}
