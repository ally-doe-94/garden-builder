// Lighting, sun position, sky colour, the placement ground plane and the demo garden.

import * as THREE from 'three';
import { rngFrom } from './plants.js';

const DEG = Math.PI / 180;
const MID_MONTH_DAY = [15, 46, 74, 105, 135, 166, 196, 227, 258, 288, 319, 349];

// Approximate solar position for a latitude, month and local solar hour.
// Returns elevation and azimuth (bearing from north, clockwise) in radians.
export function sunPosition(lat, month, hour) {
  const doy = MID_MONTH_DAY[month - 1];
  const decl = 23.44 * DEG * Math.sin((2 * Math.PI * (284 + doy)) / 365);
  const h = (hour - 12) * 15 * DEG;
  const phi = lat * DEG;
  const sinEl = Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(h);
  const elevation = Math.asin(THREE.MathUtils.clamp(sinEl, -1, 1));
  const azimuth = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(phi) - Math.tan(decl) * Math.cos(phi)) + Math.PI;
  return { elevation, azimuth };
}

// Compass bearing (0 = scene north) to a horizontal unit vector. Scene north is -Z when north offset is 0.
export function bearingToVector(bearing, out = new THREE.Vector3()) {
  return out.set(Math.sin(bearing), 0, -Math.cos(bearing));
}

const SKY_NIGHT = new THREE.Color('#0d1626');
const SKY_DUSK = new THREE.Color('#d98f6a');
const SKY_DAY = new THREE.Color('#a7cbe3');
const SUN_LOW = new THREE.Color('#ffb070');
const SUN_HIGH = new THREE.Color('#fff4e0');

export function createEnvironment(scene) {
  const hemi = new THREE.HemisphereLight('#dfefff', '#4a5a3a', 1.0);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight('#fff4e0', 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  // Invisible plane at y = 0 used as a fallback surface for placing plants.
  const groundPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  groundPlane.name = 'groundPlane';
  scene.add(groundPlane);

  const grid = new THREE.GridHelper(40, 40, 0x7bc67e, 0x4d6b55);
  grid.material.transparent = true;
  grid.material.opacity = 0.35;
  grid.position.y = 0.005;
  grid.visible = false;
  scene.add(grid);

  const compass = createCompass();
  compass.visible = false;
  scene.add(compass);

  let radius = 15;
  const dir = new THREE.Vector3();

  function setSun({ lat, month, hour, north }) {
    const { elevation, azimuth } = sunPosition(lat, month, hour);
    bearingToVector(azimuth + north * DEG, dir).multiplyScalar(Math.cos(elevation));
    dir.y = Math.sin(elevation);
    dir.normalize();

    const day = THREE.MathUtils.smoothstep(elevation, -0.1, 0.25);
    const low = 1 - THREE.MathUtils.smoothstep(elevation, 0.05, 0.6);

    sun.position.copy(sun.target.position).addScaledVector(dir, radius * 2.5);
    sun.intensity = 2.8 * THREE.MathUtils.smoothstep(elevation, -0.02, 0.15);
    sun.color.copy(SUN_HIGH).lerp(SUN_LOW, low);
    hemi.intensity = 0.25 + 0.85 * day;

    const sky = SKY_NIGHT.clone().lerp(SKY_DAY, day);
    sky.lerp(SKY_DUSK, low * day * 0.45);
    scene.background = sky;
    scene.fog.color.copy(sky);

    compass.rotation.y = -north * DEG;
    return { elevation, azimuth };
  }

  function fit(box) {
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    radius = Math.max(4, Math.hypot(size.x, size.z) / 2 + 2, size.y);
    const cam = sun.shadow.camera;
    cam.left = cam.bottom = -radius;
    cam.right = cam.top = radius;
    cam.near = 0.5;
    cam.far = radius * 6;
    cam.updateProjectionMatrix();
    sun.target.position.set(center.x, 0, center.z);
    grid.scale.setScalar(Math.max(1, Math.ceil((radius * 2) / 40)));
    compass.position.set(center.x, 0.02, center.z);
    compass.scale.setScalar(Math.max(1, radius / 6));
    scene.fog.near = radius * 4;
    scene.fog.far = radius * 12;
  }

  scene.fog = new THREE.Fog('#a7cbe3', 60, 200);
  return { sun, hemi, groundPlane, grid, compass, setSun, fit };
}

function createCompass() {
  const g = new THREE.Group();
  const mat = (color) => new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 });
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.45, 1.55, 64).rotateX(-Math.PI / 2), mat('#ffffff'));
  const needle = new THREE.Shape();
  needle.moveTo(0, -1.4); needle.lineTo(0.18, 0); needle.lineTo(-0.18, 0); needle.closePath();
  const north = new THREE.Mesh(new THREE.ShapeGeometry(needle).rotateX(-Math.PI / 2), mat('#e53935'));
  const south = new THREE.Mesh(new THREE.ShapeGeometry(needle).rotateX(-Math.PI / 2).rotateY(Math.PI), mat('#eeeeee'));
  for (const m of [ring, north, south]) {
    m.renderOrder = 20;
    m.raycast = () => {};
    g.add(m);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Demo garden: a typical narrow back garden, ~9 m × 14 m, so the planner can
// be tried before a scan exists. House is at +Z, the back fence at -Z.
// ---------------------------------------------------------------------------

export function createDemoGarden() {
  const rng = rngFrom(7);
  const group = new THREE.Group();
  group.name = 'Demo garden';
  const W = 9, L = 14;
  const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.95, ...extra });

  // Lawn with gentle undulation and colour variation.
  const lawnGeo = new THREE.PlaneGeometry(W, L, 36, 56).rotateX(-Math.PI / 2);
  const pos = lawnGeo.attributes.position;
  const colors = [];
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, Math.sin(x * 0.7) * Math.cos(z * 0.45) * 0.04 + (rng() - 0.5) * 0.015);
    c.set('#6f9d4b').offsetHSL((rng() - 0.5) * 0.02, 0, (rng() - 0.5) * 0.06);
    colors.push(c.r, c.g, c.b);
  }
  lawnGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  lawnGeo.computeVertexNormals();
  const lawn = new THREE.Mesh(lawnGeo, std('#ffffff', { vertexColors: true }));
  lawn.receiveShadow = true;
  group.add(lawn);

  // Borders (bare soil) down both sides and across the back.
  const soil = std('#5a4433');
  const border = (w, d, x, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), soil);
    m.position.set(x, 0.01, z);
    m.receiveShadow = true;
    group.add(m);
  };
  border(1.2, L - 3, -W / 2 + 0.6, -1.5);
  border(1.2, L - 3, W / 2 - 0.6, -1.5);
  border(W, 1.4, 0, -L / 2 + 0.7);

  // Patio by the house.
  const slabMat = [std('#b9b1a3'), std('#c4bcae'), std('#aea597')];
  for (let x = 0; x < 6; x++) {
    for (let z = 0; z < 4; z++) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.05, 0.58), slabMat[Math.floor(rng() * 3)]);
      slab.position.set(-W / 2 + 0.3 + 0.6 * x + 1.2, 0.03, L / 2 - 0.3 - 0.6 * z);
      slab.receiveShadow = slab.castShadow = true;
      group.add(slab);
    }
  }

  // Stepping-stone path down the lawn.
  for (let i = 0; i < 9; i++) {
    const stone = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.26, 0.04, 9), slabMat[i % 3]);
    stone.position.set(0.6 + Math.sin(i * 0.6) * 0.5, 0.03, L / 2 - 3.2 - i * 1.0);
    stone.receiveShadow = true;
    group.add(stone);
  }

  // Fence panels and posts.
  const fenceMat = std('#7a5a3e');
  const postMat = std('#5c432e');
  const fenceRun = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.round(len / 1.8);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const panel = new THREE.Mesh(new THREE.BoxGeometry(len / n - 0.08, 1.8, 0.04), fenceMat);
      panel.position.set(x0 + (x1 - x0) * t, 0.9, z0 + (z1 - z0) * t);
      panel.rotation.y = -Math.atan2(z1 - z0, x1 - x0);
      panel.castShadow = panel.receiveShadow = true;
      group.add(panel);
    }
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.9, 0.1), postMat);
      post.position.set(x0 + (x1 - x0) * t, 0.95, z0 + (z1 - z0) * t);
      post.castShadow = true;
      group.add(post);
    }
  };
  fenceRun(-W / 2, L / 2, -W / 2, -L / 2);
  fenceRun(W / 2, L / 2, W / 2, -L / 2);
  fenceRun(-W / 2, -L / 2, W / 2, -L / 2);

  // Shed in the back corner.
  const shed = new THREE.Group();
  const shedBody = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 1.6), std('#6b8f8a'));
  shedBody.position.y = 1;
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 1.45, 0.6, 4, 1), std('#3a3a3a'));
  roof.rotation.y = Math.PI / 4;
  roof.scale.set(1, 1, 0.8);
  roof.position.y = 2.3;
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.7, 0.03), std('#55736f'));
  door.position.set(0.4, 0.85, 0.81);
  shed.add(shedBody, roof, door);
  shed.position.set(W / 2 - 1.3, 0, -L / 2 + 1.1);
  shed.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  group.add(shed);

  // Back wall of the house.
  const house = new THREE.Mesh(new THREE.BoxGeometry(W, 5.5, 0.3), std('#b07a5e'));
  house.position.set(0, 2.75, L / 2 + 0.15);
  house.castShadow = house.receiveShadow = true;
  group.add(house);
  const doorway = new THREE.Mesh(new THREE.BoxGeometry(1.6, 2.1, 0.05), std('#2d3a40', { roughness: 0.3 }));
  doorway.position.set(-0.8, 1.05, L / 2 - 0.02);
  group.add(doorway);
  for (const x of [-2.9, 2.6]) {
    const win = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 0.05), std('#2d3a40', { roughness: 0.3 }));
    win.position.set(x, 1.6, L / 2 - 0.02);
    group.add(win);
  }

  return group;
}
