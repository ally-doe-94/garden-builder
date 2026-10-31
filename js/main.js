import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import {
  PLANTS, PLANT_BY_ID, CATEGORIES, createPlant, setPlantAge, applySeason, seasonForMonth, growthScale, disposeObject,
} from './plants.js';
import { createEnvironment, createDemoGarden, sunPosition } from './environment.js';
import {
  loadScan, createScanRig, guessOrientation, applyScanTransform, setScanLit, setPointSize, disposeScan,
} from './scan.js';
import * as store from './storage.js';

const $ = (id) => document.getElementById(id);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const YEAR_MS = 365.25 * 24 * 3600 * 1000;
const DEFAULT_SCAN = { quaternion: [0, 0, 0, 1], scale: 1, offset: 0, pointSize: 0.015, lit: true };
const DEFAULT_SETTINGS = { years: 0, month: 6, hour: 14, lat: 51.5, north: 0, showSpread: false };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const saved = store.loadState();
const state = {
  plants: saved?.plants ?? [],
  settings: { ...DEFAULT_SETTINGS, ...saved?.settings },
  scan: saved?.scan ?? null, // transform settings for the loaded scan; files live in IndexedDB
};

let persistTimer = null;
let warnedStorage = false;
let staleTab = false; // another tab saved newer changes; stop writing so we don't overwrite them
function persist() {
  if (staleTab) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    if (!store.saveState(state) && !warnedStorage) {
      warnedStorage = true;
      toast('Could not save to this browser — use ⋯ → Save layout file to keep your work.', 6000);
    }
  }, 300);
}
addEventListener('beforeunload', () => {
  clearTimeout(persistTimer);
  if (!staleTab) store.saveState(state);
});
addEventListener('storage', (e) => {
  if (e.key !== store.STATE_KEY || staleTab) return;
  staleTab = true;
  clearTimeout(persistTimer);
  toast('This garden was changed in another tab. Reload this tab to keep editing here.', 10000);
});

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const today = () => new Date().toISOString().slice(0, 10);
const ageNow = (record) => Math.max(0, (Date.now() - Date.parse(record.planted)) / YEAR_MS) || 0;
const displayAge = (record) => ageNow(record) + state.settings.years;
const season = () => seasonForMonth(state.settings.month, state.settings.lat < 0);

// ---------------------------------------------------------------------------
// Three.js setup
// ---------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
$('viewport').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 3000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.screenSpacePanning = false;
controls.maxPolarAngle = Math.PI * 0.495;

const env = createEnvironment(scene);
const plantsGroup = new THREE.Group();
plantsGroup.name = 'Plants';
scene.add(plantsGroup);

const transform = new TransformControls(camera, renderer.domElement);
transform.setSize(0.9);
transform.addEventListener('dragging-changed', (e) => {
  controls.enabled = !e.value;
  if (!e.value) persist();
});
scene.add(transform.getHelper());

let terrain = null;        // demo garden group or scan rig
let terrainTargets = [];   // meshes / points used to find the ground under the cursor
let demo = null;
const plantObjects = new Map();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------------------
// Terrain (demo garden or scan)
// ---------------------------------------------------------------------------

function setTerrain(obj, targets, bounds) {
  if (terrain) {
    scene.remove(terrain);
    if (terrain !== demo) disposeScan(terrain);
  }
  terrain = obj;
  terrainTargets = targets;
  scene.add(obj);
  env.fit(bounds);
  env.setSun(state.settings);
  frameCamera(bounds);
}

function showDemo() {
  demo ??= createDemoGarden();
  const targets = [];
  demo.traverse((o) => { if (o.isMesh) targets.push(o); });
  setTerrain(demo, targets, new THREE.Box3().setFromObject(demo));
  $('scan-status').textContent = 'Demo garden — load your own scan to begin';
}

function frameCamera(box) {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  // Portrait screens have a narrow horizontal field of view, so back off further.
  const r = Math.max(size.x, size.z, 6) * (camera.aspect < 1 ? 1 / Math.sqrt(camera.aspect) : 1);
  controls.target.set(center.x, 0, center.z);
  camera.position.set(center.x + r * 0.35, r * 0.85, center.z - r * 0.9);
  controls.maxDistance = r * 5;
  controls.minDistance = 0.3;
  controls.update();
}

const formatCount = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);

async function openScanFiles(files, { fromStorage = false } = {}) {
  showLoading(fromStorage ? 'Restoring your garden scan…' : `Loading ${files[0].name}…`);
  await new Promise((r) => setTimeout(r, 30)); // let the spinner paint
  try {
    const loaded = await loadScan(files);
    const rig = createScanRig(loaded);
    if (!fromStorage || !state.scan) {
      const auto = loaded.format === 'ply' || loaded.format === 'obj';
      state.scan = { name: loaded.name, ...DEFAULT_SCAN, quaternion: (auto ? guessOrientation(rig) : new THREE.Quaternion()).toArray() };
      // Sample plants from the demo garden don't belong in a real scan.
      for (const r of state.plants.filter((p) => p.demo)) removePlant(r.id);
    }
    const bounds = applyScanTransform(rig, state.scan);
    setScanLit(rig, state.scan.lit);
    setPointSize(rig, state.scan.pointSize);
    setTerrain(rig, rig.userData.raycastTargets, bounds);

    const { stats } = loaded;
    const detail = stats.points ? `${formatCount(stats.points)} points` : `${formatCount(stats.triangles)} triangles`;
    $('scan-status').textContent = `${loaded.name} · ${detail}`;
    $('scan-info').textContent = `${loaded.name} — ${detail}. Size ≈ ${bounds.max.x - bounds.min.x | 0} × ${bounds.max.z - bounds.min.z | 0} m.`;
    syncScanPanel();
    persist();

    if (!fromStorage) {
      try {
        await store.saveScanFiles(files);
        toast(`Loaded ${loaded.name}. It will be here next time you open the planner.`);
      } catch {
        toast(`Loaded ${loaded.name}, but it is too large to remember in this browser — you'll need to load it again next time.`, 7000);
      }
    }
  } catch (err) {
    console.error(err);
    toast(`Couldn't load that scan: ${err.message || err}`, 7000);
    if (!terrain) showDemo();
  } finally {
    hideLoading();
  }
}

function refreshScan() {
  if (!terrain || terrain === demo) return;
  const bounds = applyScanTransform(terrain, state.scan);
  env.fit(bounds);
  env.setSun(state.settings);
  persist();
}

// ---------------------------------------------------------------------------
// Raycasting
// ---------------------------------------------------------------------------

const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 0.05;
const ndc = new THREE.Vector2();
const DOWN = new THREE.Vector3(0, -1, 0);

function setRayFromEvent(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
}

function hitTerrain() {
  const hit = raycaster.intersectObjects(terrainTargets, false)[0] ?? raycaster.intersectObject(env.groundPlane, false)[0];
  return hit?.point ?? null;
}

// Find the surface nearest to the current height directly below/above (x, z).
function groundHeightAt(x, z, nearY) {
  raycaster.set(new THREE.Vector3(x, nearY + 3, z), DOWN);
  const hits = raycaster.intersectObjects(terrainTargets, false);
  if (!hits.length) return nearY;
  return hits.reduce((best, h) => (Math.abs(h.point.y - nearY) < Math.abs(best - nearY) ? h.point.y : best), hits[0].point.y);
}

function pickPlant() {
  for (const hit of raycaster.intersectObject(plantsGroup, true)) {
    let o = hit.object;
    while (o && !o.userData.plantId) o = o.parent;
    if (o) return o.userData.plantId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plants
// ---------------------------------------------------------------------------

function spawnPlant(record) {
  const root = createPlant(record.type, record.seed);
  root.userData.plantId = record.id;
  root.position.fromArray(record.position);
  root.rotation.y = record.rotation;
  root.scale.setScalar(record.size);
  setPlantAge(root, displayAge(record));
  applySeason(root, season());
  root.userData.spreadRing.visible = state.settings.showSpread;
  plantsGroup.add(root);
  plantObjects.set(record.id, root);
  return root;
}

function addPlant(type, position, extra = {}) {
  const record = {
    id: newId(), type, position: position.toArray(), rotation: Math.random() * Math.PI * 2, size: 1,
    seed: (Math.random() * 2 ** 31) | 0, planted: today(), notes: '', ...extra,
  };
  state.plants.push(record);
  spawnPlant(record);
  persist();
  renderPlacedList();
  return record;
}

function removePlant(id) {
  const obj = plantObjects.get(id);
  if (obj) {
    if (transform.object === obj) transform.detach();
    plantsGroup.remove(obj);
    disposeObject(obj);
    plantObjects.delete(id);
  }
  state.plants = state.plants.filter((p) => p.id !== id);
  if (selectedId === id) select(null);
  persist();
  renderPlacedList();
}

const recordFor = (id) => state.plants.find((p) => p.id === id);

function syncRecordFromObject(id) {
  const obj = plantObjects.get(id);
  const rec = recordFor(id);
  if (!obj || !rec) return;
  rec.position = obj.position.toArray();
  rec.rotation = obj.rotation.y;
  persist();
}

function updateAllPlants({ age = false, seasons = false, spread = false } = {}) {
  for (const rec of state.plants) {
    const obj = plantObjects.get(rec.id);
    if (!obj) continue;
    if (age) setPlantAge(obj, displayAge(rec));
    if (seasons) applySeason(obj, season());
    if (spread) obj.userData.spreadRing.visible = state.settings.showSpread;
  }
  if (ghost) {
    if (age) setPlantAge(ghost, state.settings.years);
    if (seasons) applySeason(ghost, season());
  }
}

// ---------------------------------------------------------------------------
// Placing new plants
// ---------------------------------------------------------------------------

let placing = null;
let ghost = null;
let lastPointer = null;
let ghostQueued = false;

function startPlacing(id) {
  if (placing?.id === id) return stopPlacing();
  stopPlacing();
  select(null);
  placing = PLANT_BY_ID[id];
  ghost = createPlant(id, 12345);
  ghost.traverse((o) => {
    if (o.isMesh && o.userData.role) {
      o.material.transparent = true;
      o.material.opacity = 0.6;
      o.material.depthWrite = false;
      o.castShadow = false;
    }
  });
  ghost.userData.spreadRing.visible = true;
  setPlantAge(ghost, state.settings.years);
  applySeason(ghost, season());
  ghost.visible = false;
  scene.add(ghost);
  renderer.domElement.style.cursor = 'crosshair';
  if (matchMedia('(max-width: 760px)').matches) $('palette').classList.add('collapsed');
  showHint(`Click in the garden to plant <strong>${placing.name}</strong> · keep clicking to plant more · <kbd>Esc</kbd> to finish`);
  renderPalette();
}

function stopPlacing() {
  if (!placing) return;
  placing = null;
  scene.remove(ghost);
  disposeObject(ghost);
  ghost = null;
  renderer.domElement.style.cursor = '';
  hideHint();
  renderPalette();
}

function updateGhost() {
  ghostQueued = false;
  if (!ghost || !lastPointer) return;
  setRayFromEvent(lastPointer);
  const p = hitTerrain();
  ghost.visible = !!p;
  if (p) ghost.position.copy(p);
}

// ---------------------------------------------------------------------------
// Selection & editing
// ---------------------------------------------------------------------------

let selectedId = null;
let tool = 'translate';

function select(id) {
  const prev = selectedId && plantObjects.get(selectedId);
  if (prev) prev.userData.selectRing.visible = false;
  selectedId = id;
  if (!id) {
    transform.detach();
    $('inspector').classList.add('hidden');
    renderPlacedList();
    return;
  }
  const obj = plantObjects.get(id);
  obj.userData.selectRing.visible = true;
  transform.attach(obj);
  setTool(tool);
  $('scan-panel').classList.add('hidden');
  $('inspector').classList.remove('hidden');
  fillInspector();
  renderPlacedList();
}

function setTool(t) {
  tool = t;
  transform.setMode(t);
  transform.showX = t === 'translate';
  transform.showZ = t === 'translate';
  transform.showY = t === 'rotate';
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
}

transform.addEventListener('objectChange', () => {
  const obj = transform.object;
  if (!obj) return;
  if (tool === 'translate') obj.position.y = groundHeightAt(obj.position.x, obj.position.z, obj.position.y);
  syncRecordFromObject(obj.userData.plantId);
});

function fillInspector() {
  const rec = recordFor(selectedId);
  if (!rec) return;
  const def = PLANT_BY_ID[rec.type];
  $('insp-name').textContent = `${def.emoji} ${def.name}`;
  $('insp-latin').textContent = def.latin;
  $('insp-planted').value = rec.planted;
  $('insp-notes').value = rec.notes;
  $('insp-size').value = rec.size;
  $('insp-size-out').textContent = `${Math.round(rec.size * 100)}%`;
  renderFacts();
}

function renderFacts() {
  const rec = recordFor(selectedId);
  if (!rec) return;
  const def = PLANT_BY_ID[rec.type];
  const age = displayAge(rec);
  const s = growthScale(def, age) * rec.size;
  const when = state.settings.years ? `in ${state.settings.years} yr${state.settings.years > 1 ? 's' : ''}` : 'now';
  const facts = [
    ['Type', def.type],
    ['Sun', def.sun],
    ['Flowers', def.bloomText],
    ['Mature size', `${def.height} m tall × ${def.spread} m wide`],
    [`Size ${when}`, `≈ ${(def.height * s).toFixed(1)} m × ${(def.spread * s).toFixed(1)} m`],
  ];
  $('insp-facts').innerHTML = facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

function duplicateSelected() {
  const rec = recordFor(selectedId);
  if (!rec) return;
  const def = PLANT_BY_ID[rec.type];
  const obj = plantObjects.get(rec.id);
  const offset = new THREE.Vector3(Math.max(0.3, def.spread * growthScale(def, displayAge(rec)) * rec.size), 0, 0)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), obj.rotation.y);
  const pos = obj.position.clone().add(offset);
  pos.y = groundHeightAt(pos.x, pos.z, pos.y);
  const copy = addPlant(rec.type, pos, { rotation: rec.rotation, size: rec.size, planted: rec.planted });
  select(copy.id);
}

let focusTarget = null;
function focusOn(obj) {
  focusTarget = obj.position.clone();
}

// ---------------------------------------------------------------------------
// Pointer input
// ---------------------------------------------------------------------------

let down = null;
const canvas = renderer.domElement;

canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY, button: e.button, onGizmo: transform.axis !== null || transform.dragging };
});

canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const click = Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6 && !down.onGizmo && down.button === 0;
  down = null;
  if (!click) return;
  setRayFromEvent(e);
  if (placing) {
    const p = hitTerrain();
    if (p) addPlant(placing.id, p);
    return;
  }
  select(pickPlant());
});

canvas.addEventListener('pointermove', (e) => {
  if (!placing || e.pointerType === 'touch') return;
  lastPointer = e;
  if (!ghostQueued) {
    ghostQueued = true;
    requestAnimationFrame(updateGhost);
  }
});

canvas.addEventListener('contextmenu', (e) => {
  if (placing) {
    e.preventDefault();
    stopPlacing();
  }
});

addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select')) return;
  if (e.key === 'Escape') {
    if (placing) stopPlacing();
    else select(null);
    $('menu').classList.add('hidden');
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
    e.preventDefault();
    removePlant(selectedId);
  } else if (selectedId && (e.key === 'g' || e.key === 'm')) setTool('translate');
  else if (selectedId && e.key === 'r') setTool('rotate');
  else if (selectedId && e.key === 'f') focusOn(plantObjects.get(selectedId));
});

// ---------------------------------------------------------------------------
// Palette & lists
// ---------------------------------------------------------------------------

const SUN_SHORT = {
  'Full sun': '☀ sun', 'Full sun / part shade': '☀ sun–part', 'Sun / part shade': '☀ sun–part',
  'Part shade': '⛅ part shade', 'Part shade / shade': '☁ shade', 'Sun or shade': '◐ any',
};
let filter = 'All';
let search = '';

function renderFilters() {
  $('plant-filters').innerHTML = ['All', ...CATEGORIES]
    .map((c) => `<button data-filter="${c}" class="${c === filter ? 'active' : ''}">${c}</button>`)
    .join('');
}

function renderPalette() {
  const q = search.trim().toLowerCase();
  const items = PLANTS.filter((p) => (filter === 'All' || p.category === filter)
    && (!q || `${p.name} ${p.latin} ${p.type}`.toLowerCase().includes(q)));
  $('plant-grid').innerHTML = items.map((p) => `
    <button class="plant-card ${placing?.id === p.id ? 'active' : ''}" data-plant="${p.id}" title="${p.latin}">
      <span class="swatch">${p.emoji}</span>
      <span class="name">${p.name}</span>
      <span class="meta">${p.height} m · ${SUN_SHORT[p.sun] ?? p.sun}</span>
    </button>`).join('') || '<p class="muted small">No plants match.</p>';
}

function renderPlacedList() {
  const counts = new Map();
  for (const p of state.plants) counts.set(p.type, (counts.get(p.type) ?? 0) + 1);
  const selType = recordFor(selectedId)?.type;
  $('placed-count').textContent = state.plants.length ? `(${state.plants.length})` : '';
  $('placed-list').innerHTML = PLANTS.filter((p) => counts.has(p.id))
    .map((p) => `<li data-type="${p.id}" class="${p.id === selType ? 'selected' : ''}">
      <span>${p.emoji}</span><span>${p.name}</span><span class="count">×${counts.get(p.id)}</span></li>`)
    .join('') || '<li class="empty">Nothing planted yet.</li>';
}

$('plant-filters').addEventListener('click', (e) => {
  const b = e.target.closest('[data-filter]');
  if (!b) return;
  filter = b.dataset.filter;
  renderFilters();
  renderPalette();
});
$('plant-search').addEventListener('input', (e) => { search = e.target.value; renderPalette(); });
$('plant-grid').addEventListener('click', (e) => {
  const b = e.target.closest('[data-plant]');
  if (b) startPlacing(b.dataset.plant);
});
$('placed-list').addEventListener('click', (e) => {
  const li = e.target.closest('[data-type]');
  if (!li) return;
  stopPlacing();
  // Cycle through every plant of this type.
  const ids = state.plants.filter((p) => p.type === li.dataset.type).map((p) => p.id);
  const next = ids[(ids.indexOf(selectedId) + 1) % ids.length];
  select(next);
  focusOn(plantObjects.get(next));
});
document.querySelectorAll('[data-collapse]').forEach((b) =>
  b.addEventListener('click', () => $(b.dataset.collapse).classList.toggle('collapsed')));

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------

document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('insp-close').addEventListener('click', () => select(null));
$('insp-del').addEventListener('click', () => selectedId && removePlant(selectedId));
$('insp-dup').addEventListener('click', duplicateSelected);
$('insp-notes').addEventListener('input', (e) => {
  const rec = recordFor(selectedId);
  if (rec) { rec.notes = e.target.value; persist(); }
});
$('insp-planted').addEventListener('change', (e) => {
  const rec = recordFor(selectedId);
  if (!rec || !e.target.value) return;
  rec.planted = e.target.value;
  setPlantAge(plantObjects.get(rec.id), displayAge(rec));
  renderFacts();
  persist();
});
$('insp-size').addEventListener('input', (e) => {
  const rec = recordFor(selectedId);
  if (!rec) return;
  rec.size = parseFloat(e.target.value);
  plantObjects.get(rec.id).scale.setScalar(rec.size);
  $('insp-size-out').textContent = `${Math.round(rec.size * 100)}%`;
  renderFacts();
  persist();
});

// ---------------------------------------------------------------------------
// Time, season & growth controls
// ---------------------------------------------------------------------------

let currentSeason = season();

function applySettings({ fromInput = false } = {}) {
  const s = state.settings;
  const { elevation } = sunPosition(s.lat, s.month, s.hour);
  env.setSun(s);

  const yrs = s.years;
  $('years-out').textContent = yrs === 0 ? 'Today' : `In ${yrs} year${yrs > 1 ? 's' : ''}`;
  $('month-out').textContent = `${MONTHS[s.month - 1]} · ${season()}`;
  const hh = Math.floor(s.hour), mm = Math.round((s.hour - hh) * 60);
  const sunText = elevation > 0 ? `☀ ${Math.round((elevation * 180) / Math.PI)}° high` : 'sun down';
  $('hour-out').textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} · ${sunText}`;
  $('north-out').textContent = `${s.north}°`;

  if (season() !== currentSeason) {
    currentSeason = season();
    updateAllPlants({ seasons: true });
  }
  if (fromInput) persist();
}

function bindSlider(id, key, parse = parseFloat, after) {
  const el = $(id);
  el.value = state.settings[key];
  el.addEventListener('input', () => {
    state.settings[key] = parse(el.value);
    applySettings({ fromInput: true });
    after?.();
  });
}

bindSlider('years', 'years', (v) => parseInt(v, 10), () => { updateAllPlants({ age: true }); renderFacts(); });
bindSlider('month', 'month', (v) => parseInt(v, 10));
bindSlider('hour', 'hour');
bindSlider('lat', 'lat', (v) => THREE.MathUtils.clamp(parseFloat(v) || 0, -66, 66));
bindSlider('north', 'north', (v) => parseInt(v, 10));

$('show-spread').checked = state.settings.showSpread;
$('show-spread').addEventListener('change', (e) => {
  state.settings.showSpread = e.target.checked;
  updateAllPlants({ spread: true });
  persist();
});

$('btn-sun-settings').addEventListener('click', () => {
  const pop = $('sun-settings');
  pop.classList.toggle('hidden');
  env.compass.visible = !pop.classList.contains('hidden');
});

// ---------------------------------------------------------------------------
// Scan settings panel
// ---------------------------------------------------------------------------

function syncScanPanel() {
  if (!state.scan) return;
  $('scan-scale').value = state.scan.scale;
  $('scan-offset').value = state.scan.offset;
  $('scan-point-size').value = state.scan.pointSize;
  $('scan-lit').checked = state.scan.lit;
  const hasPoints = terrain?.userData.loaded?.kind === 'points';
  $('point-size-row').classList.toggle('hidden', !hasPoints);
}

$('btn-scan-settings').addEventListener('click', () => {
  if (!state.scan || terrain === demo) {
    toast('Load a scan first — these settings fix its orientation and scale.');
    return;
  }
  select(null);
  $('scan-panel').classList.toggle('hidden');
});
$('scan-close').addEventListener('click', () => $('scan-panel').classList.add('hidden'));

const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
document.querySelectorAll('[data-scan-rot]').forEach((b) => b.addEventListener('click', () => {
  const [axis, dir] = [b.dataset.scanRot[0], b.dataset.scanRot[1]];
  const step = new THREE.Quaternion().setFromAxisAngle(AXES[axis], (dir === '+' ? 1 : -1) * Math.PI / 2);
  state.scan.quaternion = step.multiply(new THREE.Quaternion().fromArray(state.scan.quaternion)).toArray();
  refreshScan();
}));
$('scan-scale').addEventListener('change', (e) => {
  const v = parseFloat(e.target.value);
  if (!(v > 0)) return;
  state.scan.scale = v;
  refreshScan();
});
$('scan-offset').addEventListener('input', (e) => {
  state.scan.offset = parseFloat(e.target.value);
  refreshScan();
});
$('scan-point-size').addEventListener('input', (e) => {
  state.scan.pointSize = parseFloat(e.target.value);
  setPointSize(terrain, state.scan.pointSize);
  persist();
});
$('scan-lit').addEventListener('change', (e) => {
  state.scan.lit = e.target.checked;
  setScanLit(terrain, state.scan.lit);
  persist();
});
$('show-ground').addEventListener('change', (e) => { env.grid.visible = e.target.checked; });

// ---------------------------------------------------------------------------
// Files: scans, layouts, exports
// ---------------------------------------------------------------------------

$('btn-load-scan').addEventListener('click', () => $('file-scan').click());
$('file-scan').addEventListener('change', (e) => {
  const files = [...e.target.files].map((f) => ({ name: f.name, blob: f }));
  e.target.value = '';
  if (files.length) openScanFiles(files);
});
$('file-layout').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importLayout(await file.text());
});

function importLayout(text) {
  let data;
  try {
    data = JSON.parse(text);
    if (!Array.isArray(data.plants)) throw new Error();
  } catch {
    toast('That file is not a garden layout.');
    return;
  }
  for (const id of [...plantObjects.keys()]) removePlant(id);
  state.settings = { ...DEFAULT_SETTINGS, ...data.settings };
  if (data.scan && state.scan && data.scan.name === state.scan.name) {
    state.scan = { ...DEFAULT_SCAN, ...data.scan };
    refreshScan();
    syncScanPanel();
  }
  for (const rec of data.plants) {
    if (!PLANT_BY_ID[rec.type]) continue;
    const clean = { id: newId(), rotation: 0, size: 1, seed: 1, planted: today(), notes: '', ...rec };
    state.plants.push(clean);
    spawnPlant(clean);
  }
  for (const key of ['years', 'month', 'hour', 'lat', 'north']) $(key).value = state.settings[key];
  $('show-spread').checked = state.settings.showSpread;
  currentSeason = null;
  applySettings();
  updateAllPlants({ age: true, spread: true });
  renderPlacedList();
  persist();
  toast(`Opened layout with ${state.plants.length} plants.`);
}

function exportLayout() {
  const data = { app: 'northall-road-garden', version: 1, exportedAt: new Date().toISOString(), ...state };
  store.downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `garden-layout-${today()}.json`);
}

// Hide helpers (gizmo, rings, ghost) while running fn.
function withoutHelpers(fn) {
  const hidden = [transform.getHelper(), ghost, env.grid, env.compass].filter((o) => o?.visible);
  const rings = [];
  for (const obj of plantObjects.values()) {
    for (const r of [obj.userData.spreadRing, obj.userData.selectRing]) if (r.visible) rings.push(r);
  }
  [...hidden, ...rings].forEach((o) => { o.visible = false; });
  try {
    return fn();
  } finally {
    [...hidden, ...rings].forEach((o) => { o.visible = true; });
  }
}

function snapshot() {
  withoutHelpers(() => {
    renderer.render(scene, camera);
    renderer.domElement.toBlob((blob) => store.downloadBlob(blob, `garden-${today()}.png`));
  });
}

async function exportGLB() {
  showLoading('Exporting 3D scene…');
  try {
    const exporter = new GLTFExporter();
    const hiddenRings = [];
    for (const obj of plantObjects.values()) {
      for (const r of [obj.userData.spreadRing, obj.userData.selectRing]) if (r.visible) { r.visible = false; hiddenRings.push(r); }
    }
    const result = await exporter.parseAsync([terrain, plantsGroup], { binary: true, onlyVisible: true });
    hiddenRings.forEach((r) => { r.visible = true; });
    store.downloadBlob(new Blob([result], { type: 'model/gltf-binary' }), `garden-${today()}.glb`);
  } catch (err) {
    console.error(err);
    toast(`Export failed: ${err.message || err}`);
  } finally {
    hideLoading();
  }
}

$('btn-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  $('menu').classList.toggle('hidden');
});
addEventListener('click', (e) => {
  if (!e.target.closest('#menu')) $('menu').classList.add('hidden');
});
$('menu').addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  $('menu').classList.add('hidden');
  if (action === 'export-layout') exportLayout();
  if (action === 'import-layout') $('file-layout').click();
  if (action === 'export-glb') exportGLB();
  if (action === 'snapshot') snapshot();
  if (action === 'clear-plants' && state.plants.length && confirm(`Remove all ${state.plants.length} plants?`)) {
    for (const id of [...plantObjects.keys()]) removePlant(id);
  }
  if (action === 'clear-scan' && state.scan && confirm('Remove the scan and go back to the demo garden? Your plants stay.')) {
    await store.clearScanFiles().catch(() => {});
    state.scan = null;
    $('scan-panel').classList.add('hidden');
    showDemo();
    persist();
  }
});

$('btn-help').addEventListener('click', () => $('help-dialog').showModal());

// Drag & drop anywhere on the page.
let dragDepth = 0;
addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  $('drop-overlay').classList.remove('hidden');
});
addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').classList.add('hidden'); }
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').classList.add('hidden');
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length) return;
  if (files.length === 1 && files[0].name.toLowerCase().endsWith('.json')) {
    importLayout(await files[0].text());
    return;
  }
  openScanFiles(files.map((f) => ({ name: f.name, blob: f })));
});

// ---------------------------------------------------------------------------
// Little UI helpers
// ---------------------------------------------------------------------------

let toastTimer = null;
function toast(msg, ms = 3500) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}
function showHint(html) { $('hint').innerHTML = html; $('hint').classList.remove('hidden'); }
function hideHint() { $('hint').classList.add('hidden'); }
function showLoading(text) { $('loading-text').textContent = text; $('loading').classList.remove('hidden'); }
function hideLoading() { $('loading').classList.add('hidden'); }

// ---------------------------------------------------------------------------
// First run: a few example plants in the demo garden
// ---------------------------------------------------------------------------

function plantDemoExamples() {
  const yearsAgo = (n) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return d.toISOString().slice(0, 10); };
  const examples = [
    ['apple', -3.5, -4, 4], ['cherry', -3.1, -6.1, 5], ['maple', 3.4, 0.4, 4],
    ['box', -3.9, 2.6, 3], ['box', -3.9, 0.6, 3], ['rose', -3.8, -1.6, 2],
    ['tulip', -3.8, -0.5, 1], ['tulip', -3.9, 1.6, 1], ['hydrangea', 3.8, 3.0, 2],
    ['hosta', 3.7, -2.4, 2], ['fern', 3.9, -3.6, 2], ['grass', -1.8, -6.5, 2],
    ['vegbed', 0.7, -5.6, 1], ['sunflower', -0.6, -6.7, 0], ['sunflower', -0.1, -6.75, 0],
    ...[-2.9, -2.4, -1.9, -1.4, -0.9].map((x) => ['lavender', x, 4.25, 2]),
  ];
  for (const [type, x, z, age] of examples) {
    addPlant(type, new THREE.Vector3(x, groundHeightAt(x, z, 0), z), { planted: yearsAgo(age), demo: true });
  }
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function animate() {
  if (focusTarget) {
    const d = focusTarget.clone().sub(controls.target).multiplyScalar(0.15);
    controls.target.add(d);
    camera.position.add(d);
    if (d.lengthSq() < 1e-6) focusTarget = null;
  }
  controls.update();
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function start() {
  renderFilters();
  renderPalette();
  applySettings();

  const files = state.scan ? await store.loadScanFiles() : null;
  if (files?.length) await openScanFiles(files, { fromStorage: true });
  else {
    state.scan = null;
    showDemo();
  }

  for (const rec of state.plants) spawnPlant(rec);
  if (!saved) {
    plantDemoExamples();
    showHint('Pick a plant on the left, then click in the garden to plant it');
    setTimeout(() => { if (!placing) hideHint(); }, 7000);
  }
  renderPlacedList();
  renderer.setAnimationLoop(animate);
}

start();
