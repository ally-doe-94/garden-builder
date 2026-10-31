// Landscaping features: paths, paved areas, garden beds, retaining walls, fences and steps.
// Each feature is a small record (tool, material, the points you clicked, width/height) and its
// 3D shape is rebuilt from that record, following the ground of the scan or demo garden.
// Surfaces are textured with procedurally drawn patterns at real-world scale.

import * as THREE from 'three';
import { rngFrom } from './plants.js';

// ---------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------

const TEX_SIZE = 512;
const texCache = new Map();
const matCache = new Map();

const hashString = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

function vary(hex, rng, amount = 0.06) {
  return `#${new THREE.Color(hex).offsetHSL((rng() - 0.5) * amount * 0.3, (rng() - 0.5) * amount, (rng() - 0.5) * amount * 1.6).getHexString()}`;
}

function texture(key, draw) {
  if (texCache.has(key)) return texCache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TEX_SIZE;
  const g = canvas.getContext('2d');
  draw(g, TEX_SIZE, rngFrom(hashString(key)));
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  texCache.set(key, tex);
  return tex;
}

// Draw at (x, y) and at the wrapped positions, so patterns tile seamlessly.
function wrapped(S, x, y, r, fn) {
  for (const dx of [0, -S, S]) {
    if (dx && (x + dx < -r || x + dx > S + r)) continue;
    for (const dy of [0, -S, S]) {
      if (dy && (y + dy < -r || y + dy > S + r)) continue;
      fn(x + dx, y + dy);
    }
  }
}

function speckle(g, S, rng, colors, n, rMin, rMax, alpha = 1) {
  g.globalAlpha = alpha;
  for (let i = 0; i < n; i++) {
    const x = rng() * S, y = rng() * S, r = rMin + rng() * (rMax - rMin);
    g.fillStyle = colors[Math.floor(rng() * colors.length)];
    wrapped(S, x, y, r, (px, py) => { g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.fill(); });
  }
  g.globalAlpha = 1;
}

// Rows of rectangular units with mortar joints (pavers, bricks, blocks, boards).
function bond(g, S, rng, { cols, rows, colors, mortar, joint = 3, stagger = 0.5, randomStagger = false, grain = null, vary: v = 0.06 }) {
  g.fillStyle = mortar;
  g.fillRect(0, 0, S, S);
  const w = S / cols, h = S / rows;
  for (let r = 0; r < rows; r++) {
    const off = randomStagger ? rng() * w : (r % 2) * stagger * w;
    for (let c = -1; c <= cols; c++) {
      const x = c * w + off;
      g.fillStyle = vary(colors[Math.floor(rng() * colors.length)], rng, v);
      g.fillRect(x + joint / 2, r * h + joint / 2, w - joint, h - joint);
      if (grain) {
        g.strokeStyle = grain;
        g.globalAlpha = 0.25;
        g.lineWidth = 1;
        for (let k = 0; k < 4; k++) {
          const gy = r * h + joint + rng() * (h - joint * 2);
          g.beginPath();
          g.moveTo(x + joint, gy);
          g.bezierCurveTo(x + w * 0.3, gy + (rng() - 0.5) * 6, x + w * 0.7, gy + (rng() - 0.5) * 6, x + w - joint, gy);
          g.stroke();
        }
        g.globalAlpha = 1;
      }
    }
  }
}

// Irregular stones separated by mortar, tileable (flagstone, stone walls, gabion fill).
function stones(g, S, rng, { cells, colors, mortar, joint = 5, stretchY = 1, shade = 0.12 }) {
  const pts = Array.from({ length: cells }, () => ({ x: rng() * S, y: rng() * S, c: new THREE.Color(vary(colors[Math.floor(rng() * colors.length)], rng, 0.1)) }));
  const img = g.createImageData(S, S);
  const m = new THREE.Color(mortar);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let d1 = Infinity, d2 = Infinity, best = null;
      for (const p of pts) {
        let dx = Math.abs(x - p.x), dy = Math.abs(y - p.y);
        if (dx > S / 2) dx = S - dx;
        if (dy > S / 2) dy = S - dy;
        const d = Math.sqrt(dx * dx + dy * dy * stretchY * stretchY);
        if (d < d1) { d2 = d1; d1 = d; best = p; } else if (d < d2) d2 = d;
      }
      const i = (y * S + x) * 4;
      const edge = d2 - d1;
      if (edge < joint) {
        img.data[i] = m.r * 255; img.data[i + 1] = m.g * 255; img.data[i + 2] = m.b * 255;
      } else {
        const k = 1 - shade + shade * Math.min(1, edge / (joint * 6)) + (((x * 7 + y * 13) % 11) / 11 - 0.5) * 0.06;
        img.data[i] = Math.min(255, best.c.r * 255 * k);
        img.data[i + 1] = Math.min(255, best.c.g * 255 * k);
        img.data[i + 2] = Math.min(255, best.c.b * 255 * k);
      }
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

const DRAW = {
  pavers: (g, S, rng) => { bond(g, S, rng, { cols: 3, rows: 3, stagger: 0, colors: ['#b9b3a7', '#aea89b', '#c3bdb1'], mortar: '#cbbf9f', joint: 4 }); speckle(g, S, rng, ['#00000022', '#ffffff22'], 4000, 0.5, 1.4); },
  brick: (g, S, rng) => { bond(g, S, rng, { cols: 5, rows: 10, colors: ['#9b4a32', '#a85a3c', '#8a3f2b', '#b0603f'], mortar: '#c9bfa8', joint: 3, vary: 0.1 }); speckle(g, S, rng, ['#00000022'], 3000, 0.5, 1.2); },
  flagstone: (g, S, rng) => stones(g, S, rng, { cells: 26, colors: ['#9a9183', '#8a8478', '#a89c8a', '#7f786d', '#b0a594'], mortar: '#6f685e', joint: 5 }),
  concrete: (g, S, rng) => {
    g.fillStyle = '#bdb7ab'; g.fillRect(0, 0, S, S);
    speckle(g, S, rng, ['#8f897e', '#d6d0c4', '#a39b8c', '#6f6a62', '#c9b99a'], 16000, 0.8, 2.6);
    g.strokeStyle = '#7a756c'; g.lineWidth = 3; g.strokeRect(0, 0, S, S);
  },
  decking: (g, S, rng) => bond(g, S, rng, { cols: 1, rows: 16, randomStagger: true, colors: ['#7f4e33', '#86553a', '#7a4a30', '#8b5a3c'], mortar: '#24190f', joint: 4, grain: '#3a2516', vary: 0.04 }),
  gravel: (g, S, rng) => { g.fillStyle = '#a89f8c'; g.fillRect(0, 0, S, S); speckle(g, S, rng, ['#00000033'], 6000, 2, 4); speckle(g, S, rng, ['#c9c0ad', '#8f8676', '#b5ab98', '#7d7466', '#d8d0c0', '#9a9080'], 9000, 1.5, 3.6); },
  scoria: (g, S, rng) => { g.fillStyle = '#4a221c'; g.fillRect(0, 0, S, S); speckle(g, S, rng, ['#00000044'], 5000, 2, 5); speckle(g, S, rng, ['#7a3b2e', '#5a2a22', '#8a4a3a', '#3a1a14', '#6b3226'], 8000, 2, 4.5); },
  bark: (g, S, rng) => {
    g.fillStyle = '#3a271b'; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 2800; i++) {
      const x = rng() * S, y = rng() * S, w = 5 + rng() * 12, h = 2 + rng() * 4, a = rng() * Math.PI;
      g.fillStyle = vary(['#5a3a26', '#6b4a33', '#4a3020', '#7a5538'][Math.floor(rng() * 4)], rng, 0.1);
      wrapped(S, x, y, w, (px, py) => { g.save(); g.translate(px, py); g.rotate(a); g.fillRect(-w / 2, -h / 2, w, h); g.restore(); });
    }
  },
  lawn: (g, S, rng) => {
    g.fillStyle = '#5c8c3c'; g.fillRect(0, 0, S, S);
    g.lineWidth = 1.2;
    for (let i = 0; i < 22000; i++) {
      const x = rng() * S, y = rng() * S, l = 3 + rng() * 5, a = -Math.PI / 2 + (rng() - 0.5) * 0.8;
      g.strokeStyle = ['#4f7f33', '#6a9a48', '#5a8a3c', '#77a752', '#46722d'][Math.floor(rng() * 5)];
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
  },
  soil: (g, S, rng) => { g.fillStyle = '#3e2c20'; g.fillRect(0, 0, S, S); speckle(g, S, rng, ['#2e2018', '#4f3a2a', '#5a4433', '#33251b'], 7000, 1, 3.5); DRAW.bark(g, S, rng); g.globalAlpha = 0.35; g.fillStyle = '#3e2c20'; g.fillRect(0, 0, S, S); g.globalAlpha = 1; },
  sleeper: (g, S, rng) => bond(g, S, rng, { cols: 1, rows: 6, randomStagger: true, colors: ['#7a6a4f', '#857456', '#6e5f47', '#8c7b5b'], mortar: '#2f281f', joint: 4, grain: '#3f3424', vary: 0.07 }),
  block: (g, S, rng) => { bond(g, S, rng, { cols: 4, rows: 8, colors: ['#b8b4ab', '#aaa59c', '#c2bdb3', '#a19c93'], mortar: '#8f8a80', joint: 4 }); speckle(g, S, rng, ['#00000025', '#ffffff20'], 6000, 0.6, 1.5); },
  stone: (g, S, rng) => stones(g, S, rng, { cells: 34, colors: ['#8a8070', '#9d927f', '#6f675b', '#a49884', '#7d7466'], mortar: '#3e3a33', joint: 6, stretchY: 2.4, shade: 0.25 }),
  gabion: (g, S, rng) => {
    stones(g, S, rng, { cells: 140, colors: ['#9a9890', '#86847c', '#a8a49a', '#77756e', '#b3afa5'], mortar: '#2c2b28', joint: 4, shade: 0.35 });
    g.strokeStyle = '#c9cbc8'; g.lineWidth = 2; g.globalAlpha = 0.8;
    for (let i = 0; i <= 10; i++) {
      const p = (i / 10) * S;
      g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.stroke();
      g.beginPath(); g.moveTo(0, p); g.lineTo(S, p); g.stroke();
    }
    g.globalAlpha = 1;
  },
  brickwall: (g, S, rng) => { bond(g, S, rng, { cols: 4, rows: 12, colors: ['#9b4a32', '#a85a3c', '#8a3f2b', '#b0603f', '#7f3a28'], mortar: '#cfc6b8', joint: 4, vary: 0.1 }); speckle(g, S, rng, ['#00000022'], 3000, 0.5, 1.2); },
  corten: (g, S, rng) => {
    g.fillStyle = '#8a4a24'; g.fillRect(0, 0, S, S);
    speckle(g, S, rng, ['#6b3418', '#a35a2c', '#7a3c1c', '#b8683a', '#5a2c14'], 700, 6, 40, 0.18);
    speckle(g, S, rng, ['#4a2410', '#c47a44'], 9000, 0.6, 1.6, 0.5);
  },
  paling: (g, S, rng) => bond(g, S, rng, { cols: 8, rows: 1, stagger: 0, colors: ['#a68a64', '#9a7f5a', '#b09470', '#917650'], mortar: '#3a3026', joint: 6, vary: 0.07 }),
};

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------
// tile: metres covered by one texture repeat. level: hard surfaces are laid flat; soft ones follow the ground.

export const SURFACES = {
  gravel: { name: 'Pea gravel', tile: 1, edging: '#5c4a3a', qty: (a) => `${(a * 0.05).toFixed(2)} m³ at 50 mm deep` },
  scoria: { name: 'Red scoria', tile: 1, edging: '#5c4a3a', qty: (a) => `${(a * 0.06).toFixed(2)} m³ at 60 mm deep` },
  bark: { name: 'Bark mulch', tile: 1, edging: '#5c4a3a', qty: (a) => `${(a * 0.075).toFixed(2)} m³ at 75 mm deep` },
  pavers: { name: 'Concrete pavers (400 mm)', tile: 1.2, level: true, qty: (a) => `${Math.ceil(a * 6.25 * 1.05)} pavers (incl. 5% spare)` },
  brick: { name: 'Clay brick pavers', tile: 1, level: true, qty: (a) => `${Math.ceil(a * 50 * 1.05)} bricks (incl. 5% spare)` },
  flagstone: { name: 'Flagstone / crazy paving', tile: 2, level: true, qty: (a) => `${(a * 1.1).toFixed(1)} m² of stone (incl. 10% offcuts)` },
  concrete: { name: 'Exposed aggregate concrete', tile: 2.4, level: true, qty: (a) => `${(a * 0.1).toFixed(2)} m³ of concrete at 100 mm` },
  decking: { name: 'Timber decking', tile: 2.4, level: true, raise: 0.2, fascia: 'decking', qty: (a) => `${Math.ceil((a / 0.15) * 1.1)} m of 140 mm boards` },
  lawn: { name: 'Lawn / turf', tile: 1.5, qty: (a) => `${Math.ceil(a * 1.05)} m² of turf` },
  soil: { name: 'Garden bed (soil & mulch)', tile: 1, edging: '#6b5a45', qty: (a) => `${(a * 0.2).toFixed(2)} m³ of garden mix at 200 mm` },
  stepping: { name: 'Stepping stones', tile: 2, texture: 'flagstone', pathOnly: true },
};

export const WALLS = {
  sleeper: { name: 'H4 timber sleepers', t: 0.2, tile: 1.2, posts: 1.2, postColor: '#6e5f47', qty: (len, h) => `${Math.ceil(len / 2.4) * Math.ceil(h / 0.2)} sleepers (2.4 m × 200 mm) + ${Math.ceil(len / 1.2) + 1} posts` },
  block: { name: 'Concrete masonry block', t: 0.2, tile: 1.6, qty: (len, h) => `${Math.ceil(len * h * 12.5 * 1.05)} blocks (400 × 200 mm)` },
  stone: { name: 'Dry-stacked stone', t: 0.45, tile: 1.4, qty: (len, h) => `${(len * h * 0.45).toFixed(1)} m³ of stone` },
  gabion: { name: 'Gabion baskets', t: 0.5, tile: 1, qty: (len, h) => `${Math.ceil(len) * Math.ceil(h / 0.5)} baskets (1 m × 0.5 m)` },
  brickwall: { name: 'Brick', t: 0.23, tile: 0.96, qty: (len, h) => `${Math.ceil(len * h * 60 * 1.05)} bricks` },
  corten: { name: 'Corten steel', t: 0.012, tile: 1.5, qty: (len) => { const n = Math.ceil(len / 2.4); return `${n} sheet${n === 1 ? '' : 's'} (2.4 m)`; } },
  paling: { name: 'Timber paling fence', t: 0.04, tile: 1.2, posts: 2.4, postColor: '#7a6346', centered: true, buried: 0.05, qty: (len, h) => `${Math.ceil(len / 0.15)} palings, ${Math.ceil(len / 2.4) + 1} posts, ${Math.ceil(len / 2.4) * 2} rails` },
};

export const STEP_STYLES = {
  timber: { name: 'Timber', tread: 'decking', riser: 'sleeper' },
  concrete: { name: 'Concrete', tread: 'concrete', riser: 'concrete' },
  stone: { name: 'Stone', tread: 'flagstone', riser: 'stone' },
  brick: { name: 'Brick', tread: 'brick', riser: 'brickwall' },
  sleepergravel: { name: 'Sleeper & gravel', tread: 'gravel', riser: 'sleeper' },
};

export const TOOLS = [
  {
    id: 'path', type: 'path', name: 'Path', emoji: '🛤️',
    materials: ['gravel', 'scoria', 'bark', 'pavers', 'brick', 'flagstone', 'concrete', 'decking', 'stepping'],
    defaults: { material: 'gravel', width: 1, height: 0, curved: true },
    hint: 'Click along the route of the path',
  },
  {
    id: 'area', type: 'area', name: 'Paving & patio', emoji: '⬛',
    materials: ['pavers', 'brick', 'flagstone', 'concrete', 'decking', 'gravel', 'scoria'],
    defaults: { material: 'pavers', width: 0, height: 0, curved: false },
    hint: 'Click each corner of the area',
  },
  {
    id: 'bed', type: 'area', name: 'Garden bed / lawn', emoji: '🌱',
    materials: ['soil', 'bark', 'lawn', 'gravel', 'scoria'],
    defaults: { material: 'soil', width: 0, height: 0, curved: true },
    hint: 'Click around the edge of the bed',
  },
  {
    id: 'wall', type: 'wall', name: 'Retaining wall', emoji: '🧱',
    materials: ['sleeper', 'block', 'stone', 'gabion', 'brickwall', 'corten'],
    defaults: { material: 'sleeper', width: 0, height: 0.6, curved: false },
    hint: 'Click along the line of the wall',
  },
  {
    id: 'fence', type: 'wall', name: 'Fence', emoji: '🚧',
    materials: ['paling'],
    defaults: { material: 'paling', width: 0, height: 1.8, curved: false },
    hint: 'Click along the line of the fence',
  },
  {
    id: 'steps', type: 'steps', name: 'Steps', emoji: '🪜',
    materials: Object.keys(STEP_STYLES),
    defaults: { material: 'timber', width: 1, height: 0, curved: false },
    hint: 'Click the bottom of the steps, then the top',
  },
];
export const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t]));

export function materialName(key) {
  return SURFACES[key]?.name ?? WALLS[key]?.name ?? STEP_STYLES[key]?.name ?? key;
}

// Representative colour for UI swatches.
export const SWATCH = {
  gravel: '#b5ab98', scoria: '#7a3b2e', bark: '#5a3a26', pavers: '#b9b3a7', brick: '#a0503a', flagstone: '#9a9183',
  concrete: '#bdb7ab', decking: '#8a5a3a', lawn: '#5f8f3f', soil: '#3e2c20', stepping: '#8a8478',
  sleeper: '#7a6a4f', block: '#b0aba2', stone: '#8a8070', gabion: '#9a9890', brickwall: '#9b4a32', corten: '#8a4a24',
  paling: '#a68a64', timber: '#8a5a3a', sleepergravel: '#9a8f78',
};

function material(key) {
  if (matCache.has(key)) return matCache.get(key);
  const def = SURFACES[key] ?? WALLS[key];
  let mat;
  if (def || DRAW[key]) {
    const map = texture(def?.texture ?? key, DRAW[def?.texture ?? key]);
    mat = new THREE.MeshStandardMaterial({ map, roughness: key === 'corten' ? 0.75 : 0.92, metalness: 0, side: THREE.DoubleSide });
  } else {
    mat = new THREE.MeshStandardMaterial({ color: key, roughness: 0.9, side: THREE.DoubleSide });
  }
  // Pull flat surfaces slightly towards the camera so they never flicker against the ground.
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -1;
  mat.polygonOffsetUnits = -2;
  matCache.set(key, mat);
  return mat;
}

const tileOf = (key) => (SURFACES[key] ?? WALLS[key])?.tile ?? 1;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

class Geo {
  constructor() { this.pos = []; this.uv = []; this.idx = []; }
  v(x, y, z, u, w) { this.pos.push(x, y, z); this.uv.push(u, w); return this.pos.length / 3 - 1; }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  tri(a, b, c) { this.idx.push(a, b, c); }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    return g;
  }
}

function mesh(geometry, matKey, { cast = true } = {}) {
  const m = new THREE.Mesh(geometry, Array.isArray(matKey) ? matKey.map(material) : material(matKey));
  m.castShadow = cast;
  m.receiveShadow = true;
  return m;
}

// Box UVs at real-world scale (so textures aren't stretched on long or tall boxes).
function projectUV(geo, tile) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (ay >= ax && ay >= az) uv.setXY(i, x / tile, z / tile);
    else if (ax >= az) uv.setXY(i, z / tile, y / tile);
    else uv.setXY(i, x / tile, y / tile);
  }
  return geo;
}

const toVec = (p) => new THREE.Vector3(p[0], p[1], p[2]);

// Points along a polyline (optionally a smooth curve), every `step` metres, with distances.
export function sampleLine(points, step, curved, closed = false) {
  const pts = points.map(toVec);
  if (closed) pts.push(pts[0].clone());
  let out;
  if (curved && pts.length >= 3) {
    const curve = new THREE.CatmullRomCurve3(closed ? pts.slice(0, -1) : pts, closed, 'centripetal');
    const len = curve.getLength();
    out = curve.getSpacedPoints(Math.max(2, Math.ceil(len / step)));
  } else {
    out = [pts[0].clone()];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
      for (let k = 1; k <= n; k++) out.push(a.clone().lerp(b, k / n));
    }
  }
  let d = 0;
  return out.map((p, i) => {
    if (i) d += Math.hypot(p.x - out[i - 1].x, p.z - out[i - 1].z);
    return { p, d };
  });
}

// Horizontal normals along a sampled line, with mitred corners so widths stay true.
function sideNormals(samples, closed = false) {
  const n = samples.length;
  const segN = [];
  for (let i = 0; i < n - 1; i++) {
    const a = samples[i].p, b = samples[i + 1].p;
    const t = new THREE.Vector3(b.x - a.x, 0, b.z - a.z);
    if (t.lengthSq() < 1e-10) t.set(1, 0, 0);
    t.normalize();
    segN.push(new THREE.Vector3(-t.z, 0, t.x));
  }
  return samples.map((_, i) => {
    const before = segN[i - 1] ?? (closed ? segN[segN.length - 1] : null);
    const after = segN[i] ?? (closed ? segN[0] : null);
    if (!before) return { n: after.clone(), k: 1 };
    if (!after) return { n: before.clone(), k: 1 };
    const m = before.clone().add(after);
    if (m.lengthSq() < 1e-8) return { n: after.clone(), k: 1 };
    m.normalize();
    return { n: m, k: 1 / Math.max(0.35, m.dot(after)) };
  });
}

// A strip along the line: flat across its width, following the ground lengthwise, with skirts
// down the sides so it never looks like it floats on bumpy ground.
function ribbon(samples, { half, offset = 0, lift, depth, tile, closed = false }) {
  const g = new Geo();
  const norms = sideNormals(samples, closed);
  const top = [], L = [], R = [];
  samples.forEach(({ p, d }, i) => {
    const { n, k } = norms[i];
    const cx = p.x + n.x * offset * k, cz = p.z + n.z * offset * k;
    const y = p.y + lift;
    const l = [cx + n.x * half * k, cz + n.z * half * k];
    const r = [cx - n.x * half * k, cz - n.z * half * k];
    top.push([g.v(l[0], y, l[1], d / tile, (offset + half) / tile), g.v(r[0], y, r[1], d / tile, (offset - half) / tile)]);
    L.push([g.v(l[0], y, l[1], d / tile, 0), g.v(l[0], y - depth, l[1], d / tile, -depth / tile)]);
    R.push([g.v(r[0], y, r[1], d / tile, 0), g.v(r[0], y - depth, r[1], d / tile, -depth / tile)]);
  });
  for (let i = 0; i < samples.length - 1; i++) {
    g.quad(top[i][0], top[i + 1][0], top[i + 1][1], top[i][1]);
    g.quad(L[i][0], L[i][1], L[i + 1][1], L[i + 1][0]);
    g.quad(R[i][0], R[i + 1][0], R[i + 1][1], R[i][1]);
  }
  if (!closed && depth > 0) {
    for (const i of [0, samples.length - 1]) g.quad(L[i][0], R[i][0], R[i][1], L[i][1]);
  }
  return g.geometry();
}

function groundSamples(samples, heightNear) {
  for (const s of samples) s.p.y = heightNear(s.p.x, s.p.z, s.p.y);
  return samples;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function buildPath(rec, heightNear) {
  const group = new THREE.Group();
  const half = rec.width / 2;
  const samples = groundSamples(sampleLine(rec.points, 0.35, rec.curved), heightNear);
  if (rec.material === 'stepping') {
    const rng = rngFrom(hashString(rec.id));
    const total = samples[samples.length - 1].d;
    const r = Math.min(0.32, rec.width * 0.32);
    const sides = sideNormals(samples);
    for (let d = r; d <= total; d += r * 2 + 0.18) {
      const i = Math.max(0, samples.findIndex((s) => s.d >= d));
      const s = samples[i];
      const side = sides[i].n;
      const off = (rng() - 0.5) * rec.width * 0.25;
      const geo = new THREE.CylinderGeometry(r, r, 0.05, 10);
      const pos = geo.attributes.position;
      for (let k = 0; k < pos.count; k++) {
        const x = pos.getX(k), z = pos.getZ(k);
        const f = 1 + (Math.sin(Math.atan2(z, x) * 3 + rng() * 6) * 0.08) + (rng() - 0.5) * 0.04;
        pos.setXYZ(k, x * f * (1 + rng() * 0.15), pos.getY(k), z * f);
      }
      geo.computeVertexNormals();
      geo.rotateY(rng() * Math.PI * 2);
      geo.translate(s.p.x + side.x * off, heightNear(s.p.x, s.p.z, s.p.y) + 0.02, s.p.z + side.z * off);
      projectUV(geo, 2);
      group.add(mesh(geo, 'stepping', { cast: false }));
    }
    return group;
  }
  const surf = SURFACES[rec.material];
  const raise = surf.raise ?? 0;
  const lift = 0.04 + raise;
  group.add(mesh(ribbon(samples, { half, lift, depth: 0.12 + raise, tile: surf.tile }), rec.material, { cast: raise > 0 }));
  if (surf.edging) {
    for (const side of [-1, 1]) {
      group.add(mesh(ribbon(samples, { half: 0.025, offset: side * (half + 0.025), lift: lift + 0.035, depth: 0.15, tile: 1 }), surf.edging));
    }
  }
  return group;
}

function triangulateArea(points) {
  const outline = sampleLine(points, 0.6, false, true).slice(0, -1).map((s) => s.p);
  let contour = outline.map((p) => new THREE.Vector2(p.x, p.z));
  if (THREE.ShapeUtils.isClockWise(contour)) { contour = contour.reverse(); outline.reverse(); }
  const faces = THREE.ShapeUtils.triangulateShape(contour, []);
  const verts = contour.map((v) => [v.x, v.y]);
  let tris = faces.map((f) => [...f]);
  const mids = new Map();
  const mid = (a, b) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (!mids.has(key)) { verts.push([(verts[a][0] + verts[b][0]) / 2, (verts[a][1] + verts[b][1]) / 2]); mids.set(key, verts.length - 1); }
    return mids.get(key);
  };
  const len = (a, b) => Math.hypot(verts[a][0] - verts[b][0], verts[a][1] - verts[b][1]);
  for (let pass = 0; pass < 4; pass++) {
    const next = [];
    let split = false;
    for (const [a, b, c] of tris) {
      if (Math.max(len(a, b), len(b, c), len(c, a)) > 0.9) {
        const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
        next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
        split = true;
      } else next.push([a, b, c]);
    }
    tris = next;
    if (!split) break;
  }
  return { verts, tris, outline };
}

function buildArea(rec, heightNear) {
  const group = new THREE.Group();
  const surf = SURFACES[rec.material];
  const pts = rec.curved && rec.points.length >= 3
    ? sampleLine(rec.points, 0.5, true, true).slice(0, -1).map((s) => s.p.toArray())
    : rec.points;
  const { verts, tris, outline } = triangulateArea(pts);
  const avgY = rec.points.reduce((s, p) => s + p[1], 0) / rec.points.length;
  const ground = (x, z) => heightNear(x, z, avgY);
  const raise = surf.raise ?? 0;
  let levelY = null;
  if (surf.level) levelY = Math.max(...outline.map((p) => ground(p.x, p.z)), ...rec.points.map((p) => p[1])) + 0.03 + raise;
  const lift = surf.level ? 0 : (rec.material === 'lawn' ? 0.015 : 0.03);

  const g = new Geo();
  for (const [x, z] of verts) g.v(x, levelY ?? ground(x, z) + lift, z, x / surf.tile, z / surf.tile);
  for (const [a, b, c] of tris) g.tri(a, b, c);
  group.add(mesh(g.geometry(), rec.material, { cast: false }));

  // Edge: a skirt down to the ground (hard paving, decks) or a timber edging strip (soft beds).
  const ring = outline.map((p) => ({ p: new THREE.Vector3(p.x, ground(p.x, p.z), p.z), d: 0 }));
  ring.push({ p: ring[0].p.clone(), d: 0 });
  let d = 0;
  ring.forEach((s, i) => { if (i) d += s.p.distanceTo(ring[i - 1].p); s.d = d; });
  const skirt = new Geo();
  const skirtKey = surf.fascia ?? (surf.level ? rec.material : null);
  if (skirtKey) {
    const tile = tileOf(skirtKey);
    const ids = ring.map(({ p, d: dd }) => [skirt.v(p.x, levelY, p.z, dd / tile, levelY / tile), skirt.v(p.x, p.y - 0.12, p.z, dd / tile, (p.y - 0.12) / tile)]);
    for (let i = 0; i < ids.length - 1; i++) skirt.quad(ids[i][0], ids[i + 1][0], ids[i + 1][1], ids[i][1]);
    group.add(mesh(skirt.geometry(), skirtKey));
  }
  if (surf.edging) {
    group.add(mesh(ribbon(ring, { half: 0.025, lift: lift + 0.04, depth: 0.15, tile: 1, closed: true }), surf.edging));
  }
  return group;
}

function buildWall(rec, heightNear) {
  const group = new THREE.Group();
  const def = WALLS[rec.material];
  const samples = groundSamples(sampleLine(rec.points, 0.4, rec.curved), heightNear);
  const norms = sideNormals(samples);
  const h = rec.height;
  const t = def.t / 2;
  const buried = def.buried ?? 0.15;
  const g = new Geo();
  const F = [], B = [], T = [];
  samples.forEach(({ p, d }, i) => {
    const { n, k } = norms[i];
    const fx = p.x + n.x * t * k, fz = p.z + n.z * t * k;
    const bx = p.x - n.x * t * k, bz = p.z - n.z * t * k;
    const yb = p.y - buried, yt = p.y + h;
    const u = d / def.tile;
    F.push([g.v(fx, yb, fz, u, 0), g.v(fx, yt, fz, u, (h + buried) / def.tile)]);
    B.push([g.v(bx, yb, bz, u, 0), g.v(bx, yt, bz, u, (h + buried) / def.tile)]);
    T.push([g.v(fx, yt, fz, u, 0), g.v(bx, yt, bz, u, def.t / def.tile)]);
  });
  for (let i = 0; i < samples.length - 1; i++) {
    g.quad(F[i][0], F[i + 1][0], F[i + 1][1], F[i][1]);
    g.quad(B[i][0], B[i][1], B[i + 1][1], B[i + 1][0]);
    g.quad(T[i][0], T[i + 1][0], T[i + 1][1], T[i][1]);
  }
  for (const i of [0, samples.length - 1]) g.quad(F[i][0], F[i][1], B[i][1], B[i][0]);
  group.add(mesh(g.geometry(), rec.material));

  if (def.posts) {
    const total = samples[samples.length - 1].d;
    const count = Math.max(1, Math.round(total / def.posts));
    for (let k = 0; k <= count; k++) {
      const target = (k / count) * total;
      const i = Math.min(samples.length - 1, samples.findIndex((s) => s.d >= target - 1e-6));
      const { p } = samples[i];
      const { n } = norms[i];
      const size = def.centered ? 0.1 : 0.125;
      const out = def.centered ? 0 : t + size / 2;
      const top = h + (def.centered ? 0.05 : 0);
      const post = new THREE.BoxGeometry(size, top + buried + 0.2, size);
      post.rotateY(Math.atan2(n.x, n.z));
      post.translate(p.x + n.x * out, p.y + (top - buried - 0.2) / 2, p.z + n.z * out);
      group.add(mesh(projectUV(post, 1.2), def.postColor));
    }
    if (def.centered) {
      for (const y of [0.25, h - 0.25]) {
        group.add(mesh(ribbon(samples.map((s) => ({ p: s.p.clone().setY(s.p.y + y), d: s.d })), { half: 0.025, offset: -(t + 0.025), lift: 0, depth: 0.1, tile: 1.2 }), def.postColor));
      }
    }
  }
  return group;
}

function buildSteps(rec, heightNear) {
  const group = new THREE.Group();
  const style = STEP_STYLES[rec.material];
  const [b, t] = rec.points.map(toVec);
  const dx = t.x - b.x, dz = t.z - b.z;
  const run = Math.max(0.3, Math.hypot(dx, dz));
  const rise = Math.max(0.1, rec.height);
  const n = Math.max(1, Math.round(rise / 0.17));
  const riser = rise / n;
  const going = Math.max(run / n, 0.25);
  const base = heightNear(b.x, b.z, b.y) - 0.06;
  const steps = new THREE.Group();
  steps.position.set(b.x, 0, b.z);
  steps.rotation.y = Math.atan2(dx, dz);
  const treadTile = tileOf(style.tread);
  for (let i = 0; i < n; i++) {
    const hh = (i + 1) * riser + 0.06;
    const geo = new THREE.BoxGeometry(rec.width, hh, going);
    geo.translate(0, base + hh / 2, (i + 0.5) * going);
    projectUV(geo, treadTile);
    // Box faces: +x, -x, top, bottom, back (+z), front (-z, the riser you see from below).
    steps.add(mesh(geo, [style.riser, style.riser, style.tread, style.riser, style.riser, style.riser]));
  }
  group.add(steps);
  return group;
}

export function buildFeature(rec, heightNear) {
  const builder = { path: buildPath, area: buildArea, wall: buildWall, steps: buildSteps }[rec.type];
  const group = builder(rec, heightNear);
  group.userData.featureId = rec.id;
  return group;
}

export function disposeFeature(group) {
  group.traverse((o) => o.geometry?.dispose());
}

// ---------------------------------------------------------------------------
// Measurements for the inspector
// ---------------------------------------------------------------------------

function polygonArea(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i], q = points[(i + 1) % points.length];
    a += p[0] * q[2] - q[0] * p[2];
  }
  return Math.abs(a) / 2;
}

export function featureLength(rec) {
  if (rec.points.length < 2) return 0;
  const s = sampleLine(rec.points, 0.25, rec.curved);
  return s[s.length - 1].d;
}

export function featureStats(rec) {
  const m = (v) => `${v.toFixed(1)} m`;
  const m2 = (v) => `${v.toFixed(1)} m²`;
  if (rec.type === 'path') {
    const len = featureLength(rec);
    const area = len * rec.width;
    const rows = [['Length', m(len)], ['Area', m2(area)]];
    if (rec.material === 'stepping') rows.push(['You need', `≈ ${Math.ceil(len / (Math.min(0.32, rec.width * 0.32) * 2 + 0.18))} stones`]);
    else rows.push(['You need', SURFACES[rec.material].qty(area)]);
    return rows;
  }
  if (rec.type === 'area') {
    const pts = rec.curved && rec.points.length >= 3 ? sampleLine(rec.points, 0.25, true, true).map((s) => s.p.toArray()) : rec.points;
    const area = polygonArea(pts);
    return [['Area', m2(area)], ['Edge', m(sampleLine(pts, 0.25, false, true).at(-1).d)], ['You need', SURFACES[rec.material].qty(area)]];
  }
  if (rec.type === 'wall') {
    const len = featureLength(rec);
    return [['Length', m(len)], ['Height', m(rec.height)], ['Face area', m2(len * rec.height)], ['You need', WALLS[rec.material].qty(len, rec.height)]];
  }
  const [b, t] = rec.points;
  const run = Math.max(0.3, Math.hypot(t[0] - b[0], t[2] - b[2]));
  const n = Math.max(1, Math.round(Math.max(0.1, rec.height) / 0.17));
  const going = Math.max(run / n, 0.25);
  return [
    ['Steps', `${n}`],
    ['Riser', `${Math.round((rec.height / n) * 1000)} mm`],
    ['Tread', `${Math.round(going * 1000)} mm`],
    ['Total rise', m(rec.height)],
    ['Run', m(going * n)],
  ];
}

export function featureLabel(rec) {
  const tool = TOOL_BY_ID[rec.tool] ?? TOOLS.find((t) => t.type === rec.type);
  return { emoji: tool.emoji, title: tool.name, material: materialName(rec.material) };
}
