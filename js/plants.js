// Procedural low-poly plant library.
// Every plant is built at its mature size (metres) from simple jittered shapes,
// merged into one mesh per role/colour so a garden of dozens of plants stays fast.
// Roles drive the seasonal behaviour: foliage changes colour or disappears,
// flowers and fruit only show in their season, trunks and mulch always stay.
// Each face gets a slight colour variation so canopies and bark read as textured, not flat.

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

// Deterministic per-position noise, so duplicated vertices (cylinder seams, caps) move together.
const hash3 = (x, y, z) => {
  const n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return n - Math.floor(n);
};

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

// Base-at-origin, +Y geometry moved to `pos` and turned to face along `normal`.
function placeAt(geo, pos, normal) {
  _q.setFromUnitVectors(UP, normal.clone().normalize());
  _m.compose(pos, _q, _s.set(1, 1, 1));
  return geo.applyMatrix4(_m);
}

function limb(from, to, r0, r1, seg = 5) {
  return orient(cyl(r1, r0, from.distanceTo(to), seg), from, to);
}

// Tapered, slightly crooked stem with rough bark. Used for trunks and big branches.
function barkGeo(from, to, r0, r1, { seg = 8, rings = 5, crook = 0.05, rough = 0.12, seed = 0 } = {}) {
  const len = from.distanceTo(to);
  const g = new THREE.CylinderGeometry(r1, r0, len, seg, rings);
  const p = g.attributes.position;
  const kx = Math.sin(seed * 12.9) * crook * len;
  const kz = Math.cos(seed * 7.3) * crook * len;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const t = y / len + 0.5;
    const bend = Math.sin(t * Math.PI);
    const n = 1 + (hash3(x * 9 + seed, Math.round(y * 50) / 50, z * 9) - 0.5) * rough;
    p.setXYZ(i, x * n + kx * bend, y, z * n + kz * bend);
  }
  g.translate(0, len / 2, 0);
  return orient(g, from, to);
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
const randomDir = (rng) => V(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize();

// How much each part's colour varies between pieces and faces.
const VARY = { foliage: 0.14, flower: 0.07, fruit: 0.08, trunk: 0.1, mulch: 0.12 };

class Builder {
  constructor(seed) {
    this.rng = rngFrom(seed);
    this.parts = new Map();
  }

  add(role, color, geo, vary = VARY[role] ?? 0.1) {
    const key = `${role}|${color}`;
    if (!this.parts.has(key)) this.parts.set(key, { role, color, geos: [] });
    const g = geo.index ? geo.toNonIndexed() : geo;
    for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
    const { rng } = this;
    const count = g.attributes.position.count;
    const col = new Float32Array(count * 3);
    const base = 1 + (rng() * 2 - 1) * vary;
    const warm = (rng() * 2 - 1) * vary * 0.5;
    for (let f = 0; f < count; f += 3) {
      const k = base * (1 + (rng() * 2 - 1) * 0.06);
      for (let v = 0; v < 3; v++) col.set([k * (1 + warm), k, k * (1 - warm)], (f + v) * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts.get(key).geos.push(g);
  }

  build() {
    const group = new THREE.Group();
    for (const { role, color, geos } of this.parts.values()) {
      const geo = mergeGeometries(geos);
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color, vertexColors: true, flatShading: true, roughness: 0.85, metalness: 0 });
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

// ---------------------------------------------------------------------------
// Plant parts
// ---------------------------------------------------------------------------

// Main trunk with a root flare. Returns nothing; add branches separately.
function trunk(b, color, height, r0, r1, { crook = 0.04 } = {}) {
  const seed = b.rng() * 100;
  b.add('trunk', color, barkGeo(V(0, 0, 0), V(0, height, 0), r0, r1, { crook, seed }));
  b.add('trunk', color, new THREE.CylinderGeometry(r0 * 0.95, r0 * 1.6, height * 0.08, 8, 1).translate(0, height * 0.04, 0));
}

// A branch with a couple of side twigs near its tip.
function branch(b, color, from, to, r0, r1, twigs = 2) {
  const { rng } = b;
  b.add('trunk', color, barkGeo(from, to, r0, r1, { seg: 6, rings: 3, crook: 0.08, seed: rng() * 100 }));
  const len = from.distanceTo(to);
  const dir = to.clone().sub(from).normalize();
  for (let i = 0; i < twigs; i++) {
    const p = from.clone().lerp(to, 0.55 + rng() * 0.4);
    const d = dir.clone().add(randomDir(rng).multiplyScalar(0.9)).normalize();
    b.add('trunk', color, limb(p, p.clone().addScaledVector(d, len * (0.25 + rng() * 0.2)), r1 * 0.9, r1 * 0.35, 4));
  }
}

// A cloud of leafy blobs inside an ellipsoid centred at height cy, with smaller tufts on the
// outside so the silhouette is leafy rather than lumpy.
function canopy(b, { cy, rx, ry, rz, n, r, color, squash = 1, tufts = 1.4, x = 0, z = 0 }) {
  const { rng } = b;
  const detail = r >= 0.45 ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const p = inEllipsoid(rng, rx * 0.7, ry * 0.7, rz * 0.7);
    const s = 0.75 + rng() * 0.5;
    b.add('foliage', color, xf(blob(rng, r * s, { detail, jitter: 0.2 }), x + p.x, cy + p.y, z + p.z, 0, rng() * 6, 0, 1, squash, 1));
  }
  const shell = [rx * 0.7 + r * 0.7, (ry * 0.7 + r * 0.7) * squash, rz * 0.7 + r * 0.7];
  for (let i = 0; i < Math.round(n * tufts); i++) {
    const p = onEllipsoid(rng, ...shell, -0.6);
    b.add('foliage', color, xf(blob(rng, r * (0.25 + rng() * 0.2), { detail: 1, jitter: 0.3 }), x + p.x, cy + p.y, z + p.z), 0.22);
  }
}

// Small blobs scattered over the outside of a canopy (blossom, berries).
function dots(b, role, colors, { cy, rx, ry, rz, n, r, minY = -0.4, detail = 0, x = 0, z = 0, stretch = 1 }) {
  const { rng } = b;
  for (let i = 0; i < n; i++) {
    const p = onEllipsoid(rng, rx, ry, rz, minY);
    b.add(role, pick(rng, colors), xf(blob(rng, r * (0.8 + rng() * 0.4), { detail }), x + p.x, cy + p.y, z + p.z, 0, 0, 0, 1, stretch, 1));
  }
}

// An open flower facing `normal`: a ring of petals around a centre.
function flower(b, petalColor, centreColor, pos, normal, r, petals = 5) {
  const { rng } = b;
  const turn = rng() * Math.PI;
  for (let k = 0; k < petals; k++) {
    const a = turn + (k / petals) * Math.PI * 2;
    const petal = xf(blob(rng, r * 0.5, { detail: 0, jitter: 0.1 }), Math.cos(a) * r * 0.55, 0, Math.sin(a) * r * 0.55, 0.25, -a, 0, 1, 0.25, 0.6);
    b.add('flower', petalColor, placeAt(petal, pos, normal));
  }
  b.add('flower', centreColor, placeAt(xf(blob(rng, r * 0.28, { detail: 0 }), 0, r * 0.05, 0), pos, normal));
}

// A curved, tapering blade (grass, flax, cabbage-tree leaves). Gravity bends it outwards.
function blade(b, role, color, from, dir, length, width, { droop = 0.35, segs = 3, flat = 0.25 } = {}) {
  let p = from.clone();
  const d = dir.clone().normalize();
  for (let i = 0; i < segs; i++) {
    const t0 = i / segs, t1 = (i + 1) / segs;
    d.y -= droop / segs;
    d.normalize();
    const next = p.clone().addScaledVector(d, length / segs);
    const w0 = width * (1 - t0 * 0.85), w1 = width * (1 - t1 * 0.85);
    const seg = new THREE.CylinderGeometry(w1, w0, length / segs, 4, 1).translate(0, length / segs / 2, 0);
    seg.scale(1, 1, flat);
    b.add(role, color, orient(seg, p, next));
    p = next;
  }
  return p;
}

// Irregular mulch ring around the base of smaller plants.
function mulch(b, r) {
  const g = new THREE.CylinderGeometry(r, r * 1.08, 0.03, 16, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    if (Math.hypot(x, z) < 1e-6) continue;
    const n = 1 + (hash3(Math.round(x * 1000), 0, Math.round(z * 1000)) - 0.5) * 0.25;
    p.setX(i, x * n);
    p.setZ(i, z * n);
  }
  b.add('mulch', '#4a3a2b', g.translate(0, 0.015, 0));
}

// Long fern or palm frond: a curving midrib with leaflets down both sides.
function frond(b, color, from, dir, length, { leaflets = 14, leafLen = 0.35, droop = 0.6, under = null } = {}) {
  const { rng } = b;
  const d = dir.clone().normalize();
  const side = new THREE.Vector3().crossVectors(d, UP).normalize();
  if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
  let p = from.clone();
  const steps = leaflets;
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    d.y -= droop / steps;
    d.normalize();
    const next = p.clone().addScaledVector(d, length / steps);
    b.add('foliage', color, limb(p, next, 0.012, 0.008, 3));
    const ll = leafLen * Math.sin(Math.PI * (0.15 + t * 0.85)) * (0.8 + rng() * 0.3);
    for (const s of [-1, 1]) {
      const out = side.clone().multiplyScalar(s).addScaledVector(d, 0.35).addScaledVector(UP, -0.15).normalize();
      const leaf = new THREE.CylinderGeometry(0.004, 0.035, ll, 3, 1).translate(0, ll / 2, 0).scale(1, 1, 0.3);
      b.add('foliage', color, orient(leaf, next, next.clone().addScaledVector(out, ll)));
      if (under) {
        const leafU = new THREE.CylinderGeometry(0.003, 0.03, ll * 0.95, 3, 1).translate(0, ll * 0.95 / 2, 0).scale(1, 1, 0.3);
        b.add('foliage', under, orient(leafU, next.clone().add(V(0, -0.01, 0)), next.clone().addScaledVector(out, ll * 0.95).add(V(0, -0.012, 0))), 0.05);
      }
    }
    p = next;
  }
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------
// height / spread: mature size in metres. mature: years to reach it.
// start: fraction of mature size when planted. winter: 'bare' | 'autumn' | 'keep'.
// dormant: seasons when the plant dies back to the ground. Seasons follow the hemisphere
// set by the latitude, so a pōhutukawa flowers in December in New Zealand.

export const CATEGORIES = ['NZ natives', 'Trees', 'Shrubs', 'Flowers', 'Foliage', 'Edible'];

const NZ = 'NZ natives';

export const PLANTS = [
  // ----- New Zealand natives -------------------------------------------------
  {
    id: 'pohutukawa', name: 'Pōhutukawa', latin: 'Metrosideros excelsa', emoji: '🌺', category: NZ,
    height: 8, spread: 9, mature: 30, start: 0.12, sun: 'Full sun', type: 'NZ native evergreen tree, the NZ Christmas tree',
    winter: 'keep', bloom: ['summer'], bloomText: 'Dec–Jan (crimson)',
    build(b) {
      const { rng } = b;
      const bark = '#6a5a4c';
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + rng() * 0.5;
        const top = V(Math.cos(a) * 1.8, 3.2 + rng() * 0.6, Math.sin(a) * 1.8);
        b.add('trunk', bark, barkGeo(V(Math.cos(a) * 0.15, 0, Math.sin(a) * 0.15), top, 0.26, 0.14, { crook: 0.12, seed: rng() * 99 }));
        branch(b, bark, top, V(Math.cos(a) * 3.2, 4.4 + rng() * 0.5, Math.sin(a) * 3.2), 0.13, 0.06, 3);
      }
      b.add('trunk', bark, new THREE.CylinderGeometry(0.35, 0.6, 0.4, 9, 1).translate(0, 0.2, 0));
      const cy = 5;
      canopy(b, { cy, rx: 4.2, ry: 1.9, rz: 4.2, n: 20, r: 1.3, color: '#40613a' });
      const shell = { cy, rx: 4.2 * 0.7 + 1.0, ry: 1.9 * 0.7 + 1.0, rz: 4.2 * 0.7 + 1.0 };
      dots(b, 'flower', ['#c8102e', '#d7263d', '#b00d24'], { ...shell, n: 190, r: 0.14, minY: -0.1, detail: 1 });
    },
  },
  {
    id: 'kowhai', name: 'Kōwhai', latin: 'Sophora microphylla', emoji: '🌼', category: NZ,
    height: 7, spread: 5, mature: 20, start: 0.15, sun: 'Full sun', type: 'NZ native tree, tūī and bellbird favourite',
    winter: 'keep', bloom: ['spring'], bloomText: 'Sep–Oct (golden yellow)',
    build(b) {
      const { rng } = b;
      const bark = '#6b5d4d';
      trunk(b, bark, 3.4, 0.17, 0.09, { crook: 0.1 });
      const cy = 5;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + rng();
        branch(b, bark, V(0, 2.4 + rng() * 0.8, 0), V(Math.cos(a) * 1.9, cy - 0.4 + rng(), Math.sin(a) * 1.9), 0.08, 0.035, 3);
      }
      canopy(b, { cy, rx: 2.4, ry: 1.9, rz: 2.4, n: 26, r: 0.55, color: '#7d9a4a', tufts: 1.8 });
      const shell = { cy: cy - 0.2, rx: 2.4 * 0.7 + 0.45, ry: 1.9 * 0.7 + 0.45, rz: 2.4 * 0.7 + 0.45 };
      dots(b, 'flower', ['#f2c12e', '#e8b21f', '#f6cf4a'], { ...shell, n: 160, r: 0.06, minY: -0.8, detail: 0, stretch: 2.2 });
    },
  },
  {
    id: 'cabbage', name: 'Tī kōuka (cabbage tree)', latin: 'Cordyline australis', emoji: '🌴', category: NZ,
    height: 6, spread: 3.5, mature: 15, start: 0.2, sun: 'Full sun', type: 'NZ native evergreen tree',
    winter: 'keep', bloom: ['spring'], bloomText: 'Nov–Dec (scented cream sprays)',
    build(b) {
      const { rng } = b;
      const bark = '#7a6a58';
      trunk(b, bark, 3, 0.2, 0.15, { crook: 0.05 });
      const heads = [];
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2 + rng();
        const top = V(Math.cos(a) * 0.9, 4.6 + rng() * 0.6, Math.sin(a) * 0.9);
        b.add('trunk', bark, barkGeo(V(0, 2.9, 0), top, 0.13, 0.09, { seg: 6, rings: 3, crook: 0.1, seed: rng() * 99 }));
        heads.push(top);
      }
      for (const h of heads) {
        for (let k = 0; k < 46; k++) {
          const d = randomDir(rng);
          d.y = Math.abs(d.y) * 0.9 + 0.15 - (k < 10 ? 0.9 : 0);
          blade(b, 'foliage', pick(rng, ['#6f8a35', '#7d9440']), h, d, 0.8 + rng() * 0.25, 0.025, { droop: 0.25, segs: 2, flat: 0.3 });
        }
        for (let k = 0; k < 14; k++) {
          const d = randomDir(rng);
          d.y = -1.2;
          b.add('trunk', '#a08a62', orient(cone(0.02, 0.6, 3), h.clone().add(V(0, -0.1, 0)), h.clone().addScaledVector(d.normalize(), 0.6)));
        }
        for (let k = 0; k < 2; k++) {
          const stem = h.clone().add(V((rng() - 0.5) * 0.3, 0.2, (rng() - 0.5) * 0.3));
          const top = stem.clone().add(V((rng() - 0.5) * 0.4, 0.9, (rng() - 0.5) * 0.4));
          b.add('flower', '#d9cfa8', limb(stem, top, 0.02, 0.01, 3));
          dots(b, 'flower', ['#f3ecd2', '#ece3c4'], { cy: top.y - 0.25, x: top.x, z: top.z, rx: 0.3, ry: 0.4, rz: 0.3, n: 26, r: 0.05 });
        }
      }
    },
  },
  {
    id: 'nikau', name: 'Nīkau palm', latin: 'Rhopalostylis sapida', emoji: '🌴', category: NZ,
    height: 6, spread: 4, mature: 25, start: 0.2, sun: 'Part shade', type: "NZ native palm, the world's southernmost",
    winter: 'keep', bloom: ['summer'], bloomText: 'Dec–Feb (lilac sprays)',
    build(b) {
      const { rng } = b;
      const h = 4.2;
      b.add('trunk', '#7d8a72', barkGeo(V(0, 0, 0), V(0, h, 0), 0.17, 0.14, { crook: 0.02, rough: 0.02, seed: 3 }));
      for (let i = 0; i < 18; i++) {
        const y = 0.2 + i * (h / 18);
        b.add('trunk', '#5f6b55', new THREE.TorusGeometry(0.165 - y * 0.007, 0.012, 4, 12).rotateX(Math.PI / 2).translate(0, y, 0));
      }
      b.add('trunk', '#8fa37e', blob(rng, 0.24, { detail: 1, jitter: 0.04 }).scale(1, 2.6, 1).translate(0, h + 0.5, 0), 0.05);
      const crown = V(0, h + 1.05, 0);
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 + rng() * 0.3;
        const d = V(Math.cos(a), 0.9 + rng() * 0.4, Math.sin(a));
        frond(b, pick(rng, ['#3f7a3a', '#467f3d']), crown, d, 1.9 + rng() * 0.4, { leaflets: 16, leafLen: 0.55, droop: 1.3 });
      }
      for (let k = 0; k < 3; k++) {
        const a = rng() * Math.PI * 2;
        dots(b, 'flower', ['#c9a3c9', '#b98fbd'], { cy: h - 0.05, x: Math.cos(a) * 0.3, z: Math.sin(a) * 0.3, rx: 0.15, ry: 0.25, rz: 0.15, n: 30, r: 0.03 });
      }
    },
  },
  {
    id: 'ponga', name: 'Ponga (silver fern)', latin: 'Cyathea dealbata', emoji: '🌿', category: NZ,
    height: 4.5, spread: 5, mature: 20, start: 0.25, sun: 'Part shade / shade', type: 'NZ native tree fern',
    winter: 'keep', bloom: [], bloomText: '—',
    build(b) {
      const { rng } = b;
      const h = 3;
      b.add('trunk', '#4a3a2c', barkGeo(V(0, 0, 0), V(0, h, 0), 0.22, 0.16, { seg: 12, rings: 8, crook: 0.05, rough: 0.14, seed: rng() * 99 }));
      for (let i = 0; i < 40; i++) {
        const y = 0.3 + rng() * (h - 0.4);
        const a = rng() * Math.PI * 2;
        const r = 0.22 - (y / h) * 0.06;
        b.add('trunk', '#5a4636', xf(blob(rng, 0.045, { detail: 0, jitter: 0.2 }), Math.cos(a) * r, y, Math.sin(a) * r, 0, 0, 0, 1, 1.6, 1));
      }
      const crown = V(0, h, 0);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2 + rng() * 0.3;
        frond(b, '#3d6e3a', crown, V(Math.cos(a), 1.1 + rng() * 0.4, Math.sin(a)), 2.3 + rng() * 0.4, { leaflets: 16, leafLen: 0.5, droop: 1.6, under: '#cfd8d2' });
      }
      for (let i = 0; i < 3; i++) {
        const a = rng() * Math.PI * 2;
        const koru = V(Math.cos(a) * 0.12, h + 0.25, Math.sin(a) * 0.12);
        b.add('foliage', '#9fb07a', xf(new THREE.TorusGeometry(0.07, 0.025, 5, 10, Math.PI * 1.6), koru.x, koru.y, koru.z, 0, a, 0));
      }
    },
  },
  {
    id: 'harakeke', name: 'Harakeke (NZ flax)', latin: 'Phormium tenax', emoji: '🌱', category: NZ,
    height: 2, spread: 2.2, mature: 4, start: 0.3, sun: 'Full sun', type: 'NZ native, weaving flax',
    winter: 'keep', bloom: ['summer'], bloomText: 'Nov–Jan (dark red, loved by tūī)',
    build(b) {
      const { rng } = b;
      mulch(b, 0.6);
      for (let fan = 0; fan < 7; fan++) {
        const a = (fan / 7) * Math.PI * 2 + rng() * 0.4;
        const base = V(Math.cos(a) * 0.18, 0.02, Math.sin(a) * 0.18);
        for (let k = 0; k < 5; k++) {
          const lean = 0.15 + k * 0.12 + rng() * 0.1;
          const d = V(Math.cos(a + (k - 2) * 0.08) * lean, 1, Math.sin(a + (k - 2) * 0.08) * lean);
          blade(b, 'foliage', pick(rng, ['#4f6b3a', '#5a7440', '#475f34']), base, d, 1.5 + rng() * 0.6, 0.05, { droop: 0.25 + lean * 0.4, segs: 4, flat: 0.15 });
        }
      }
      for (let k = 0; k < 3; k++) {
        const a = rng() * Math.PI * 2;
        const base = V(Math.cos(a) * 0.15, 0, Math.sin(a) * 0.15);
        const top = V(Math.cos(a) * 0.35, 2.6 + rng() * 0.4, Math.sin(a) * 0.35);
        b.add('flower', '#3d2b1f', limb(base, top, 0.025, 0.012, 4));
        for (let j = 0; j < 7; j++) {
          const p = base.clone().lerp(top, 0.55 + j * 0.06);
          const out = randomDir(rng); out.y = 0.6;
          const tip = p.clone().addScaledVector(out.normalize(), 0.18);
          b.add('flower', '#3d2b1f', limb(p, tip, 0.008, 0.006, 3));
          b.add('flower', '#8b1a1a', orient(xf(blob(rng, 0.025, { detail: 0 }), 0, 0.04, 0, 0, 0, 0, 1, 2.2, 1), tip, tip.clone().add(V(0, 1, 0))));
        }
      }
    },
  },
  {
    id: 'manuka', name: 'Mānuka', latin: 'Leptospermum scoparium', emoji: '🤍', category: NZ,
    height: 4, spread: 3, mature: 10, start: 0.25, sun: 'Full sun', type: 'NZ native shrub or small tree, honey plant',
    winter: 'keep', bloom: ['spring', 'summer'], bloomText: 'Oct–Jan (white or pink)',
    build(b) {
      const { rng } = b;
      const bark = '#6e5b48';
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + rng();
        const top = V(Math.cos(a) * 0.6, 2.4 + rng() * 0.5, Math.sin(a) * 0.6);
        b.add('trunk', bark, barkGeo(V(Math.cos(a) * 0.06, 0, Math.sin(a) * 0.06), top, 0.07, 0.035, { seg: 6, crook: 0.12, rough: 0.25, seed: rng() * 99 }));
        branch(b, bark, top.clone().multiplyScalar(0.8), top.clone().add(V(Math.cos(a) * 0.6, 0.6, Math.sin(a) * 0.6)), 0.035, 0.015, 2);
      }
      const cy = 2.8;
      canopy(b, { cy, rx: 1.6, ry: 1.2, rz: 1.6, n: 30, r: 0.36, color: '#56693b', tufts: 1.8 });
      const shell = { cy, rx: 1.6 * 0.7 + 0.3, ry: 1.2 * 0.7 + 0.3, rz: 1.6 * 0.7 + 0.3 };
      for (let i = 0; i < 110; i++) {
        const p = onEllipsoid(rng, shell.rx, shell.ry, shell.rz, -0.3);
        flower(b, pick(rng, ['#fbfbf5', '#f6f2ea', '#f3d9e1']), '#8a6b3a', p.clone().add(V(0, cy, 0)), p.clone().normalize(), 0.06);
      }
    },
  },
  {
    id: 'kawakawa', name: 'Kawakawa', latin: 'Piper excelsum', emoji: '💚', category: NZ,
    height: 2, spread: 2, mature: 6, start: 0.3, sun: 'Part shade / shade', type: 'NZ native shrub, rongoā (medicinal) leaves',
    winter: 'keep', bloom: [], fruit: ['summer'], bloomText: 'Orange fruit spikes in summer',
    build(b) {
      const { rng } = b;
      mulch(b, 0.6);
      const stems = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + rng();
        const top = V(Math.cos(a) * 0.6, 1.3 + rng() * 0.5, Math.sin(a) * 0.6);
        b.add('trunk', '#4c6b33', barkGeo(V(0, 0, 0), top, 0.03, 0.018, { seg: 5, rings: 4, crook: 0.1, rough: 0.05, seed: rng() * 99 }));
        stems.push(top);
      }
      for (let i = 0; i < 70; i++) {
        const p = inEllipsoid(rng, 0.95, 0.6, 0.95).add(V(0, 1.2, 0));
        const leaf = blob(rng, 0.11, { detail: 1, jitter: 0.08 }).translate(0, 0, 0.1);
        b.add('foliage', pick(rng, ['#2f5e27', '#3a6b2c', '#4a7a33']), xf(leaf, p.x, p.y, p.z, -(rng() * 0.8), rng() * Math.PI * 2, (rng() - 0.5) * 0.6, 1, 0.12, 1.1));
      }
      for (let i = 0; i < 18; i++) {
        const p = inEllipsoid(rng, 0.8, 0.5, 0.8).add(V(0, 1.25, 0));
        b.add('fruit', '#e88a1a', xf(blob(rng, 0.018, { detail: 0 }), p.x, p.y, p.z, 0, 0, 0, 1, 4, 1));
      }
    },
  },
  {
    id: 'hebe', name: 'Koromiko (hebe)', latin: 'Veronica stricta', emoji: '🪻', category: NZ,
    height: 1.4, spread: 1.4, mature: 4, start: 0.35, sun: 'Full sun', type: 'NZ native shrub, bee and butterfly magnet',
    winter: 'keep', bloom: ['summer', 'autumn'], bloomText: 'Dec–May (violet spikes)',
    build(b) {
      const { rng } = b;
      mulch(b, 0.55);
      const cy = 0.7;
      canopy(b, { cy, rx: 0.7, ry: 0.5, rz: 0.7, n: 12, r: 0.32, color: '#4a7a3a', tufts: 2 });
      for (let i = 0; i < 36; i++) {
        const p = onEllipsoid(rng, 0.75, 0.6, 0.75, -0.1);
        const pos = p.clone().add(V(0, cy, 0));
        const spike = xf(blob(rng, 0.03, { detail: 1, jitter: 0.15 }), 0, 0.06, 0, 0, 0, 0, 1, 3.4, 1);
        b.add('flower', pick(rng, ['#8a5fb5', '#9b6fc4', '#c4b5e0']), placeAt(spike, pos, p.clone().normalize().add(V(0, 0.6, 0))));
      }
    },
  },
  {
    id: 'kohuhu', name: 'Kōhūhū', latin: 'Pittosporum tenuifolium', emoji: '🌳', category: NZ,
    height: 4, spread: 2.2, mature: 10, start: 0.25, sun: 'Sun / part shade', type: 'NZ native evergreen, great for hedging and screens',
    winter: 'keep', bloom: [], bloomText: 'Tiny dark honey-scented flowers in spring',
    build(b) {
      const { rng } = b;
      trunk(b, '#2f2a26', 1.6, 0.08, 0.05, { crook: 0.06 });
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + rng();
        branch(b, '#2f2a26', V(0, 1.1 + rng() * 0.4, 0), V(Math.cos(a) * 0.6, 2.4 + rng() * 0.8, Math.sin(a) * 0.6), 0.04, 0.02, 2);
      }
      canopy(b, { cy: 2.4, rx: 1.1, ry: 1.6, rz: 1.1, n: 30, r: 0.34, color: '#8aa856', tufts: 2 });
    },
  },
  {
    id: 'toetoe', name: 'Toetoe', latin: 'Austroderia richardii', emoji: '🌾', category: NZ,
    height: 2.6, spread: 2, mature: 3, start: 0.3, sun: 'Full sun', type: 'NZ native grass with arching plumes',
    winter: 'keep', bloom: ['summer', 'autumn'], bloomText: 'Dec–Apr (creamy plumes)',
    build(b) {
      const { rng } = b;
      for (let i = 0; i < 80; i++) {
        const a = rng() * Math.PI * 2;
        const lean = 0.3 + rng() * 0.9;
        const from = V(Math.cos(a) * rng() * 0.2, 0, Math.sin(a) * rng() * 0.2);
        blade(b, 'foliage', pick(rng, ['#7f8f4e', '#8a9a5a', '#95a466']), from, V(Math.cos(a) * lean, 1, Math.sin(a) * lean), 1.1 + rng() * 0.5, 0.015, { droop: 0.6, segs: 3, flat: 0.3 });
      }
      for (let i = 0; i < 9; i++) {
        const a = rng() * Math.PI * 2;
        const base = V(Math.cos(a) * 0.1, 0, Math.sin(a) * 0.1);
        const top = V(Math.cos(a) * 0.5, 2.2 + rng() * 0.4, Math.sin(a) * 0.5);
        b.add('flower', '#b9a978', limb(base, top, 0.012, 0.007, 3));
        const plumeDir = V(Math.cos(a) * 0.6, -0.2, Math.sin(a) * 0.6);
        for (let k = 0; k < 6; k++) {
          blade(b, 'flower', pick(rng, ['#e8dcae', '#efe4bd', '#ddd0a0']), top, plumeDir.clone().add(randomDir(rng).multiplyScalar(0.25)), 0.55, 0.04, { droop: 0.5, segs: 2, flat: 0.6 });
        }
      }
    },
  },
  {
    id: 'coprosma', name: 'Taupata', latin: 'Coprosma repens', emoji: '🍊', category: NZ,
    height: 2, spread: 2, mature: 5, start: 0.3, sun: 'Full sun', type: 'NZ native coastal shrub, glossy leaves',
    winter: 'keep', bloom: [], fruit: ['autumn'], bloomText: 'Orange berries in autumn',
    build(b) {
      mulch(b, 0.7);
      const cy = 1.05;
      canopy(b, { cy, rx: 1, ry: 0.75, rz: 1, n: 16, r: 0.4, color: '#2f6b2a', tufts: 1.6 });
      dots(b, 'fruit', ['#e2582b', '#ee7a2f', '#d9481f'], { cy, rx: 1.05, ry: 0.85, rz: 1.05, n: 45, r: 0.035, minY: -0.5, detail: 1 });
    },
  },
  {
    id: 'lancewood', name: 'Horoeka (lancewood)', latin: 'Pseudopanax crassifolius', emoji: '🗡️', category: NZ,
    height: 4.5, spread: 1.2, mature: 15, start: 0.2, sun: 'Sun or shade', type: 'NZ native, striking juvenile form',
    winter: 'keep', bloom: [], bloomText: '—',
    build(b) {
      const { rng } = b;
      trunk(b, '#5a5240', 4, 0.07, 0.04, { crook: 0.03 });
      for (let i = 0; i < 46; i++) {
        const y = 2 + (i / 46) * 2.1;
        const a = i * 2.39996 + rng() * 0.3;
        const from = V(Math.cos(a) * 0.04, y, Math.sin(a) * 0.04);
        const dir = V(Math.cos(a) * 0.9, -0.9 - rng() * 0.6 + (i / 46) * 0.8, Math.sin(a) * 0.9);
        blade(b, 'foliage', pick(rng, ['#4a4a2a', '#565432', '#3f4426']), from, dir, 0.6 + (1 - i / 46) * 0.35, 0.022, { droop: 0.05, segs: 2, flat: 0.25 });
      }
    },
  },
  {
    id: 'rengarenga', name: 'Rengarenga lily', latin: 'Arthropodium cirratum', emoji: '🤍', category: NZ,
    height: 0.7, spread: 0.8, mature: 3, start: 0.4, sun: 'Part shade', type: 'NZ native perennial, ground cover under trees',
    winter: 'keep', bloom: ['spring'], bloomText: 'Nov–Dec (white starry flowers)',
    build(b) {
      const { rng } = b;
      mulch(b, 0.35);
      for (let i = 0; i < 22; i++) {
        const a = rng() * Math.PI * 2;
        const lean = 0.8 + rng() * 0.6;
        blade(b, 'foliage', pick(rng, ['#9cb37a', '#8fa86c', '#a7bd86']), V(0, 0.02, 0), V(Math.cos(a) * lean, 1, Math.sin(a) * lean), 0.45 + rng() * 0.15, 0.04, { droop: 0.8, segs: 3, flat: 0.2 });
      }
      for (let k = 0; k < 4; k++) {
        const a = rng() * Math.PI * 2;
        const top = V(Math.cos(a) * 0.25, 0.65 + rng() * 0.1, Math.sin(a) * 0.25);
        b.add('flower', '#8fa86c', limb(V(0, 0, 0), top, 0.006, 0.004, 3));
        for (let j = 0; j < 6; j++) {
          const p = top.clone().add(V((rng() - 0.5) * 0.15, -j * 0.04, (rng() - 0.5) * 0.15));
          flower(b, '#ffffff', '#c9b04a', p, randomDir(rng).add(V(0, 0.8, 0)), 0.04, 6);
        }
      }
    },
  },
  {
    id: 'puka', name: 'Kāpuka hedge (1 m)', latin: 'Griselinia littoralis', emoji: '🌿', category: NZ,
    height: 1.8, spread: 1, mature: 5, start: 0.4, sun: 'Sun / part shade', type: 'NZ native, the classic glossy hedge',
    winter: 'keep', bloom: [], bloomText: '—',
    build(b) {
      const { rng } = b;
      for (let i = 0; i < 16; i++) {
        b.add('foliage', '#7fae3f', xf(blob(rng, 0.28, { detail: 2 }), rng() * 0.84 - 0.42, 0.28 + rng() * 1.25, rng() * 0.3 - 0.15));
      }
      for (let i = 0; i < 40; i++) {
        const p = V(rng() * 1.0 - 0.5, 0.15 + rng() * 1.55, (rng() < 0.5 ? -1 : 1) * (0.25 + rng() * 0.08));
        b.add('foliage', '#86b545', xf(blob(rng, 0.09, { detail: 1, jitter: 0.25 }), p.x, p.y, p.z), 0.2);
      }
    },
  },

  // ----- Trees --------------------------------------------------------------
  {
    id: 'oak', name: 'English oak', latin: 'Quercus robur', emoji: '🌳', category: 'Trees',
    height: 10, spread: 9, mature: 40, start: 0.12, sun: 'Full sun', type: 'Deciduous tree',
    autumn: '#a8742c', winter: 'bare', bloom: [], bloomText: '—',
    build(b) {
      const { rng } = b;
      const bark = '#5b4636';
      trunk(b, bark, 5, 0.42, 0.24, { crook: 0.05 });
      const cy = 6.3;
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + rng();
        branch(b, bark, V(0, 3.4 + rng() * 1.4, 0), V(Math.cos(a) * 2.9, cy - 0.5 + rng() * 1.5, Math.sin(a) * 2.9), 0.17, 0.06, 3);
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
      trunk(b, '#e6e1d6', 9, 0.2, 0.08, { crook: 0.03 });
      for (let i = 0; i < 18; i++) {
        const y = 0.3 + rng() * 7.5;
        const r = 0.2 - 0.12 * (y / 9);
        const a = rng() * Math.PI * 2;
        b.add('trunk', '#2f2b28', xf(box(r * 1.1, 0.05, r * 0.9), Math.cos(a) * r * 0.55, y, Math.sin(a) * r * 0.55, 0, a, 0), 0.05);
      }
      const cy = 8;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + rng();
        branch(b, '#cfc8bb', V(0, 5.5 + rng() * 2, 0), V(Math.cos(a) * 1.5, cy + rng(), Math.sin(a) * 1.5), 0.06, 0.02, 3);
      }
      canopy(b, { cy, rx: 2.2, ry: 3.2, rz: 2.2, n: 22, r: 0.9, color: '#86b04f', tufts: 1.6 });
    },
  },
  {
    id: 'cherry', name: 'Flowering cherry', latin: 'Prunus serrulata', emoji: '🌸', category: 'Trees',
    height: 6, spread: 6, mature: 15, start: 0.25, sun: 'Full sun', type: 'Deciduous tree',
    autumn: '#d9542b', winter: 'bare', bloom: ['spring'], bloomText: 'Spring blossom',
    build(b) {
      const { rng } = b;
      const bark = '#4a3530';
      trunk(b, bark, 2.2, 0.21, 0.13);
      for (let i = 0; i < 4; i++) b.add('trunk', '#3a2a26', xf(new THREE.TorusGeometry(0.17, 0.01, 3, 12).rotateX(Math.PI / 2), 0, 0.4 + i * 0.4, 0), 0.05);
      const cy = 3.8;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + rng();
        branch(b, bark, V(0, 1.9, 0), V(Math.cos(a) * 2.2, cy - 0.3 + rng() * 0.6, Math.sin(a) * 2.2), 0.1, 0.04, 3);
      }
      canopy(b, { cy, rx: 2.8, ry: 1.4, rz: 2.8, n: 14, r: 1.0, color: '#5a8a3c' });
      dots(b, 'flower', ['#f7b6cf', '#f9c9da', '#f3a0c0', '#fde3ec'], { cy, rx: 2.8 * 0.7 + 0.8, ry: 1.4 * 0.7 + 0.8, rz: 2.8 * 0.7 + 0.8, n: 180, r: 0.16, minY: -0.3, detail: 1 });
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
        branch(b, bark, V(0, 0, 0), V(Math.cos(a) * 0.5, 1.6, Math.sin(a) * 0.5), 0.08, 0.04, 3);
      }
      for (let t = 0; t < 3; t++) {
        const y = 1.25 + t * 0.55;
        const ring = 1.15 - t * 0.35;
        const n = 7 - t * 2;
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + rng();
          b.add('foliage', '#a8322d', xf(blob(rng, 0.55 - t * 0.08, { detail: 2 }), Math.cos(a) * ring, y, Math.sin(a) * ring, 0, rng() * 6, 0, 1, 0.45, 1));
          for (let k = 0; k < 4; k++) {
            const o = randomDir(rng).multiplyScalar(0.45);
            b.add('foliage', '#a8322d', xf(blob(rng, 0.14, { detail: 1, jitter: 0.3 }), Math.cos(a) * ring + o.x, y + o.y * 0.4 + 0.08, Math.sin(a) * ring + o.z, 0, 0, 0, 1, 0.5, 1), 0.22);
          }
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
      trunk(b, '#5a3d2e', 0.4, 0.08, 0.05);
      for (let i = 0; i < 10; i++) {
        const y = 0.35 + i * 0.34;
        const r = 0.5 * (1 - i / 13);
        for (let k = 0; k < 3; k++) {
          const a = rng() * Math.PI * 2;
          b.add('foliage', '#2c5232', xf(blob(rng, r, { detail: 2 }), Math.cos(a) * r * 0.25, y, Math.sin(a) * r * 0.25, 0, 0, 0, 1, 1.5, 1));
        }
        for (let k = 0; k < 4; k++) {
          const a = rng() * Math.PI * 2;
          b.add('foliage', '#2c5232', xf(blob(rng, r * 0.3, { detail: 1, jitter: 0.3 }), Math.cos(a) * r * 0.85, y + (rng() - 0.5) * 0.3, Math.sin(a) * r * 0.85), 0.2);
        }
      }
    },
  },

  // ----- Shrubs -------------------------------------------------------------
  {
    id: 'box', name: 'Box ball', latin: 'Buxus sempervirens', emoji: '🟢', category: 'Shrubs',
    height: 0.65, spread: 0.65, mature: 6, start: 0.5, sun: 'Sun or shade', type: 'Evergreen shrub',
    winter: 'keep', bloom: [], bloomText: '—',
    build(b) {
      const { rng } = b;
      b.add('foliage', '#3d6b2f', xf(blob(rng, 0.31, { detail: 3, jitter: 0.05 }), 0, 0.31, 0));
      for (let i = 0; i < 30; i++) {
        const p = onEllipsoid(rng, 0.31, 0.31, 0.31, -0.5);
        b.add('foliage', '#3d6b2f', xf(blob(rng, 0.05, { detail: 1, jitter: 0.25 }), p.x, 0.31 + p.y, p.z), 0.18);
      }
    },
  },
  {
    id: 'hedge', name: 'Beech hedge (1 m)', latin: 'Fagus sylvatica', emoji: '🌿', category: 'Shrubs',
    height: 1.8, spread: 1, mature: 6, start: 0.4, sun: 'Sun / part shade', type: 'Deciduous hedge, holds brown leaves in winter',
    autumn: '#a0622d', winter: 'autumn', bloom: [], bloomText: '—',
    build(b) {
      const { rng } = b;
      for (let i = 0; i < 16; i++) {
        b.add('foliage', '#4d7a2e', xf(blob(rng, 0.28, { detail: 2 }), rng() * 0.84 - 0.42, 0.28 + rng() * 1.25, rng() * 0.3 - 0.15));
      }
      for (let i = 0; i < 36; i++) {
        const p = V(rng() * 1.0 - 0.5, 0.15 + rng() * 1.55, (rng() < 0.5 ? -1 : 1) * (0.25 + rng() * 0.08));
        b.add('foliage', '#4d7a2e', xf(blob(rng, 0.09, { detail: 1, jitter: 0.25 }), p.x, p.y, p.z), 0.2);
      }
    },
  },
  {
    id: 'hydrangea', name: 'Hydrangea', latin: 'Hydrangea macrophylla', emoji: '💠', category: 'Shrubs',
    height: 1.2, spread: 1.4, mature: 5, start: 0.35, sun: 'Part shade', type: 'Deciduous shrub',
    autumn: '#9a7b3c', winter: 'bare', bloom: ['summer'], bloomText: 'Mid to late summer',
    build(b) {
      const { rng } = b;
      const cy = 0.55;
      mulch(b, 0.55);
      canopy(b, { cy, rx: 0.65, ry: 0.4, rz: 0.65, n: 9, r: 0.35, color: '#4f7d3d' });
      for (let i = 0; i < 13; i++) {
        const p = onEllipsoid(rng, 0.7, 0.55, 0.7, -0.1).add(V(0, cy, 0));
        const colour = pick(rng, ['#7fa3e0', '#9bb5ea', '#b39ddb']);
        for (let k = 0; k < 9; k++) {
          const o = randomDir(rng).multiplyScalar(0.11);
          b.add('flower', colour, xf(blob(rng, 0.055, { detail: 0, jitter: 0.15 }), p.x + o.x, p.y + Math.abs(o.y), p.z + o.z));
        }
      }
    },
  },

  // ----- Flowers ------------------------------------------------------------
  {
    id: 'rose', name: 'Shrub rose', latin: 'Rosa', emoji: '🌹', category: 'Flowers',
    height: 1.2, spread: 1, mature: 4, start: 0.4, sun: 'Full sun', type: 'Deciduous shrub',
    autumn: '#8a6d2f', winter: 'bare', bloom: ['summer'], bloomText: 'All summer',
    build(b) {
      const { rng } = b;
      mulch(b, 0.4);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + rng();
        b.add('trunk', '#4d6b2e', barkGeo(V(0, 0, 0), V(Math.cos(a) * 0.4, 0.9 + rng() * 0.3, Math.sin(a) * 0.4), 0.02, 0.012, { seg: 4, rings: 3, crook: 0.15, rough: 0.05, seed: rng() * 99 }));
      }
      const cy = 0.65;
      canopy(b, { cy, rx: 0.42, ry: 0.4, rz: 0.42, n: 10, r: 0.25, color: '#355e2b', tufts: 1.8 });
      for (let i = 0; i < 20; i++) {
        const p = onEllipsoid(rng, 0.6, 0.58, 0.6, -0.2);
        const colour = pick(rng, ['#c0233a', '#d63851', '#e05a6f']);
        flower(b, colour, '#8e1a2b', p.clone().add(V(0, cy, 0)), p.clone().normalize(), 0.09, 7);
      }
    },
  },
  {
    id: 'lavender', name: 'Lavender', latin: 'Lavandula angustifolia', emoji: '💜', category: 'Flowers',
    height: 0.6, spread: 0.7, mature: 3, start: 0.4, sun: 'Full sun', type: 'Evergreen sub-shrub',
    winter: 'keep', bloom: ['summer'], bloomText: 'Summer',
    build(b) {
      const { rng } = b;
      b.add('foliage', '#8aa283', xf(blob(rng, 0.3, { detail: 2 }), 0, 0.12, 0, 0, 0, 0, 1, 0.55, 1));
      for (let i = 0; i < 60; i++) {
        const a = rng() * Math.PI * 2;
        const t = 0.1 + rng() * 0.5;
        const L = 0.3 + rng() * 0.18;
        const from = V(Math.cos(a) * rng() * 0.15, 0.12, Math.sin(a) * rng() * 0.15);
        const to = from.clone().add(V(Math.sin(t) * Math.cos(a), Math.cos(t), Math.sin(t) * Math.sin(a)).multiplyScalar(L));
        b.add('flower', '#8aa283', limb(from, to, 0.008, 0.006, 3));
        const dir = to.clone().sub(from).normalize();
        for (let k = 0; k < 4; k++) {
          const p = to.clone().addScaledVector(dir, k * 0.022);
          b.add('flower', pick(rng, ['#7b5ea7', '#8e6fbf', '#6f53a0']), xf(blob(rng, 0.016, { detail: 0 }), p.x, p.y, p.z));
        }
      }
    },
  },
  {
    id: 'sunflower', name: 'Sunflower', latin: 'Helianthus annuus', emoji: '🌻', category: 'Flowers',
    height: 2, spread: 0.5, mature: 0.5, start: 0.15, sun: 'Full sun', type: 'Annual',
    winter: 'bare', dormant: ['winter'], bloom: ['summer'], bloomText: 'Late summer',
    build(b) {
      const { rng } = b;
      mulch(b, 0.18);
      b.add('foliage', '#4f7f2f', barkGeo(V(0, 0, 0), V(0.04, 1.85, 0.02), 0.025, 0.018, { seg: 6, rings: 4, crook: 0.03, rough: 0.05, seed: 5 }));
      for (let i = 0; i < 7; i++) {
        const y = 0.3 + i * 0.22;
        const a = i * 2.4 + rng();
        b.add('foliage', '#4f8a2f', xf(blob(rng, 0.14, { detail: 1, jitter: 0.08 }).translate(0, 0, 0.14), 0, y, 0, -0.35, a, 0, 1, 0.12, 1));
      }
      const head = V(0.05, 1.88, 0.08);
      for (const [n, r, len] of [[22, 0.14, 1.6], [16, 0.12, 1.2]]) {
        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + (r < 0.13 ? 0.15 : 0);
          b.add('flower', '#f5c518', xf(blob(rng, 0.05, { detail: 0 }), head.x + Math.cos(a) * r, head.y + Math.sin(a) * r, head.z - (r < 0.13 ? 0.01 : 0), 0, 0, a + Math.PI / 2, 0.6, len, 0.25));
        }
      }
      b.add('flower', '#5b3a1e', xf(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 16), head.x, head.y, head.z + 0.01, Math.PI / 2, 0, 0));
      b.add('flower', '#3e2614', xf(blob(rng, 0.085, { detail: 1, jitter: 0.06 }), head.x, head.y, head.z + 0.03, 0, 0, 0, 1, 1, 0.3));
    },
  },
  {
    id: 'tulip', name: 'Tulips (clump)', latin: 'Tulipa', emoji: '🌷', category: 'Flowers',
    height: 0.45, spread: 0.3, mature: 0.5, start: 0.7, sun: 'Full sun', type: 'Spring bulb',
    winter: 'bare', dormant: ['summer', 'autumn', 'winter'], bloom: ['spring'], bloomText: 'Spring',
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
          const la = rng() * Math.PI * 2;
          blade(b, 'foliage', '#6f9a4a', V(x, 0.01, z), V(Math.cos(la) * 0.4, 1, Math.sin(la) * 0.4), 0.22, 0.03, { droop: 0.5, segs: 2, flat: 0.25 });
        }
        const colour = pick(rng, ['#e63946', '#f4a261', '#ffd166', '#c9184a', '#f8f1e7']);
        for (let k = 0; k < 6; k++) {
          const pa = (k / 6) * Math.PI * 2;
          const r = k % 2 ? 0.022 : 0.026;
          b.add('flower', colour, xf(blob(rng, 0.03, { detail: 0, jitter: 0.08 }), top.x + Math.cos(pa) * r, top.y + 0.035, top.z + Math.sin(pa) * r, 0.18, -pa + Math.PI / 2, 0, 0.55, 1.4, 0.25));
        }
      }
    },
  },

  // ----- Foliage ------------------------------------------------------------
  {
    id: 'grass', name: 'Ornamental grass', latin: 'Miscanthus sinensis', emoji: '🌾', category: 'Foliage',
    height: 1.6, spread: 1, mature: 3, start: 0.3, sun: 'Full sun', type: 'Perennial grass, stands through winter',
    autumn: '#c7a46b', winter: 'autumn', bloom: ['autumn', 'winter'], bloomText: 'Plumes autumn to late winter',
    build(b) {
      const { rng } = b;
      for (let i = 0; i < 80; i++) {
        const a = rng() * Math.PI * 2;
        const lean = 0.05 + rng() * 0.45;
        const from = V(Math.cos(a) * rng() * 0.15, 0, Math.sin(a) * rng() * 0.15);
        const tip = blade(b, 'foliage', '#8daa5a', from, V(Math.cos(a) * lean, 1, Math.sin(a) * lean), 1.0 + rng() * 0.5, 0.014, { droop: 0.3, segs: 3, flat: 0.35 });
        if (i % 5 === 0) b.add('flower', '#e8dcc0', orient(xf(blob(rng, 0.04, { detail: 0 }), 0, 0.05, 0, 0, 0, 0, 1, 3.5, 1), tip, tip.clone().add(V(0, 1, 0))));
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
        const a = (i / 12) * Math.PI * 2 + rng() * 0.3;
        frond(b, pick(rng, ['#4e8a3a', '#5a9a44']), V(0, 0.03, 0), V(Math.cos(a) * 0.45, 1, Math.sin(a) * 0.45), 1.05, { leaflets: 10, leafLen: 0.16, droop: 0.7 });
      }
    },
  },
  {
    id: 'hosta', name: 'Hosta', latin: 'Hosta', emoji: '🍃', category: 'Foliage',
    height: 0.5, spread: 0.8, mature: 4, start: 0.4, sun: 'Part shade / shade', type: 'Perennial',
    autumn: '#c9b458', winter: 'bare', dormant: ['winter'], bloom: ['summer'], bloomText: 'Midsummer',
    build(b) {
      const { rng } = b;
      mulch(b, 0.3);
      for (let i = 0; i < 16; i++) {
        const leaf = blob(rng, 0.2, { detail: 2, jitter: 0.05 }).translate(0, 0, 0.2);
        b.add('foliage', pick(rng, ['#5e8f73', '#7fae8a']), xf(leaf, 0, 0.06, 0, -(0.25 + rng() * 0.6), rng() * Math.PI * 2, 0, 0.6, 0.08, 1));
      }
      for (let i = 0; i < 4; i++) {
        const a = rng() * Math.PI * 2;
        const top = V(Math.cos(a) * 0.12, 0.6 + rng() * 0.1, Math.sin(a) * 0.12);
        b.add('flower', '#5e8f73', limb(V(0, 0, 0), top, 0.008, 0.006, 3));
        for (let k = 0; k < 6; k++) {
          const p = top.clone().add(V(Math.cos(k * 2.4) * 0.025, -k * 0.035, Math.sin(k * 2.4) * 0.025));
          b.add('flower', '#c9b8e8', orient(xf(blob(rng, 0.02, { detail: 0 }), 0, 0.03, 0, 0, 0, 0, 1, 2, 1), p, p.clone().add(V(0, -0.3, 0)).add(randomDir(rng).multiplyScalar(0.3))));
        }
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
        const colour = pick(rng, ['#7a9a3a', '#8aa848']);
        b.add('trunk', colour, limb(base, top, 0.025, 0.018, 6));
        for (let k = 1; k < 8; k++) {
          const p = base.clone().lerp(top, k / 8);
          b.add('trunk', '#6a8a30', xf(new THREE.TorusGeometry(0.023, 0.005, 3, 8).rotateX(Math.PI / 2), p.x, p.y, p.z), 0.04);
        }
        for (let k = 0; k < 4; k++) {
          const p = base.clone().lerp(top, 0.5 + k * 0.15);
          for (let j = 0; j < 4; j++) {
            const la = rng() * Math.PI * 2;
            blade(b, 'foliage', '#5c8c3c', p, V(Math.cos(la), 0.3, Math.sin(la)), 0.25, 0.02, { droop: 0.5, segs: 2, flat: 0.2 });
          }
        }
      }
    },
  },

  // ----- Edible -------------------------------------------------------------
  {
    id: 'apple', name: 'Apple tree', latin: 'Malus domestica', emoji: '🍎', category: 'Edible',
    height: 4.2, spread: 4, mature: 10, start: 0.3, sun: 'Full sun', type: 'Deciduous fruit tree',
    autumn: '#c99a3a', winter: 'bare', bloom: ['spring'], fruit: ['autumn'], bloomText: 'Spring blossom, fruit in autumn',
    build(b) {
      const { rng } = b;
      const bark = '#6b4f3a';
      trunk(b, bark, 1.6, 0.15, 0.09, { crook: 0.08 });
      const cy = 2.7;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + rng();
        branch(b, bark, V(0, 1.3, 0), V(Math.cos(a) * 1.3, cy - 0.2 + rng() * 0.6, Math.sin(a) * 1.3), 0.07, 0.03, 3);
      }
      canopy(b, { cy, rx: 1.9, ry: 1.1, rz: 1.9, n: 12, r: 0.75, color: '#5f8c3a' });
      const shell = { cy, rx: 1.9 * 0.7 + 0.6, ry: 1.1 * 0.7 + 0.6, rz: 1.9 * 0.7 + 0.6 };
      for (let i = 0; i < 60; i++) {
        const p = onEllipsoid(rng, shell.rx, shell.ry, shell.rz, -0.2);
        flower(b, pick(rng, ['#fbe3ec', '#ffffff', '#f6cbd9']), '#e8d27a', p.clone().add(V(0, cy, 0)), p.clone().normalize(), 0.1);
      }
      dots(b, 'fruit', ['#c0392b', '#d35400', '#a93226'], { ...shell, n: 30, r: 0.07, minY: -0.6, detail: 1 });
    },
  },
  {
    id: 'vegbed', name: 'Raised veg bed', latin: '2 m × 1 m, salad crops', emoji: '🥬', category: 'Edible',
    height: 0.4, spread: 2.2, mature: 0.3, start: 1, noGrow: true, sun: 'Full sun', type: 'Raised bed',
    winter: 'keep', dormant: ['winter'], bloom: [], bloomText: 'Harvest spring to autumn',
    build(b) {
      const { rng } = b;
      const wood = '#8a6a46';
      for (const [dy, h] of [[0, 0.14], [0.15, 0.14]]) {
        b.add('trunk', wood, xf(box(2, h, 0.05), 0, dy, 0.475));
        b.add('trunk', wood, xf(box(2, h, 0.05), 0, dy, -0.475));
        b.add('trunk', wood, xf(box(0.05, h, 0.9), 0.975, dy, 0));
        b.add('trunk', wood, xf(box(0.05, h, 0.9), -0.975, dy, 0));
      }
      for (const [x, z] of [[-0.975, -0.475], [0.975, -0.475], [-0.975, 0.475], [0.975, 0.475]]) b.add('trunk', '#6f5236', xf(box(0.07, 0.32, 0.07), x, 0, z));
      b.add('mulch', '#3b2b1f', box(1.9, 0.27, 0.9));
      const colors = ['#8cc152', '#6aa84f', '#a33b5c'];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 6; c++) {
          const x = -0.78 + c * 0.31, z = -0.28 + r * 0.28;
          for (let k = 0; k < 7; k++) {
            const a = (k / 7) * Math.PI * 2 + rng();
            b.add('foliage', colors[r], xf(blob(rng, 0.07, { detail: 1, jitter: 0.15 }).translate(0, 0, 0.05), x, 0.3, z, -(0.4 + rng() * 0.4), a, 0, 1, 0.35, 1.2));
          }
          b.add('foliage', colors[r], xf(blob(rng, 0.05, { detail: 1 }), x, 0.31, z));
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
