// The landscaping tool: drawing paths, areas, walls, fences and steps by clicking in the garden,
// selecting them to change material and size, dragging their corner handles to reshape them,
// and dragging the feature itself to move it. Features live in state.features.

import * as THREE from 'three';
import {
  TOOLS, TOOL_BY_ID, SWATCH, materialName, buildFeature, disposeFeature, featureStats, featureLabel, sampleLine,
} from './landscape.js';

const $ = (id) => document.getElementById(id);
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const round = (n) => Math.round(n * 1000) / 1000;

const RANGES = {
  path: { width: [0.4, 3, 0.05, 'Width'] },
  steps: { width: [0.6, 3, 0.05, 'Width'], height: [0.15, 3, 0.01, 'Total rise'] },
  wall: { height: [0.2, 2.4, 0.05, 'Height'] },
  fence: { height: [0.9, 2.4, 0.05, 'Height'] },
};
const rangesFor = (rec) => RANGES[rec.tool] ?? RANGES[rec.type] ?? {};

export function createLandscapeEditor(ctx) {
  const { scene, controls, canvas, raycaster, setRayFromEvent, hitTerrain, groundHeightAt, state, persist, showHint, hideHint } = ctx;
  state.features ??= [];

  const group = new THREE.Group();
  group.name = 'Landscaping';
  scene.add(group);
  const helpers = new THREE.Group();
  helpers.name = 'Landscaping helpers';
  scene.add(helpers);
  const objects = new Map();

  // Ground heights are raycast, so remember them; cleared whenever the ground itself changes.
  let heights = new Map();
  const heightNear = (x, z, nearY) => {
    const key = `${Math.round(x * 20)}|${Math.round(z * 20)}|${Math.round(nearY * 4)}`;
    let h = heights.get(key);
    if (h === undefined) { h = groundHeightAt(x, z, nearY); heights.set(key, h); }
    return h;
  };

  const recordFor = (id) => state.features.find((f) => f.id === id);

  // -------------------------------------------------------------------------
  // Building
  // -------------------------------------------------------------------------

  function spawn(rec) {
    const obj = buildFeature(rec, heightNear);
    group.add(obj);
    objects.set(rec.id, obj);
  }

  function rebuild(rec) {
    const old = objects.get(rec.id);
    if (old) { group.remove(old); disposeFeature(old); }
    spawn(rec);
    if (selected === rec.id) showSelection();
  }

  function rebuildAll() {
    heights = new Map();
    for (const rec of state.features) rebuild(rec);
  }

  function removeLocal(id) {
    const obj = objects.get(id);
    if (obj) { group.remove(obj); disposeFeature(obj); objects.delete(id); }
    state.features = state.features.filter((f) => f.id !== id);
    ctx.stateChanged?.();
    if (selected === id) select(null);
    persist();
    renderList();
  }

  function upsertRemote(rec) {
    const local = recordFor(rec.id);
    if (!local) {
      const added = { ...rec };
      state.features.push(added);
      spawn(added);
    } else {
      if (drag && selected === rec.id) return; // you're reshaping it right now; your version wins
      Object.assign(local, rec);
      rebuild(local);
      if (selected === rec.id) fillPanel();
    }
    renderList();
    persist();
  }

  // -------------------------------------------------------------------------
  // Selection, handles and the inspector panel
  // -------------------------------------------------------------------------

  let selected = null;
  const handleGeo = new THREE.SphereGeometry(1, 16, 10);
  const handleMat = new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: false, transparent: true });
  const handleRing = new THREE.MeshBasicMaterial({ color: '#1f3326', depthTest: false, transparent: true });
  const outlineMat = new THREE.LineBasicMaterial({ color: '#7bc67e', depthTest: false, transparent: true });

  function clearHelpers() {
    for (const o of [...helpers.children]) {
      helpers.remove(o);
      if (o.geometry && o.geometry !== handleGeo) o.geometry.dispose();
    }
  }

  function showSelection() {
    clearHelpers();
    const rec = recordFor(selected);
    if (!rec) return;
    rec.points.forEach((p, i) => {
      const ring = new THREE.Mesh(handleGeo, handleRing);
      const dot = new THREE.Mesh(handleGeo, handleMat);
      dot.scale.setScalar(0.7);
      ring.add(dot);
      ring.position.set(p[0], p[1] + 0.06, p[2]);
      ring.renderOrder = 30;
      dot.renderOrder = 31;
      ring.userData.handle = i;
      helpers.add(ring);
    });
    const closed = rec.type === 'area';
    const line = sampleLine(rec.points, 0.3, rec.curved && rec.type !== 'steps', closed).map((s) => s.p.clone().setY(s.p.y + 0.06));
    const outline = new THREE.Line(new THREE.BufferGeometry().setFromPoints(line), outlineMat);
    outline.renderOrder = 29;
    helpers.add(outline);
  }

  function select(id) {
    selected = id && recordFor(id) ? id : null;
    if (selected) {
      ctx.clearPlantSelection();
      $('scan-panel').classList.add('hidden');
      showSelection();
      fillPanel();
      $('feature-panel').classList.remove('hidden');
    } else {
      clearHelpers();
      $('feature-panel').classList.add('hidden');
    }
    renderList();
  }

  function fillPanel() {
    const rec = recordFor(selected);
    if (!rec) return;
    const { emoji, title } = featureLabel(rec);
    const tool = TOOL_BY_ID[rec.tool] ?? TOOLS.find((t) => t.type === rec.type);
    $('feat-title').textContent = `${emoji} ${title}`;
    $('feat-material').innerHTML = tool.materials.map((m) => `<option value="${m}" ${m === rec.material ? 'selected' : ''}>${materialName(m)}</option>`).join('');
    const r = rangesFor(rec);
    for (const key of ['width', 'height']) {
      const row = $(`feat-${key}-row`);
      row.classList.toggle('hidden', !r[key]);
      if (!r[key]) continue;
      const [min, max, step, label] = r[key];
      const input = $(`feat-${key}`);
      Object.assign(input, { min, max, step });
      input.value = rec[key];
      $(`feat-${key}-label`).textContent = label;
      $(`feat-${key}-out`).textContent = `${(+rec[key]).toFixed(2)} m`;
    }
    $('feat-curved-row').classList.toggle('hidden', rec.type === 'steps' || rec.material === 'decking');
    $('feat-curved').checked = !!rec.curved;
    renderStats(rec);
  }

  function renderStats(rec) {
    $('feat-facts').innerHTML = featureStats(rec).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  function edit(change) {
    const rec = recordFor(selected);
    if (!rec) return;
    change(rec);
    rebuild(rec);
    renderStats(rec);
    renderList();
    persist();
  }

  $('feat-material').addEventListener('change', (e) => edit((rec) => { rec.material = e.target.value; }));
  for (const key of ['width', 'height']) {
    $(`feat-${key}`).addEventListener('input', (e) => {
      $(`feat-${key}-out`).textContent = `${(+e.target.value).toFixed(2)} m`;
      edit((rec) => { rec[key] = parseFloat(e.target.value); });
    });
  }
  $('feat-curved').addEventListener('change', (e) => edit((rec) => { rec.curved = e.target.checked; }));
  $('feat-del').addEventListener('click', () => selected && removeLocal(selected));
  $('feat-close').addEventListener('click', () => select(null));

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------

  let activeTool = null;
  const toolOptions = Object.fromEntries(TOOLS.map((t) => [t.id, { ...t.defaults }]));
  let drawing = null;
  let preview = null;
  let previewQueued = false;

  function startTool(id) {
    if (drawing?.tool.id === id) { cancelDrawing(); return; }
    ctx.beforeDrawing();
    select(null);
    cancelDrawing();
    activeTool = id;
    drawing = { tool: TOOL_BY_ID[id], points: [], cursor: null };
    canvas.style.cursor = 'crosshair';
    if (matchMedia('(max-width: 760px)').matches) $('palette').classList.add('collapsed');
    renderTools();
    updateDrawHint();
  }

  function cancelDrawing() {
    if (!drawing) return;
    drawing = null;
    clearPreview();
    canvas.style.cursor = '';
    hideHint();
    renderTools();
  }

  function draftRecord(withCursor = true) {
    const pts = drawing.points.map((p) => p.toArray());
    if (withCursor && drawing.cursor) pts.push(drawing.cursor.toArray());
    const opts = toolOptions[drawing.tool.id];
    const rec = { id: 'draft', kind: 'feature', type: drawing.tool.type, tool: drawing.tool.id, ...opts, points: pts };
    if (rec.type === 'steps' && pts.length === 2) rec.height = Math.max(0.17, round(pts[1][1] - pts[0][1]));
    return rec;
  }

  const enough = (rec) => rec.points.length >= (rec.type === 'area' ? 3 : 2);

  function clearPreview() {
    if (preview) { scene.remove(preview); disposeFeature(preview); preview = null; }
  }

  function updatePreview() {
    previewQueued = false;
    clearPreview();
    if (!drawing) return;
    const rec = draftRecord();
    const g = new THREE.Group();
    if (enough(rec)) {
      try { g.add(buildFeature(rec, heightNear)); } catch { /* not a valid shape yet */ }
    }
    const linePts = rec.points.map((p) => new THREE.Vector3(p[0], p[1] + 0.08, p[2]));
    if (rec.type === 'area' && linePts.length > 2) linePts.push(linePts[0].clone());
    if (linePts.length > 1) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(linePts), outlineMat);
      line.renderOrder = 29;
      g.add(line);
    }
    for (const p of drawing.points) {
      const dot = new THREE.Mesh(handleGeo, handleMat);
      dot.scale.setScalar(0.08);
      dot.position.set(p.x, p.y + 0.08, p.z);
      dot.renderOrder = 31;
      g.add(dot);
    }
    preview = g;
    scene.add(preview);
    updateDrawHint();
  }

  function queuePreview() {
    if (previewQueued) return;
    previewQueued = true;
    requestAnimationFrame(updatePreview);
  }

  function measureText(rec) {
    if (!enough(rec)) return '';
    const stats = featureStats(rec);
    return stats.slice(0, rec.type === 'steps' ? 2 : 1).map(([k, v]) => `${k} ${v}`).join(' · ');
  }

  function updateDrawHint() {
    if (!drawing) return;
    const rec = draftRecord();
    const t = drawing.tool;
    const how = t.type === 'steps'
      ? (drawing.points.length ? 'Now click the top of the steps' : t.hint)
      : `${t.hint}. ${t.type === 'area' ? 'Click the first corner again' : 'Double-click'} or press <kbd>Enter</kbd> to finish`;
    const measure = measureText(rec);
    showHint(`<span>${how}${measure ? ` · <strong>${measure}</strong>` : ''}</span>
      <span class="hint-buttons">
        ${t.type !== 'steps' ? '<button data-draw="finish" class="primary">Finish</button>' : ''}
        <button data-draw="undo">Undo point</button>
        <button data-draw="cancel">Cancel</button>
      </span>`);
  }

  // Hold Shift to keep segments at 15° steps (handy for straight walls and square patios).
  function snapAngle(p) {
    const last = drawing.points[drawing.points.length - 1];
    if (!last) return p;
    const dx = p.x - last.x, dz = p.z - last.z;
    const len = Math.hypot(dx, dz);
    const step = Math.PI / 12;
    const a = Math.round(Math.atan2(dz, dx) / step) * step;
    const x = last.x + Math.cos(a) * len, z = last.z + Math.sin(a) * len;
    return new THREE.Vector3(x, groundHeightAt(x, z, p.y), z);
  }

  function addPoint(p) {
    const pts = drawing.points;
    if (drawing.tool.type === 'area' && pts.length >= 3 && Math.hypot(p.x - pts[0].x, p.z - pts[0].z) < 0.35) {
      finishDrawing();
      return;
    }
    const last = pts[pts.length - 1];
    if (last && Math.hypot(p.x - last.x, p.z - last.z) < 0.05) return;
    pts.push(p.clone());
    if (drawing.tool.type === 'steps' && pts.length === 2) { finishDrawing(); return; }
    queuePreview();
  }

  function finishDrawing() {
    if (!drawing) return;
    const draft = draftRecord(false);
    if (!enough(draft)) {
      ctx.toast(drawing.tool.type === 'area' ? 'An area needs at least 3 corners.' : 'Click at least 2 points first.');
      return;
    }
    const rec = { ...draft, id: newId(), points: draft.points.map((p) => p.map(round)) };
    if (rec.type === 'steps') rec.height = Math.max(0.17, round(rec.points[1][1] - rec.points[0][1]));
    state.features.push(rec);
    ctx.stateChanged?.();
    spawn(rec);
    cancelDrawing();
    persist();
    select(rec.id);
  }

  $('hint').addEventListener('click', (e) => {
    const action = e.target.closest('[data-draw]')?.dataset.draw;
    if (!action || !drawing) return;
    if (action === 'finish') finishDrawing();
    if (action === 'cancel') cancelDrawing();
    if (action === 'undo') { drawing.points.pop(); queuePreview(); }
  });
  canvas.addEventListener('dblclick', () => { if (drawing) finishDrawing(); });

  // -------------------------------------------------------------------------
  // Pointer input (called from main.js before its own handling)
  // -------------------------------------------------------------------------

  let drag = null;
  let dragQueued = false;
  let lastEvent = null;

  function onPointerDown(e) {
    if (drawing || !selected || e.button !== 0) return false;
    setRayFromEvent(e);
    const rec = recordFor(selected);
    const handleHit = raycaster.intersectObjects(helpers.children.filter((o) => o.userData.handle !== undefined), false)[0];
    if (handleHit) {
      drag = { kind: 'handle', index: handleHit.object.userData.handle };
    } else if (raycaster.intersectObject(objects.get(selected), true).length) {
      const start = hitTerrain();
      if (!start) return false;
      drag = { kind: 'move', start, orig: rec.points.map((p) => [...p]) };
    } else {
      return false;
    }
    controls.enabled = false;
    return true;
  }

  function applyDrag() {
    dragQueued = false;
    if (!drag || !lastEvent) return;
    const rec = recordFor(selected);
    if (!rec) return;
    setRayFromEvent(lastEvent);
    const p = hitTerrain();
    if (!p) return;
    if (drag.kind === 'handle') {
      rec.points[drag.index] = [round(p.x), round(p.y), round(p.z)];
    } else {
      const dx = p.x - drag.start.x, dz = p.z - drag.start.z;
      rec.points = drag.orig.map(([x, y, z]) => [round(x + dx), round(heightNear(x + dx, z + dz, y)), round(z + dz)]);
    }
    rebuild(rec);
    renderStats(rec);
  }

  function onPointerMove(e) {
    if (drag) {
      lastEvent = e;
      if (!dragQueued) { dragQueued = true; requestAnimationFrame(applyDrag); }
      return true;
    }
    if (drawing && e.pointerType !== 'touch') {
      setRayFromEvent(e);
      const p = hitTerrain();
      drawing.cursor = p ? (e.shiftKey ? snapAngle(p) : p) : null;
      queuePreview();
      return true;
    }
    return false;
  }

  function onPointerUp(e, isClick) {
    if (drag) {
      drag = null;
      controls.enabled = true;
      const rec = recordFor(selected);
      if (rec) { renderList(); persist(); }
      return true;
    }
    if (drawing) {
      if (isClick) {
        setRayFromEvent(e);
        const p = hitTerrain();
        if (p) addPoint(e.shiftKey ? snapAngle(p) : p);
      }
      return true;
    }
    return false;
  }

  // Nearest feature under the ray main.js has already set.
  function pick() {
    const hit = raycaster.intersectObject(group, true)[0];
    if (!hit) return null;
    let o = hit.object;
    while (o && !o.userData.featureId) o = o.parent;
    return o ? { id: o.userData.featureId, distance: hit.distance } : null;
  }

  function onKey(e) {
    if (drawing) {
      if (e.key === 'Enter') finishDrawing();
      else if (e.key === 'Escape') cancelDrawing();
      else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); drawing.points.pop(); queuePreview(); }
      else return false;
      return true;
    }
    if (selected) {
      if (e.key === 'Escape') select(null);
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeLocal(selected); }
      else return false;
      return true;
    }
    return false;
  }

  // Keep handles a constant size on screen.
  const _v = new THREE.Vector3();
  function update(camera) {
    for (const h of helpers.children) {
      if (h.userData.handle === undefined) continue;
      h.scale.setScalar(Math.max(0.05, camera.position.distanceTo(h.getWorldPosition(_v)) * 0.011));
    }
  }

  // -------------------------------------------------------------------------
  // Palette UI
  // -------------------------------------------------------------------------

  function renderTools() {
    $('landscape-tools').innerHTML = TOOLS.map((t) => `
      <button class="plant-card ${drawing?.tool.id === t.id ? 'active' : ''}" data-ltool="${t.id}">
        <span class="swatch">${t.emoji}</span><span class="name">${t.name}</span>
      </button>`).join('');
    const opts = $('landscape-options');
    const id = drawing?.tool.id ?? activeTool;
    if (!id) { opts.classList.add('hidden'); return; }
    const t = TOOL_BY_ID[id];
    const o = toolOptions[id];
    const r = RANGES[id] ?? RANGES[t.type] ?? {};
    opts.classList.remove('hidden');
    opts.innerHTML = `
      <h3>${t.name}: material</h3>
      <div class="material-chips">${t.materials.map((m) => `
        <button data-lmat="${m}" class="${m === o.material ? 'active' : ''}"><i style="background:${SWATCH[m]}"></i>${materialName(m)}</button>`).join('')}
      </div>
      ${r.width ? `<label>${r.width[3]} <output>${o.width.toFixed(2)} m</output><input type="range" data-lopt="width" min="${r.width[0]}" max="${r.width[1]}" step="${r.width[2]}" value="${o.width}" /></label>` : ''}
      ${r.height && t.type !== 'steps' ? `<label>${r.height[3]} <output>${o.height.toFixed(2)} m</output><input type="range" data-lopt="height" min="${r.height[0]}" max="${r.height[1]}" step="${r.height[2]}" value="${o.height}" /></label>` : ''}
      ${t.type !== 'steps' ? `<label class="check"><input type="checkbox" data-lopt="curved" ${o.curved ? 'checked' : ''} /> Smooth curves</label>` : ''}
      <p class="muted small">${drawing ? 'Drawing… hold <kbd>Shift</kbd> to keep lines at neat angles.' : 'Pick the tool again to draw another.'}</p>`;
  }

  $('landscape-tools').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ltool]');
    if (b) startTool(b.dataset.ltool);
  });
  $('landscape-options').addEventListener('click', (e) => {
    const b = e.target.closest('[data-lmat]');
    const id = drawing?.tool.id ?? activeTool;
    if (!b || !id) return;
    toolOptions[id].material = b.dataset.lmat;
    renderTools();
    if (drawing) queuePreview();
  });
  $('landscape-options').addEventListener('input', (e) => {
    const key = e.target.dataset.lopt;
    const id = drawing?.tool.id ?? activeTool;
    if (!key || !id) return;
    toolOptions[id][key] = key === 'curved' ? e.target.checked : parseFloat(e.target.value);
    const out = e.target.parentElement.querySelector('output');
    if (out) out.textContent = `${(+e.target.value).toFixed(2)} m`;
    if (drawing) queuePreview();
  });

  function renderList() {
    const list = $('feature-list');
    $('feature-count').textContent = state.features.length ? `(${state.features.length})` : '';
    list.innerHTML = state.features.map((f) => {
      const { emoji, title, material } = featureLabel(f);
      const stat = featureStats(f)[0];
      return `<li data-feature="${f.id}" class="${f.id === selected ? 'selected' : ''}">
        <span>${emoji}</span><span>${title}<small class="muted"> · ${material}</small></span><span class="count">${stat[1]}</span></li>`;
    }).join('') || '<li class="empty">Nothing built yet.</li>';
  }

  $('feature-list').addEventListener('click', (e) => {
    const li = e.target.closest('[data-feature]');
    if (!li) return;
    cancelDrawing();
    select(li.dataset.feature);
    const rec = recordFor(li.dataset.feature);
    if (rec) ctx.focusOn(new THREE.Vector3(...rec.points[0]));
  });

  renderTools();
  renderList();

  return {
    group, helpers,
    get selected() { return selected; },
    get drawing() { return !!drawing; },
    meshes: () => { const out = []; group.traverse((o) => { if (o.isMesh) out.push(o); }); return out; },
    spawnAll: () => { rebuildAll(); renderList(); },
    rebuildAll, removeLocal, upsertRemote, select, cancelDrawing, pick, update,
    onPointerDown, onPointerMove, onPointerUp, onKey, renderList,
    clearAll: () => { for (const f of [...state.features]) removeLocal(f.id); },
    hidePreview: () => { if (preview) preview.visible = false; },
  };
}
