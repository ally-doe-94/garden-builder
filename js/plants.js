// Procedural low-poly plant library.
// Every plant is built at its mature size (metres) from simple jittered shapes,
// merged into one mesh per role/colour so a garden of dozens of plants stays fast.
// Roles drive the seasonal behaviour: foliage changes colour or disappears,
// flowers and fruit only show in their season, trunks and mulch always stay.

import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export function rngFrom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seasonForMonth(month, southern = false) {
  const m = southern ? ((month + 5) % 12) + 1 : month;
  if (m >= 3 && m <= 5) return 'spring';
  if (m >= 6 && m <= 8) return 'summer';
  if (m >= 9 && m <= 11) return 'autumn';
  return 'winter';
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

// Transform a geometry in place: position, rotation (yaw applied last), scale.
function xf(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) {
  _e.set(rx, ry, rz, 'YXZ');
  _q.setFromEuler(_e);
  _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
  return geo.applyMatrix4(_m);
}

function blob(rng, r, { detail = 1, jitter = 0.22 } = {}) {
  let g = new THREE.IcosahedronGeometry(r, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const p = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).multiplyScalar(1 + (rng() * 2 - 1) * jitter);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  return g;
}

const cyl = (rTop, rBottom, h, seg = 6) => new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1).translate(0, h / 2, 0);
const cone = (r, h, seg = 5) => new THREE.ConeGeometry(r, h, seg, 1).translate(0, h / 2, 0);
const box = (w, h, d) => new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0);

// Point a base-at-origin, +Y geometry from `from` towards `to`.
function orient(geo, from, to) {
  const dir = to.clone().sub(from).normalize();
  _q.setFromUnitVectors(UP, dir);
  _m.compose(from, _q, _s.set(1, 1, 1));
  return geo.applyMatrix4(_m);
}

function limb(from, to, r0, r1, seg = 5) {
  return orient(cyl(r1, r0, from.distanceTo(to), seg), from, to);
}

function inEllipsoid(rng, rx, ry, rz) {
  let x, y, z;
  do { x = rng() * 2 - 1; y = rng() * 2 - 1; z = rng() * 2 - 1; } while (x * x + y * y + z * z > 1);
  return V(x * rx, y * ry, z * rz);
}

function onEllipsoid(rng, rx, ry, rz, minY = -1) {
  const v = new THREE.Vector3();
  for (let i = 0; i < 50; i++) {
    v.set(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1);
    const l = v.length();
    if (l > 1 || l < 0.1) continue;
    v.divideScalar(l);
    if (v.y >= minY) break;
  }
  return v.set(v.x * rx, v.y * ry, v.z * rz);
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

class Builder {
  constructor(seed) {
    this.rng = rngFrom(seed);
    this.parts = new Map();
  }

  add(role, color, geo) {
    const key = `${role}|${color}`;
    if (!this.parts.has(key)) this.parts.set(key, { role, color, geos: [] });
    let g = geo.index ? geo.toNonIndexed() : geo;
    for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
    this.parts.get(key).geos.push(g);
  }

  build() {
    const group = new THREE.Group();
    for (const { role, color, geos } of this.parts.values()) {
      const geo = mergeGeometries(geos);
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.85, metalness: 0 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = role !== 'mulch';
      mesh.receiveShadow = true;
      mesh.userData.role = role;
      mesh.userData.baseColor = new THREE.Color(color);
      group.add(mesh);
    }
    return group;
  }
}

// A cloud of leafy blobs inside an ellipsoid centred at height cy.
function canopy(b, { cy, rx, ry, rz, n, r, color, squash = 1 }) {
  const { rng } = b;
  for (let i = 0; i < n; i++) {
    const p = inEllipsoid(rng, rx * 0.7, ry * 0.7, rz * 0.7);
    const s = 0.75 + rng() * 0.5;
    b.add('foliage', color, xf(blob(rng, r * s), p.x, cy + p.y, p.z, 0, rng() * 6, 0, 1, squash, 1));
  }
}

// Small blobs scattered over the outside of a canopy (flowers, fruit).
function dots(b, role, colors, { cy, rx, ry, rz, n, r, minY = -0.4, detail = 0 }) {
  const { rng } = b;
  for (let i = 0; i < n; i++) {
    const p = onEllipsoid(rng, rx, ry, rz, minY);
    b.add(role, pick(rng, colors), xf(blob(rng, r * (0.8 + rng() * 0.4), { detail }), p.x, cy + p.y, p.z));
  }
}

function mulch(b, r) {
  b.add('mulch', '#4a3a2b', cyl(r, r * 1.05, 0.03, 14));
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------
// height / spread: mature size in metres. mature: years to reach it.
// start: fraction of mature size when planted. winter: 'bare' | 'autumn' | 'keep'.
// dormant: seasons when the plant dies back to the ground.

export const CATEGORIES = ['Trees', 'Shrubs', 'Flowers', 'Foliage', 'Edible'];

export const PLANTS = [
  {
    id: 'oak', name: 'English oak', latin: 'Quercus robur', emoji: '🌳', category: 'Trees',
    height: 10, spread: 9, mature: 40, start: 0.12, sun: 'Full sun', type: 'Deciduous tree',
    autumn: '#a8742c', winter: 'bare', bloom: [], bloomText: '—',
    build(b) {
      const { rng } = b;
      const bark = '#5b4636';
      b.add('trunk', bark, cyl(0.22, 0.4, 5, 7));
      const cy = 6.3;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + rng();
        b.add('trunk', bark, limb(V(0, 3.6 + rng() * 1.2, 0), V(Math.cos(a) * 2.8, cy - 0.5 + rng() * 1.5, Math.sin(a) * 2.8), 0.16, 0.06));
      }
      canopy(b, { cy, rx: 4, ry: 2.8, rz: 4, n: 16, r: 1.6, color: '#4f7a34' });
    },
  },
  {
    id: 'birch', name: 'Silver birch', latin: 'Betula pendula', emoji: '🌳', category: 'Trees',
    height: 11, spread: 5, mature: 25, start: 0.15, sun: 'Full sun / part shade', type: 'Deciduous tree',
    autumn: '#e3c13f', winter: 'bare', bloom: [], bloomText: 'Catkins Apr',
    build(b) {
      const { rng } = b;
      b.add('trunk', '#e6e1d6', cyl(0.08, 0.2, 9, 7));
      for (let i = 0; i < 14; i++) {
        const y = 0.3 + rng() * 7.5;
        const r = 0.2 - 0.12 * (y / 9);
        const a = rng() * Math.PI * 2;
        b.add('trunk', '#2f2b28', xf(box(r * 1.1, 0.05, r * 0.9), Math.cos(a) * r * 0.55, y, Math.sin(a) * r * 0.55, 0, a, 0));
      }
      const cy = 8;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + rng();
        b.add('trunk', '#cfc8bb', limb(V(0, 5.5 + rng() * 2, 0), V(Math.cos(a) * 1.5, cy + rng(), Math.sin(a) * 1.5), 0.06, 0.02));
      }
      canopy(b, { cy, rx: 2.2, ry: 3.2, rz: 2.2, n: 22, r: 0.9, color: '#86b04f' });
    },
  },
  {
    id: 'apple', name: 'Apple tree', latin: 'Malus domestica', emoji: '🍎', category: 'Edible',
    height: 4.2, spread: 4, mature: 10, start: 0.3, sun: 'Full sun', type: 'Deciduous fruit tree',
    autumn: '#c99a3a', winter: 'bare', bloom: ['spring'], fruit: ['autumn'], bloomText: 'Apr–May · fruit Sep–Oct',
    build(b) {
      const { rng } = b;
      const bark = '#6b4f3a';
      b.add('trunk', bark, cyl(0.08, 0.14, 1.6));
      const cy = 2.7;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + rng();
        b.add('trunk', bark, limb(V(0, 1.3, 0), V(Math.cos(a) * 1.3, cy - 0.2 + rng() * 0.6, Math.sin(a) * 1.3), 0.07, 0.03));
      }
      canopy(b, { cy, rx: 1.9, ry: 1.1, rz: 1.9, n: 12, r: 0.75, color: '#5f8c3a' });
      const shell = { cy, rx: 1.9 * 0.7 + 0.6, ry: 1.1 * 0.7 + 0.6, rz: 1.9 * 0.7 + 0.6 };
      dots(b, 'flower', ['#fbe3ec', '#ffffff', '#f6cbd9'], { ...shell, n: 70, r: 0.09, minY: -0.2 });
      dots(b, 'fruit', ['#c0392b', '#d35400', '#a93226'], { ...shell, n: 30, r: 0.07, minY: -0.6, detail: 1 });
    },
  },
  {
    id: 'cherry', name: 'Flowering cherry', latin: 'Prunus serrulata', emoji: '🌸', category: 'Trees',
    height: 6, spread: 6, mature: 15, start: 0.25, sun: 'Full sun', type: 'Deciduous tree',
    autumn: '#d9542b', winter: 'bare', bloom: ['spring'], bloomText: 'Apr',
    build(b) {
      const { rng } = b;
      const bark = '#4a3530';
      b.add('trunk', bark, cyl(0.12, 0.2, 2.2, 7));
      const cy = 3.8;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + rng();
        b.add('trunk', bark, limb(V(0, 1.9, 0), V(Math.cos(a) * 2.2, cy - 0.3 + rng() * 0.6, Math.sin(a) * 2.2), 0.1, 0.04));
      }
      canopy(b, { cy, rx: 2.8, ry: 1.4, rz: 2.8, n: 14, r: 1.0, color: '#5a8a3c' });
      dots(b, 'flower', ['#f7b6cf', '#f9c9da', '#f3a0c0'], { cy, rx: 2.8 * 0.7 + 0.8, ry: 1.4 * 0.7 + 0.8, rz: 2.8 * 0.7 + 0.8, n: 140, r: 0.17, minY: -0.3 });
    },
  },
  {
    id: 'maple', name: 'Japanese maple', latin: 'Acer palmatum', emoji: '🍁', category: 'Trees',
    height: 2.8, spread: 3.4, mature: 15, start: 0.25, sun: 'Part shade', type: 'Deciduous small tree',
    autumn: '#e8641f', winter: 'bare', bloom: [], bloomText: '—',
    build(b) {
      const { rng } = b;
      const bark = '#5a3d2e';
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + rng();
        b.add('trunk', bark, limb(V(0, 0, 0), V(Math.cos(a) * 0.5, 1.6, Math.sin(a) * 0.5), 0.08, 0.04));
      }
      for (let t = 0; t < 3; t++) {
        const y = 1.25 + t * 0.55;
        const ring = 1.15 - t * 0.35;
        const n = 7 - t * 2;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + rng();
          b.add('foliage', '#a8322d', xf(blob(rng, 0.55 - t * 0.08), Math.cos(a) * ring, y, Math.sin(a) * ring, 0, rng() * 6, 0, 1, 0.45, 1));
        }
      }
    },
  },
  {
    id: 'conifer', name: 'Upright yew', latin: "Taxus baccata 'Fastigiata'", emoji: '🌲', category: 'Trees',
    height: 4, spread: 1.3, mature: 15, start: 0.3, sun: 'Sun or shade', type: 'Evergreen conifer',
    winter: 'keep', bloom: [], bloomText: '—',
    build(b) {
      const { rng } = b;
      b.add('trunk', '#5a3d2e', cyl(0.05, 0.08, 0.4));
      for (let i = 0; i < 10; i++) {
        const y = 0.35 + i * 0.34;
        const r = 0.5 * (1 - i / 13);
        for (let k = 0; k < 3; k++) {
          const a = rng() * Math.PI * 2;
          b.add('foliage', '#2c5232', xf(blob(rng, r), Math.cos(a) * r * 0.25, y, Math.sin(a) * r * 0.25, 0, 0, 0, 1, 1.5, 1));
        }
      }
    },
  },
  {
    id: 'box', name: 'Box ball', latin: 'Buxus sempervirens', emoji: '🟢', category: 'Shrubs',
    height: 0.65, spread: 0.65, mature: 6, start: 0.5, sun: 'Sun or shade', type: 'Evergreen shrub',
    winter: 'keep', bloom: [], bloomText: '—',
    build(b) {
      b.add('foliage', '#3d6b2f', xf(blob(b.rng, 0.32, { detail: 2, jitter: 0.06 }), 0, 0.31, 0));
    },
  },
  {
    id: 'hedge', name: 'Beech hedge (1 m)', latin: 'Fagus sylvatica', emoji: '🌿', category: 'Shrubs',
    height: 1.8, spread: 1, mature: 6, start: 0.4, sun: 'Sun / part shade', type: 'Deciduous hedge, holds brown leaves in winter',
    autumn: '#a0622d', winter: 'autumn', bloom: [], bloomText: '—',
    build(b) {
      const { rng } = b;
      for (let i = 0; i < 16; i++) {
        b.add('foliage', '#4d7a2e', xf(blob(rng, 0.28), rng() * 0.84 - 0.42, 0.28 + rng() * 1.25, rng() * 0.3 - 0.15));
      }
    },
  },
  {
    id: 'hydrangea', name: 'Hydrangea', latin: 'Hydrangea macrophylla', emoji: '💠', category: 'Shrubs',
    height: 1.2, spread: 1.4, mature: 5, start: 0.35, sun: 'Part shade', type: 'Deciduous shrub',
    autumn: '#9a7b3c', winter: 'bare', bloom: ['summer'], bloomText: 'Jul–Sep',
    build(b) {
      const cy = 0.55;
      mulch(b, 0.55);
      canopy(b, { cy, rx: 0.65, ry: 0.4, rz: 0.65, n: 9, r: 0.35, color: '#4f7d3d' });
      dots(b, 'flower', ['#7fa3e0', '#9bb5ea', '#b39ddb'], { cy, rx: 0.7, ry: 0.55, rz: 0.7, n: 14, r: 0.17, minY: -0.1, detail: 1 });
    },
  },
  {
    id: 'rose', name: 'Shrub rose', latin: 'Rosa', emoji: '🌹', category: 'Flowers',
    height: 1.2, spread: 1, mature: 4, start: 0.4, sun: 'Full sun', type: 'Deciduous shrub',
    autumn: '#8a6d2f', winter: 'bare', bloom: ['summer'], bloomText: 'Jun–Sep',
    build(b) {
      const { rng } = b;
      mulch(b, 0.4);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + rng();
        b.add('trunk', '#4d6b2e', limb(V(0, 0, 0), V(Math.cos(a) * 0.4, 0.9 + rng() * 0.3, Math.sin(a) * 0.4), 0.02, 0.012, 4));
      }
      const cy = 0.65;
      canopy(b, { cy, rx: 0.42, ry: 0.4, rz: 0.42, n: 10, r: 0.25, color: '#355e2b' });
      dots(b, 'flower', ['#c0233a', '#d63851', '#e05a6f'], { cy, rx: 0.5, ry: 0.5, rz: 0.5, n: 22, r: 0.07, minY: -0.2, detail: 1 });
    },
  },
  {
    id: 'lavender', name: 'Lavender', latin: 'Lavandula angustifolia', emoji: '💜', category: 'Flowers',
    height: 0.6, spread: 0.7, mature: 3, start: 0.4, sun: 'Full sun', type: 'Evergreen sub-shrub',
    winter: 'keep', bloom: ['summer'], bloomText: 'Jun–Aug',
    build(b) {
      const { rng } = b;
      b.add('foliage', '#8aa283', xf(blob(rng, 0.3), 0, 0.12, 0, 0, 0, 0, 1, 0.55, 1));
      for (let i = 0; i < 45; i++) {
        const a = rng() * Math.PI * 2;
        const t = 0.1 + rng() * 0.5;
        const L = 0.3 + rng() * 0.18;
        const from = V(Math.cos(a) * rng() * 0.15, 0.12, Math.sin(a) * rng() * 0.15);
        const to = from.clone().add(V(Math.sin(t) * Math.cos(a), Math.cos(t), Math.sin(t) * Math.sin(a)).multiplyScalar(L));
        b.add('flower', '#8aa283', limb(from, to, 0.008, 0.006, 3));
        b.add('flower', pick(rng, ['#7b5ea7', '#8e6fbf', '#6f53a0']), orient(xf(blob(rng, 0.025, { detail: 0 }), 0, 0.05, 0, 0, 0, 0, 1, 3, 1), to, to.clone().add(to.clone().sub(from))));
      }
    },
  },
  {
    id: 'sunflower', name: 'Sunflower', latin: 'Helianthus annuus', emoji: '🌻', category: 'Flowers',
    height: 2, spread: 0.5, mature: 0.5, start: 0.15, sun: 'Full sun', type: 'Annual',
    winter: 'bare', dormant: ['winter'], bloom: ['summer'], bloomText: 'Jul–Sep',
    build(b) {
      const { rng } = b;
      mulch(b, 0.18);
      b.add('foliage', '#4f7f2f', limb(V(0, 0, 0), V(0.04, 1.85, 0.02), 0.025, 0.018));
      for (let i = 0; i < 6; i++) {
        const y = 0.3 + i * 0.25;
        const a = i * 2.4 + rng();
        b.add('foliage', '#4f8a2f', xf(blob(rng, 0.13, { detail: 0 }).translate(0, 0, 0.13), 0, y, 0, -0.35, a, 0, 1, 0.25, 1));
      }
      const head = V(0.05, 1.88, 0.08);
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2;
        b.add('flower', '#f5c518', xf(blob(rng, 0.05, { detail: 0 }), head.x + Math.cos(a) * 0.13, head.y + Math.sin(a) * 0.13, head.z, 0, 0, a + Math.PI / 2, 0.6, 1.6, 0.3));
      }
      b.add('flower', '#5b3a1e', xf(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 12), head.x, head.y, head.z + 0.01, Math.PI / 2, 0, 0));
    },
  },
  {
    id: 'tulip', name: 'Tulips (clump)', latin: 'Tulipa', emoji: '🌷', category: 'Flowers',
    height: 0.45, spread: 0.3, mature: 0.5, start: 0.7, sun: 'Full sun', type: 'Spring bulb',
    winter: 'bare', dormant: ['summer', 'autumn', 'winter'], bloom: ['spring'], bloomText: 'Apr–May',
    build(b) {
      const { rng } = b;
      mulch(b, 0.16);
      for (let i = 0; i < 7; i++) {
        const a = rng() * Math.PI * 2;
        const d = Math.sqrt(rng()) * 0.12;
        const x = Math.cos(a) * d, z = Math.sin(a) * d;
        const h = 0.3 + rng() * 0.12;
        const top = V(x + (rng() - 0.5) * 0.06, h, z + (rng() - 0.5) * 0.06);
        b.add('foliage', '#5b8c3a', limb(V(x, 0, z), top, 0.006, 0.005, 3));
        for (let k = 0; k < 2; k++) {
          b.add('foliage', '#6f9a4a', xf(blob(rng, 0.08, { detail: 0 }), x, 0.08, z, -0.25, rng() * 6, 0, 0.3, 1.4, 0.12));
        }
        b.add('flower', pick(rng, ['#e63946', '#f4a261', '#ffd166', '#c9184a', '#f8f1e7']), xf(cyl(0.035, 0.022, 0.07, 6), top.x, top.y, top.z));
      }
    },
  },
  {
    id: 'grass', name: 'Ornamental grass', latin: 'Miscanthus sinensis', emoji: '🌾', category: 'Foliage',
    height: 1.6, spread: 1, mature: 3, start: 0.3, sun: 'Full sun', type: 'Perennial grass, stands through winter',
    autumn: '#c7a46b', winter: 'autumn', bloom: ['autumn', 'winter'], bloomText: 'Plumes Sep–Feb',
    build(b) {
      const { rng } = b;
      for (let i = 0; i < 70; i++) {
        const a = rng() * Math.PI * 2;
        const t = 0.05 + rng() * 0.4;
        const L = 1.0 + rng() * 0.5;
        const from = V(Math.cos(a) * rng() * 0.15, 0, Math.sin(a) * rng() * 0.15);
        const to = from.clone().add(V(Math.sin(t) * Math.cos(a), Math.cos(t), Math.sin(t) * Math.sin(a)).multiplyScalar(L));
        b.add('foliage', '#8daa5a', orient(cone(0.018, L, 3), from, to));
        if (i % 5 === 0) b.add('flower', '#e8dcc0', orient(xf(blob(rng, 0.04, { detail: 0 }), 0, 0.05, 0, 0, 0, 0, 1, 3.5, 1), to, to.clone().add(to.clone().sub(from))));
      }
    },
  },
  {
    id: 'fern', name: 'Male fern', latin: 'Dryopteris filix-mas', emoji: '🌿', category: 'Foliage',
    height: 0.9, spread: 1, mature: 3, start: 0.35, sun: 'Part shade / shade', type: 'Perennial fern',
    autumn: '#a3863f', winter: 'bare', dormant: ['winter'], bloom: [], bloomText: '—',
    build(b) {
      const { rng } = b;
      mulch(b, 0.3);
      for (let i = 0; i < 12; i++) {
        const frond = blob(rng, 0.5, { detail: 1, jitter: 0.08 }).translate(0, 0, 0.5);
        b.add('foliage', pick(rng, ['#4e8a3a', '#5a9a44']), xf(frond, 0, 0.05, 0, -(0.55 + rng() * 0.5), (i / 12) * Math.PI * 2 + rng() * 0.3, 0, 0.13, 0.04, 1));
      }
    },
  },
  {
    id: 'hosta', name: 'Hosta', latin: 'Hosta', emoji: '🍃', category: 'Foliage',
    height: 0.5, spread: 0.8, mature: 4, start: 0.4, sun: 'Part shade / shade', type: 'Perennial',
    autumn: '#c9b458', winter: 'bare', dormant: ['winter'], bloom: ['summer'], bloomText: 'Jul–Aug',
    build(b) {
      const { rng } = b;
      mulch(b, 0.3);
      for (let i = 0; i < 14; i++) {
        const leaf = blob(rng, 0.2, { detail: 1, jitter: 0.06 }).translate(0, 0, 0.2);
        b.add('foliage', pick(rng, ['#5e8f73', '#7fae8a']), xf(leaf, 0, 0.06, 0, -(0.25 + rng() * 0.6), rng() * Math.PI * 2, 0, 0.6, 0.08, 1));
      }
      for (let i = 0; i < 4; i++) {
        const a = rng() * Math.PI * 2;
        const top = V(Math.cos(a) * 0.12, 0.6 + rng() * 0.1, Math.sin(a) * 0.12);
        b.add('flower', '#5e8f73', limb(V(0, 0, 0), top, 0.008, 0.006, 3));
        for (let k = 0; k < 5; k++) b.add('flower', '#c9b8e8', xf(blob(rng, 0.03, { detail: 0 }), top.x, top.y - k * 0.04, top.z));
      }
    },
  },
  {
    id: 'bamboo', name: 'Bamboo (clump)', latin: 'Fargesia', emoji: '🎋', category: 'Foliage',
    height: 3.8, spread: 1.5, mature: 6, start: 0.3, sun: 'Sun / part shade', type: 'Evergreen clump-forming',
    winter: 'keep', bloom: [], bloomText: '—',
    build(b) {
      const { rng } = b;
      for (let i = 0; i < 14; i++) {
        const a = rng() * Math.PI * 2;
        const d = Math.sqrt(rng()) * 0.35;
        const base = V(Math.cos(a) * d, 0, Math.sin(a) * d);
        const h = 3 + rng() * 1;
        const top = base.clone().add(V(Math.cos(a) * 0.35, h, Math.sin(a) * 0.35));
        b.add('trunk', pick(rng, ['#7a9a3a', '#8aa848']), limb(base, top, 0.025, 0.018, 5));
        for (let k = 0; k < 3; k++) {
          const p = base.clone().lerp(top, 0.55 + k * 0.2);
          b.add('foliage', '#5c8c3c', xf(blob(rng, 0.32), p.x + Math.cos(a) * 0.15, p.y, p.z + Math.sin(a) * 0.15, 0, 0, 0, 1, 0.55, 1));
        }
      }
    },
  },
  {
    id: 'vegbed', name: 'Raised veg bed', latin: '2 m × 1 m, salad crops', emoji: '🥬', category: 'Edible',
    height: 0.4, spread: 2.2, mature: 0.3, start: 1, noGrow: true, sun: 'Full sun', type: 'Raised bed',
    winter: 'keep', dormant: ['winter'], bloom: [], bloomText: 'Harvest May–Oct',
    build(b) {
      const { rng } = b;
      const wood = '#8a6a46';
      b.add('trunk', wood, xf(box(2, 0.3, 0.05), 0, 0, 0.475));
      b.add('trunk', wood, xf(box(2, 0.3, 0.05), 0, 0, -0.475));
      b.add('trunk', wood, xf(box(0.05, 0.3, 0.9), 0.975, 0, 0));
      b.add('trunk', wood, xf(box(0.05, 0.3, 0.9), -0.975, 0, 0));
      b.add('mulch', '#3b2b1f', box(1.9, 0.27, 0.9));
      const colors = ['#8cc152', '#6aa84f', '#a33b5c'];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 6; c++) {
          b.add('foliage', colors[r], xf(blob(rng, 0.11), -0.78 + c * 0.31, 0.3, -0.28 + r * 0.28, 0, rng() * 6, 0, 1, 0.65, 1));
        }
      }
    },
  },
];

export const PLANT_BY_ID = Object.fromEntries(PLANTS.map((p) => [p.id, p]));

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

export function growthScale(def, years) {
  if (def.noGrow) return 1;
  const t = Math.min(1, years / def.mature);
  const eased = 1 - Math.pow(1 - t, 1.6);
  return def.start + (1 - def.start) * eased;
}

const noRaycast = () => {};

function groundRing(inner, outer, color, opacity) {
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(inner, outer, 64).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false })
  );
  ring.position.y = 0.03;
  ring.renderOrder = 10;
  ring.raycast = noRaycast;
  return ring;
}

// Structure: root (user position / rotation / size) > growth (scaled by age) > meshes.
export function createPlant(defId, seed) {
  const def = PLANT_BY_ID[defId];
  const b = new Builder(seed);
  def.build(b);
  const model = b.build();

  const root = new THREE.Group();
  const growth = new THREE.Group();
  growth.add(model);
  root.add(growth);

  const r = def.spread / 2;
  const spreadRing = groundRing(r * 0.97, r, '#ffe082', 0.55);
  spreadRing.visible = false;
  root.add(spreadRing);

  const selectRing = groundRing(0.9, 1, '#7bc67e', 0.95);
  selectRing.visible = false;
  root.add(selectRing);

  root.userData = { def, growth, spreadRing, selectRing };
  return root;
}

export function setPlantAge(root, years) {
  const { def, growth, selectRing } = root.userData;
  const s = growthScale(def, years);
  growth.scale.setScalar(s);
  selectRing.scale.setScalar(Math.max(0.25, (def.spread / 2) * s) * 1.1);
}

const SPRING_TINT = new THREE.Color('#b6e07a');

export function applySeason(root, season) {
  const { def } = root.userData;
  const dormant = def.dormant?.includes(season) ?? false;
  const deciduous = def.winter === 'bare' || def.winter === 'autumn';
  const autumn = def.autumn ? new THREE.Color(def.autumn) : null;

  root.userData.growth.traverse((m) => {
    if (!m.isMesh) return;
    const { role, baseColor } = m.userData;
    if (role === 'foliage') {
      let visible = !dormant;
      const color = baseColor.clone();
      if (season === 'spring' && deciduous) color.lerp(SPRING_TINT, 0.3);
      if (season === 'autumn' && autumn) color.copy(autumn);
      if (season === 'winter') {
        if (def.winter === 'bare') visible = false;
        else if (def.winter === 'autumn' && autumn) color.copy(autumn).multiplyScalar(0.85);
      }
      m.visible = visible;
      m.material.color.copy(color);
    } else if (role === 'flower') {
      m.visible = !dormant && def.bloom.includes(season);
    } else if (role === 'fruit') {
      m.visible = !dormant && (def.fruit?.includes(season) ?? false);
    }
  });
}

export function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
  });
}
