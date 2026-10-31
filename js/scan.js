// Loading and normalising 3D garden scans.
// Supports GLB / GLTF (incl. Draco + Meshopt compression), PLY (meshes, point clouds and
// Gaussian-splat PLYs shown as coloured points) and OBJ (+ MTL and textures if dropped together).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export const SCAN_EXTENSIONS = ['glb', 'gltf', 'ply', 'obj'];
const ext = (name) => name.split('.').pop().toLowerCase();
const SH_C0 = 0.28209479177387814;
const MAX_RAYCAST_POINTS = 250000;

// files: array of { name, blob }. Returns { object, kind, stats, name, format }.
export async function loadScan(files) {
  const main = files.find((f) => SCAN_EXTENSIONS.includes(ext(f.name)));
  if (!main) throw new Error('No .glb, .gltf, .ply or .obj file found.');

  // Let companion files (.bin, .mtl, textures) resolve by file name.
  const urls = new Map(files.map((f) => [f.name.split('/').pop(), URL.createObjectURL(f.blob)]));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    const name = decodeURIComponent(url.split(/[\\/]/).pop().split('?')[0]);
    return urls.get(name) ?? url;
  });

  const format = ext(main.name);
  const mainUrl = urls.get(main.name.split('/').pop());
  let object;
  try {
    if (format === 'glb' || format === 'gltf') object = await loadGLTF(mainUrl, manager);
    else if (format === 'ply') object = await loadPLY(main.blob);
    else object = await loadOBJ(mainUrl, files, urls, manager);
  } finally {
    // Textures are decoded by now; free the blob URLs.
    setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 5000);
  }

  const stats = { triangles: 0, points: 0 };
  let kind = 'mesh';
  object.traverse((o) => {
    if (o.isMesh) {
      const g = o.geometry;
      stats.triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
      o.castShadow = true;
      o.receiveShadow = true;
      g.computeBoundsTree();
    } else if (o.isPoints) {
      stats.points += o.geometry.attributes.position.count;
      kind = 'points';
    }
  });
  return { object, kind, stats, name: main.name, format };
}

async function loadGLTF(url, manager) {
  const loader = new GLTFLoader(manager);
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/libs/draco/gltf/');
  loader.setDRACOLoader(draco);
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url);
  draco.dispose();
  return gltf.scene;
}

async function loadPLY(blob) {
  const loader = new PLYLoader();
  loader.setCustomPropertyNameMapping({ f_dc: ['f_dc_0', 'f_dc_1', 'f_dc_2'] });
  const geometry = loader.parse(await blob.arrayBuffer());

  // Gaussian splat files store colour as spherical-harmonic DC terms.
  if (!geometry.attributes.color && geometry.attributes.f_dc) {
    const dc = geometry.attributes.f_dc.array;
    const col = new Float32Array(dc.length);
    for (let i = 0; i < dc.length; i++) col[i] = THREE.MathUtils.clamp(0.5 + SH_C0 * dc[i], 0, 1);
    geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  if (geometry.attributes.f_dc) geometry.deleteAttribute('f_dc');
  const hasColor = !!geometry.attributes.color;

  if (geometry.index) {
    if (!geometry.attributes.normal) geometry.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: hasColor, color: hasColor ? 0xffffff : 0x8a9a7a, roughness: 1, side: THREE.DoubleSide });
    return new THREE.Mesh(geometry, mat);
  }
  const mat = new THREE.PointsMaterial({ size: 0.015, vertexColors: hasColor, color: hasColor ? 0xffffff : 0x9fb59a, sizeAttenuation: true });
  const points = new THREE.Points(geometry, mat);
  const group = new THREE.Group();
  group.add(points);
  return group;
}

async function loadOBJ(url, files, urls, manager) {
  const loader = new OBJLoader(manager);
  const mtl = files.find((f) => ext(f.name) === 'mtl');
  if (mtl) {
    const materials = await new MTLLoader(manager).loadAsync(urls.get(mtl.name.split('/').pop()));
    materials.preload();
    loader.setMaterials(materials);
  }
  const obj = await loader.loadAsync(url);
  obj.traverse((o) => {
    if (o.isMesh && !mtl) o.material = new THREE.MeshStandardMaterial({ color: 0x8a9a7a, roughness: 1, side: THREE.DoubleSide });
  });
  return obj;
}

// ---------------------------------------------------------------------------
// Placing the scan in the world
// ---------------------------------------------------------------------------
// Hierarchy: root (centring offset + scale) > orient (rotation) > loaded object.

export function createScanRig(loaded) {
  const root = new THREE.Group();
  root.name = 'Scan';
  const orient = new THREE.Group();
  orient.add(loaded.object);
  root.add(orient);
  root.userData = { orient, loaded, raycastTargets: buildRaycastTargets(loaded.object) };
  for (const t of root.userData.raycastTargets) if (t.userData.proxy) t.userData.source.parent.add(t);
  return root;
}

// Points raycasting is linear in point count; use a decimated, invisible copy for big clouds.
function buildRaycastTargets(object) {
  const targets = [];
  object.traverse((o) => {
    if (o.isMesh) targets.push(o);
    if (o.isPoints) {
      const pos = o.geometry.attributes.position;
      if (pos.count <= MAX_RAYCAST_POINTS) { targets.push(o); return; }
      const stride = Math.ceil(pos.count / MAX_RAYCAST_POINTS);
      const n = Math.floor(pos.count / stride);
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        arr[i * 3] = pos.getX(i * stride);
        arr[i * 3 + 1] = pos.getY(i * stride);
        arr[i * 3 + 2] = pos.getZ(i * stride);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      const proxy = new THREE.Points(g, new THREE.PointsMaterial({ visible: false }));
      proxy.position.copy(o.position);
      proxy.quaternion.copy(o.quaternion);
      proxy.scale.copy(o.scale);
      proxy.userData = { proxy: true, source: o };
      targets.push(proxy);
    }
  });
  return targets;
}

function samplePoints(root, max = 60000) {
  root.updateMatrixWorld(true);
  const objs = [];
  let total = 0;
  root.traverse((o) => {
    if ((o.isMesh || o.isPoints) && !o.userData.proxy) {
      objs.push(o);
      total += o.geometry.attributes.position.count;
    }
  });
  const stride = Math.max(1, Math.ceil(total / max));
  const xs = [], ys = [], zs = [];
  const v = new THREE.Vector3();
  for (const o of objs) {
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      xs.push(v.x); ys.push(v.y); zs.push(v.z);
    }
  }
  const sort = (a) => Float32Array.from(a).sort();
  return { xs: sort(xs), ys: sort(ys), zs: sort(zs) };
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];

// Guess which way is up for formats without a fixed convention: gardens are wider than
// they are tall, and most surface (ground) sits at the bottom of the vertical range.
export function guessOrientation(rig) {
  const { orient } = rig.userData;
  orient.quaternion.identity();
  const s = samplePoints(orient);
  const axes = [s.xs, s.ys, s.zs].map((a) => {
    const lo = pct(a, 0.02), hi = pct(a, 0.98), med = pct(a, 0.5);
    return { extent: hi - lo, sign: med - lo < hi - med ? 1 : -1 };
  });
  let up = 0;
  if (axes[1].extent < axes[up].extent) up = 1;
  if (axes[2].extent < axes[up].extent) up = 2;
  const upVec = new THREE.Vector3().setComponent(up, axes[up].sign);
  return new THREE.Quaternion().setFromUnitVectors(upVec, new THREE.Vector3(0, 1, 0));
}

// Apply rotation and scale, then centre the scan on the origin with its ground at y = offset.
export function applyScanTransform(rig, { quaternion, scale, offset }) {
  const { orient } = rig.userData;
  orient.quaternion.fromArray(quaternion);
  rig.position.set(0, 0, 0);
  rig.scale.setScalar(scale);
  const s = samplePoints(rig);
  const cx = (pct(s.xs, 0.01) + pct(s.xs, 0.99)) / 2;
  const cz = (pct(s.zs, 0.01) + pct(s.zs, 0.99)) / 2;
  const ground = pct(s.ys, 0.03);
  rig.position.set(-cx, -ground + offset, -cz);
  rig.updateMatrixWorld(true);

  return new THREE.Box3(
    new THREE.Vector3(pct(s.xs, 0.01) - cx, offset, pct(s.zs, 0.01) - cz),
    new THREE.Vector3(pct(s.xs, 0.99) - cx, pct(s.ys, 0.99) - ground + offset, pct(s.zs, 0.99) - cz)
  );
}

// Toggle between lit materials (show sun/shadows) and unlit (colours exactly as captured).
export function setScanLit(rig, lit) {
  rig.traverse((o) => {
    if (!o.isMesh) return;
    if (!o.userData.litMaterial) o.userData.litMaterial = o.material;
    if (lit) { o.material = o.userData.litMaterial; return; }
    if (!o.userData.unlitMaterial) {
      const src = Array.isArray(o.material) ? o.material : [o.material];
      const unlit = src.map((m) => new THREE.MeshBasicMaterial({
        map: m.map ?? null, color: m.color ?? 0xffffff, vertexColors: m.vertexColors, side: m.side,
        transparent: m.transparent, opacity: m.opacity, alphaTest: m.alphaTest,
      }));
      o.userData.unlitMaterial = Array.isArray(o.material) ? unlit : unlit[0];
    }
    o.material = o.userData.unlitMaterial;
  });
}

export function setPointSize(rig, size) {
  rig.traverse((o) => { if (o.isPoints && !o.userData.proxy) o.material.size = size; });
}

export function disposeScan(rig) {
  const materials = new Set();
  rig.traverse((o) => {
    o.geometry?.disposeBoundsTree?.();
    o.geometry?.dispose();
    [o.material, o.userData.litMaterial, o.userData.unlitMaterial].flat().filter(Boolean).forEach((m) => materials.add(m));
  });
  for (const m of materials) {
    for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) m[k]?.dispose();
    m.dispose();
  }
}
