// Printable 2D landscape plan (PDF): a scaled, north-up drawing of the garden with the scan as a
// faded aerial underlay, landscaping drawn as vector shapes with material hatches, plant symbols at
// mature spread, dimensions, plant and landscaping schedules, a scale bar, north arrow and title block.
// jsPDF and the font are only downloaded when a plan is made.

import * as THREE from 'three';
import { SURFACES, WALLS, STEP_STYLES, SWATCH, TOOL_BY_ID, TOOLS, materialName, sampleLine, featureStats } from './landscape.js';
import { PLANT_BY_ID, CATEGORIES } from './plants.js';

const JSPDF_URL = 'https://cdn.jsdelivr.net/npm/jspdf@4.2.1/+esm';
const FONT_BASE = 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/';
const FONTS = { normal: 'DejaVuSansCondensed.ttf', bold: 'DejaVuSansCondensed-Bold.ttf' };

// Landscape sheet sizes in mm.
export const PAPER = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594] };
export const SCALES = [20, 25, 50, 75, 100, 125, 200, 250, 500, 1000, 2000];
export const PLAN_DEFAULTS = {
  title: '', client: '', site: '', designer: '', revision: 'A', notes: '',
  paper: 'A3', scale: 'auto', fit: 'design', underlay: 'faded', dims: true, view3d: true,
};

const MARGIN = 10;
const SIDEBAR = { A4: 78, A3: 96, A2: 110, A1: 124 };
const DPI = 150;
const PT = 0.3528; // mm per point
const INK = '#1f2a24';
const GREY = '#6b746e';
const LINE = '#9aa39d';
const CATEGORY_COLOR = {
  'NZ natives': '#2f6b2a', Trees: '#1f6b3a', Shrubs: '#5b8f2a', Flowers: '#b0306a', Foliage: '#1f7a6e', Edible: '#d06a12',
};

// ---------------------------------------------------------------------------
// Loading jsPDF and the font (cached for the session)
// ---------------------------------------------------------------------------

let libPromise = null;
function loadLibs() {
  libPromise ??= (async () => {
    const { jsPDF } = await import(JSPDF_URL);
    const fonts = {};
    try {
      await Promise.all(Object.entries(FONTS).map(async ([style, file]) => {
        const res = await fetch(FONT_BASE + file);
        if (!res.ok) throw new Error(`font ${res.status}`);
        fonts[style] = toBase64(await res.arrayBuffer());
      }));
    } catch (err) {
      console.warn('Plan font unavailable, using Helvetica', err);
      return { jsPDF, fonts: null };
    }
    return { jsPDF, fonts };
  })();
  libPromise.catch(() => { libPromise = null; });
  return libPromise;
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------------------------------------------------------------------------
// Small geometry helpers. "Plan" coordinates are metres east (e) and north (n).
// ---------------------------------------------------------------------------

function planFrame(northDeg) {
  const a = (northDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return {
    // world (x, z) -> plan [east, north]; the matrix is its own inverse.
    toPlan: (x, z) => [x * c + z * s, x * s - z * c],
    toWorld: (e, n) => [e * c + n * s, e * s - n * c],
    north: new THREE.Vector3(s, 0, -c),
  };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const len = (a) => Math.hypot(a[0], a[1]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
const left = (a) => [-a[1], a[0]];

// Offset a polyline sideways by `dist` (positive = left of travel), with mitred corners.
function offsetLine(pts, dist, closed = false) {
  const n = pts.length;
  const segN = [];
  for (let i = 0; i < n - (closed ? 0 : 1); i++) segN.push(left(norm(sub(pts[(i + 1) % n], pts[i]))));
  return pts.map((p, i) => {
    const before = segN[i - 1] ?? (closed ? segN[segN.length - 1] : null);
    const after = segN[i] ?? (closed ? segN[0] : null);
    if (!before || !after) return add(p, mul(before ?? after, dist));
    const m = norm(add(before, after));
    const k = 1 / Math.max(0.35, m[0] * after[0] + m[1] * after[1]);
    return add(p, mul(m, dist * k));
  });
}

function pointInPolygon([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function centroid(poly) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-9) return poly[0];
  const c = [cx / (3 * a), cy / (3 * a)];
  if (pointInPolygon(c, poly)) return c;
  // Concave shape whose centroid falls outside: use the middle of the widest horizontal span instead.
  const ys = poly.map((p) => p[1]);
  const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
  const xs = [];
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length];
    if ((y0 > midY) !== (y1 > midY)) xs.push(x0 + ((midY - y0) / (y1 - y0)) * (x1 - x0));
  }
  xs.sort((p, q) => p - q);
  let best = null;
  for (let i = 0; i + 1 < xs.length; i += 2) if (!best || xs[i + 1] - xs[i] > best[1] - best[0]) best = [xs[i], xs[i + 1]];
  return best ? [(best[0] + best[1]) / 2, midY] : c;
}

// ---------------------------------------------------------------------------
// Turning the garden into plan shapes
// ---------------------------------------------------------------------------

function featureShapes(rec, toPlan) {
  const P = (p) => toPlan(p[0], p[2]);
  if (rec.type === 'area') {
    const pts = rec.curved && rec.points.length >= 3
      ? sampleLine(rec.points, 0.15, true, true).slice(0, -1).map((s) => P(s.p.toArray()))
      : rec.points.map(P);
    return { outline: pts, corners: rec.curved ? null : rec.points.map(P) };
  }
  if (rec.type === 'path' || rec.type === 'wall') {
    const line = (rec.curved && rec.points.length >= 3 ? sampleLine(rec.points, 0.15, true) : sampleLine(rec.points, 1e6, false))
      .map((s) => P(s.p.toArray()));
    const half = rec.type === 'path' ? rec.width / 2 : (WALLS[rec.material]?.t ?? 0.2) / 2;
    const L = offsetLine(line, half), R = offsetLine(line, -half);
    return { line, half, outline: [...L, ...R.reverse()], corners: rec.curved ? null : rec.points.map(P) };
  }
  // Steps: a rectangle from the bottom point towards the top, one tread per going.
  const [b, t] = rec.points.map(P);
  const dir = norm(sub(t, b));
  const run = Math.max(0.3, len(sub(t, b)));
  const n = Math.max(1, Math.round(Math.max(0.1, rec.height) / 0.17));
  const going = Math.max(run / n, 0.25);
  const side = mul(left(dir), rec.width / 2);
  const end = add(b, mul(dir, going * n));
  return { outline: [add(b, side), add(end, side), sub(end, side), sub(b, side)], b, dir, going, n, side };
}

function planBounds(items) {
  const box = { minE: Infinity, maxE: -Infinity, minN: Infinity, maxN: -Infinity };
  const grow = ([e, n], r = 0) => {
    box.minE = Math.min(box.minE, e - r); box.maxE = Math.max(box.maxE, e + r);
    box.minN = Math.min(box.minN, n - r); box.maxN = Math.max(box.maxN, n + r);
  };
  for (const [p, r] of items) grow(p, r);
  return Number.isFinite(box.minE) ? box : null;
}

// ---------------------------------------------------------------------------
// The PDF
// ---------------------------------------------------------------------------

/**
 * Make the plan and return it as a Blob.
 * ctx: { features, plants, northDeg, terrainBox (THREE.Box3), pointSize,
 *        renderTopDown(camera, w, h, { design, pointPx }) -> canvas, renderView(w, h) -> canvas,
 *        viewCaption }
 */
export async function makePlanPDF(ctx, options) {
  const opts = { ...PLAN_DEFAULTS, ...options };
  const { jsPDF, fonts } = await loadLibs();
  const [pw, ph] = PAPER[opts.paper] ?? PAPER.A3;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [pw, ph], compress: true });
  const fontName = fonts ? 'DejaVu' : 'helvetica';
  if (fonts) {
    for (const [style, file] of Object.entries(FONTS)) {
      doc.addFileToVFS(file, fonts[style]);
      doc.addFont(file, 'DejaVu', style);
    }
  }
  // Without the embedded font, Helvetica can't show macrons: write "Pohutukawa" rather than garbage.
  const T = fonts ? (s) => String(s ?? '') : (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const font = (size, bold = false, color = INK) => {
    doc.setFont(fontName, bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(color);
  };
  const lineH = (size) => size * PT * 1.22;
  const opacity = (o) => doc.setGState(new doc.GState({ opacity: o, 'stroke-opacity': o }));

  const path = (pts, closed = true) => {
    pts.forEach((p, i) => (i ? doc.lineTo(p[0], p[1]) : doc.moveTo(p[0], p[1])));
    if (closed) doc.close();
  };

  const { toPlan, toWorld, north } = planFrame(opts.northDeg ?? ctx.northDeg ?? 0);
  const printDate = (iso) => {
    const d = iso ? new Date(`${iso}T12:00:00`) : new Date();
    return Number.isNaN(+d) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const today = printDate(opts.date);

  // ----- What goes on the plan -----
  const features = ctx.features.filter((f) => f.points?.length >= (f.type === 'area' ? 3 : 2));
  const shapes = new Map(features.map((f) => [f.id, featureShapes(f, toPlan)]));
  const refs = new Map(features.map((f, i) => [f.id, `L${i + 1}`]));

  const species = [...new Set(ctx.plants.map((p) => p.type))]
    .filter((id) => PLANT_BY_ID[id])
    .sort((a, b) => {
      const A = PLANT_BY_ID[a], B = PLANT_BY_ID[b];
      return CATEGORIES.indexOf(A.category) - CATEGORIES.indexOf(B.category) || A.name.localeCompare(B.name);
    });
  const plantKey = new Map(species.map((id, i) => [id, i + 1]));
  const plants = ctx.plants.filter((p) => plantKey.has(p.type)).map((rec) => {
    const def = PLANT_BY_ID[rec.type];
    return { rec, def, at: toPlan(rec.position[0], rec.position[2]), r: (def.spread / 2) * (rec.size ?? 1) };
  });

  // ----- Extents and scale -----
  const designItems = [
    ...[...shapes.values()].flatMap((s) => s.outline.map((p) => [p, 0])),
    ...plants.map((p) => [p.at, p.r]),
  ];
  const tb = ctx.terrainBox;
  const terrainItems = tb && !tb.isEmpty()
    ? [[tb.min.x, tb.min.z], [tb.min.x, tb.max.z], [tb.max.x, tb.min.z], [tb.max.x, tb.max.z]].map(([x, z]) => [toPlan(x, z), 0])
    : [];
  let ext = planBounds(opts.fit === 'scan' || !designItems.length ? terrainItems : designItems) ?? planBounds(designItems)
    ?? { minE: -5, maxE: 5, minN: -5, maxN: 5 };
  const pad = opts.fit === 'scan' ? 0.2 : 1;
  ext = { minE: ext.minE - pad, maxE: ext.maxE + pad, minN: ext.minN - pad, maxN: ext.maxN + pad };

  const side = SIDEBAR[opts.paper] ?? SIDEBAR.A3;
  const area = { x: MARGIN, y: MARGIN, w: pw - 2 * MARGIN - side - 4, h: ph - 2 * MARGIN };
  const innerW = area.w - 16, innerH = area.h - 16; // room for dimensions round the edge
  const extW = ext.maxE - ext.minE, extH = ext.maxN - ext.minN;
  const needed = 1000 * Math.max(extW / innerW, extH / innerH);
  let scale = opts.scale === 'auto' ? (SCALES.find((s) => s >= needed) ?? SCALES[SCALES.length - 1]) : +opts.scale;
  const k = 1000 / scale; // paper mm per metre
  const fits = needed <= scale;
  const centre = [(ext.minE + ext.maxE) / 2, (ext.minN + ext.maxN) / 2];
  const cx = area.x + area.w / 2, cy = area.y + area.h / 2;
  const toPaper = ([e, n]) => [cx + (e - centre[0]) * k, cy - (n - centre[1]) * k];

  // ----- Sheet frame -----
  const sheets = [];
  const newSheet = (label) => {
    if (sheets.length) doc.addPage([pw, ph], 'landscape');
    doc.setDrawColor(INK);
    doc.setLineWidth(0.5);
    doc.rect(MARGIN - 3, MARGIN - 3, pw - 2 * MARGIN + 6, ph - 2 * MARGIN + 6);
    sheets.push({ label });
    return sheets.length;
  };
  newSheet('Plan');

  // ----- Underlay -----
  const viewW = area.w / k, viewH = area.h / k;
  if (opts.underlay !== 'none' && ctx.renderTopDown) {
    const maxPx = Math.min(4096, ctx.maxTexture ?? 4096);
    let px = Math.round((area.w / 25.4) * DPI), py = Math.round((area.h / 25.4) * DPI);
    const shrink = Math.min(1, maxPx / Math.max(px, py));
    px = Math.max(64, Math.round(px * shrink)); py = Math.max(64, Math.round(py * shrink));
    const [wx, wz] = toWorld(centre[0], centre[1]);
    const top = (tb && !tb.isEmpty() ? tb.max.y : 10) + 30;
    const depth = top - (tb && !tb.isEmpty() ? tb.min.y : -10) + 30;
    const cam = new THREE.OrthographicCamera(-viewW / 2, viewW / 2, viewH / 2, -viewH / 2, 0.1, depth);
    cam.position.set(wx, top, wz);
    cam.up.copy(north);
    cam.lookAt(wx, 0, wz);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const pointPx = Math.max(1.5, (ctx.pointSize ?? 0.015) * (px / viewW) * 1.6);
    const canvas = ctx.renderTopDown(cam, px, py, { design: opts.underlay === 'render', pointPx, background: '#ffffff' });
    doc.addImage(canvas.toDataURL('image/jpeg', 0.85), 'JPEG', area.x, area.y, area.w, area.h, undefined, 'FAST');
    if (opts.underlay === 'faded') {
      doc.saveGraphicsState();
      opacity(0.5);
      doc.setFillColor('#ffffff');
      doc.rect(area.x, area.y, area.w, area.h, 'F');
      doc.restoreGraphicsState();
    }
  }

  // ----- Drawing, clipped to the drawing area -----
  doc.saveGraphicsState();
  doc.rect(area.x, area.y, area.w, area.h, null);
  doc.clip();
  doc.discardPath();
  doc.setLineJoin('round');
  doc.setLineCap('round');

  const vectorFill = opts.underlay !== 'render';
  const drawOrder = { bed: 0, area: 1, path: 2, steps: 3, wall: 4, fence: 5 };
  const sorted = [...features].sort((a, b) => (drawOrder[a.tool] ?? 3) - (drawOrder[b.tool] ?? 3));
  for (const rec of sorted) {
    const s = shapes.get(rec.id);
    if (rec.type === 'area' || rec.type === 'path') drawSurface(rec, s);
    else if (rec.type === 'wall') drawWall(rec, s);
    else drawSteps(rec, s);
  }

  // Plants: mature spread circles, trees last so their outlines stay on top.
  const plantOrder = [...plants].sort((a, b) => a.r - b.r).reverse();
  for (const p of plantOrder) {
    const c = toPaper(p.at), r = Math.max(0.8, p.r * k);
    const color = CATEGORY_COLOR[p.def.category] ?? '#2f6b2a';
    doc.setDrawColor(color);
    doc.setLineWidth(0.25);
    if (vectorFill) {
      doc.saveGraphicsState();
      opacity(0.22);
      doc.setFillColor(color);
      doc.circle(c[0], c[1], r, 'F');
      doc.restoreGraphicsState();
    }
    doc.circle(c[0], c[1], r, 'S');
    // Trunk / centre mark
    doc.setLineWidth(0.15);
    const m = Math.min(1.2, r * 0.35);
    doc.line(c[0] - m, c[1], c[0] + m, c[1]);
    doc.line(c[0], c[1] - m, c[0], c[1] + m);
  }

  // Dimensions and labels go on top of everything.
  if (opts.dims) for (const rec of features) drawDims(rec, shapes.get(rec.id));
  const taken = []; // boxes already holding a label: plant badges first, then feature tags dodge them
  for (const p of plants) {
    const c = toPaper(p.at);
    const color = CATEGORY_COLOR[p.def.category] ?? '#2f6b2a';
    const key = String(plantKey.get(p.rec.type));
    font(6, true, '#ffffff');
    const rr = Math.max(1.5, doc.getTextWidth(key) / 2 + 0.7);
    doc.setFillColor(color);
    doc.setDrawColor('#ffffff');
    doc.setLineWidth(0.25);
    doc.circle(c[0], c[1], rr, 'FD');
    doc.text(key, c[0], c[1], { align: 'center', baseline: 'middle' });
    taken.push({ x0: c[0] - rr, x1: c[0] + rr, y0: c[1] - rr, y1: c[1] + rr });
  }
  for (const rec of features) drawFeatureTag(rec, shapes.get(rec.id), taken);
  doc.restoreGraphicsState();

  doc.setDrawColor(INK);
  doc.setLineWidth(0.3);
  doc.rect(area.x, area.y, area.w, area.h);
  if (!fits) {
    font(7, true, '#b3261e');
    doc.text(T(`Part of the design is outside the drawing at 1:${scale}. Try a larger scale or paper size.`), area.x + 3, area.y + area.h - 3);
  }

  // ----- Sidebar -----
  const sx = area.x + area.w + 4, sw = side;
  let y = MARGIN + 2;
  font(13, true);
  for (const l of doc.splitTextToSize(T(opts.title || 'Garden plan'), sw)) { y += lineH(13); doc.text(l, sx, y); }
  font(8, false, GREY);
  y += lineH(8) + 0.5;
  doc.text(T('Landscape plan'), sx, y);
  y += 2;
  if (opts.notes?.trim()) {
    font(6.5, false, INK);
    for (const l of doc.splitTextToSize(T(opts.notes.trim()), sw)) { y += lineH(6.5); doc.text(l, sx, y); }
    y += 1;
  }
  y += 3;

  // Bottom block: scale bar + north arrow, then the title block table.
  const titleRows = [
    ['Client', opts.client], ['Site', opts.site], ['Designer', opts.designer], ['Date', today],
    ['Revision', opts.revision], ['Scale', `1:${scale} at ${opts.paper}`], ['Sheet', '__SHEET__'],
  ];
  font(6.5);
  const rowHeights = titleRows.map(([, v]) => Math.max(5, doc.splitTextToSize(T(v || '–'), sw - 20).length * lineH(6.5) + 2));
  const tableH = rowHeights.reduce((a, b) => a + b, 0);
  const tableY = ph - MARGIN - tableH;
  const scaleY = tableY - 24;
  drawNorthAndScale(sx, scaleY, sw);
  const sheetCells = [];
  drawTitleTable(sx, tableY, sw, titleRows, rowHeights, sheetCells);

  // ----- Schedules, flowing on to extra sheets when the sidebar fills up -----
  const regions = [{ page: 1, x: sx, y, w: sw, bottom: scaleY - 4 }];
  const nextRegion = (() => {
    let cols = [];
    return () => {
      if (!cols.length) {
        newSheet('Schedules');
        font(12, true);
        doc.text(T(`${opts.title || 'Garden plan'}: schedules`), MARGIN + 2, MARGIN + 6);
        const top = MARGIN + 12, bottom = ph - MARGIN - 12;
        const n = opts.paper === 'A4' ? 2 : 3, gap = 8;
        const cw = (pw - 2 * MARGIN - 4 - gap * (n - 1)) / n;
        cols = Array.from({ length: n }, (_, i) => ({ page: sheets.length, x: MARGIN + 2 + i * (cw + gap), y: top, w: cw, bottom }));
        sheetFooter();
      }
      const r = cols.shift();
      doc.setPage(r.page);
      return r;
    };
  })();
  const sheetFooter = () => {
    font(6.5, false, GREY);
    const label = [opts.title || 'Garden plan', opts.client, opts.site, today].filter(Boolean).join('  ·  ');
    doc.text(T(label), MARGIN + 2, ph - MARGIN - 3);
    sheetCells.push({ page: sheets.length, x: pw - MARGIN - 2, y: ph - MARGIN - 3, align: 'right' });
  };
  let region = regions[0];
  const flow = makeTableFlow();

  flow.heading('Landscaping schedule');
  if (features.length) {
    flow.table(
      [{ title: 'Ref', w: 0.13 }, { title: 'Item', w: 0.33 }, { title: 'Size', w: 0.24 }, { title: 'Quantity', w: 0.30 }],
      features.map((rec) => {
        const tool = TOOL_BY_ID[rec.tool] ?? TOOLS.find((t) => t.type === rec.type);
        const stats = featureStats(rec);
        const need = stats.find(([kk]) => kk === 'You need')?.[1];
        let size, qty;
        if (rec.type === 'steps') {
          size = stats.filter(([kk]) => kk === 'Total rise' || kk === 'Run').map(([kk, v]) => `${kk.toLowerCase()} ${v}`).join(', ') + `, ${rec.width.toFixed(1)} m wide`;
          qty = stats.filter(([kk]) => ['Steps', 'Riser', 'Tread'].includes(kk)).map(([kk, v]) => (kk === 'Steps' ? `${v} step${v === '1' ? '' : 's'}` : `${kk.toLowerCase()} ${v}`)).join(', ');
        } else {
          size = stats.filter(([kk]) => kk !== 'You need' && kk !== 'Edge').map(([, v]) => v).join(', ');
          if (rec.type === 'path') size += `, ${rec.width.toFixed(1)} m wide`;
          if (rec.type === 'area' && rec.material === 'decking') size += ', raised';
          qty = need ?? '';
        }
        return {
          swatch: SWATCH[rec.material] ?? '#999999',
          cells: [[{ text: refs.get(rec.id), bold: true }], [{ text: tool.name, bold: true }, { text: materialName(rec.material), color: GREY }], [{ text: size }], [{ text: qty }]],
        };
      }),
    );
  } else flow.note('No landscaping yet.');
  flow.gap(4);
  flow.heading('Plant schedule');
  if (species.length) {
    flow.table(
      [{ title: 'No.', w: 0.11 }, { title: 'Plant', w: 0.5 }, { title: 'Qty', w: 0.11, align: 'right' }, { title: 'Mature H × W', w: 0.28 }],
      species.map((id) => {
        const def = PLANT_BY_ID[id];
        const n = plants.filter((p) => p.rec.type === id).length;
        return {
          dot: CATEGORY_COLOR[def.category],
          cells: [
            [{ text: String(plantKey.get(id)), bold: true }],
            [{ text: def.name, bold: true }, ...(def.latin ? [{ text: def.latin, color: GREY }] : [])],
            [{ text: String(n) }],
            [{ text: `${fmtM(def.height)} × ${fmtM(def.spread)}` }],
          ],
        };
      }),
    );
    flow.note(`${plants.length} plants in total. Circles show each plant's mature spread.`);
  } else flow.note('No plants yet.');

  // ----- 3D view sheet -----
  if (opts.view3d && ctx.renderView) {
    const n = newSheet('3D view');
    const box = { x: MARGIN, y: MARGIN, w: pw - 2 * MARGIN, h: ph - 2 * MARGIN - 10 };
    const maxPx = Math.min(4096, ctx.maxTexture ?? 4096);
    const aspect = ctx.viewAspect ?? box.w / box.h;
    let w = box.w, h = w / aspect;
    if (h > box.h) { h = box.h; w = h * aspect; }
    let px = Math.round((w / 25.4) * DPI), py = Math.round((h / 25.4) * DPI);
    const shrink = Math.min(1, maxPx / Math.max(px, py));
    px = Math.round(px * shrink); py = Math.round(py * shrink);
    const canvas = ctx.renderView(px, py);
    doc.setPage(n);
    doc.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG', box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h, undefined, 'FAST');
    font(9, true);
    doc.text(T(`3D view${ctx.viewCaption ? `: ${ctx.viewCaption}` : ''}`), MARGIN + 2, ph - MARGIN - 3);
    sheetFooterRightOnly(n);
  }

  // Sheet numbers, now that we know how many there are.
  const total = sheets.length;
  for (const cell of sheetCells) {
    doc.setPage(cell.page);
    font(cell.align ? 6.5 : 7, false, cell.align ? GREY : INK);
    doc.text(`Sheet ${cell.page} of ${total}`, cell.x, cell.y, cell.align ? { align: 'right' } : undefined);
  }
  doc.setPage(1);
  doc.setProperties({ title: T(opts.title || 'Garden plan'), subject: 'Landscape plan', creator: 'Garden Builder' });
  return { blob: doc.output('blob'), scale, fits, sheets: total };

  // =========================================================================
  // Drawing helpers (hoisted; they close over doc, k, toPaper, etc.)
  // =========================================================================

  function fmtM(v) { return `${(+v).toFixed(v < 10 ? 1 : 0)} m`; }

  function sheetFooterRightOnly(page) {
    sheetCells.push({ page, x: pw - MARGIN - 2, y: ph - MARGIN - 3, align: 'right' });
  }

  function drawSurface(rec, s) {
    const poly = s.outline.map(toPaper);
    const color = SWATCH[rec.material] ?? '#999999';
    if (rec.material === 'stepping') {
      // Stepping stones: draw the stones themselves along the line.
      const stone = Math.min(0.32, rec.width * 0.32);
      const pitch = stone * 2 + 0.18;
      const total = s.line.reduce((d, p, i) => d + (i ? len(sub(p, s.line[i - 1])) : 0), 0);
      doc.setDrawColor('#4a4740');
      doc.setFillColor(lighten(color, vectorFill ? 0.35 : 0.6));
      doc.setLineWidth(0.2);
      for (let d = pitch / 2; d < total; d += pitch) {
        const c = toPaper(alongLine(s.line, d)[0]);
        doc.ellipse(c[0], c[1], stone * k, stone * 0.8 * k, vectorFill ? 'FD' : 'S');
      }
      return;
    }
    if (vectorFill) {
      doc.saveGraphicsState();
      opacity(rec.material === 'lawn' || rec.material === 'soil' || rec.material === 'bark' ? 0.55 : 0.75);
      doc.setFillColor(lighten(color, rec.material === 'soil' || rec.material === 'bark' ? 0.45 : 0.3));
      path(poly);
      doc.fill();
      doc.restoreGraphicsState();
      hatch(rec.material, poly);
    }
    doc.setDrawColor(darken(color, 0.35));
    doc.setLineWidth(rec.material === 'lawn' ? 0.2 : 0.3);
    path(poly);
    doc.stroke();
  }

  function drawWall(rec, s) {
    const def = WALLS[rec.material];
    const color = SWATCH[rec.material] ?? '#777777';
    if (rec.tool === 'fence' || def?.centered) {
      const line = s.line.map(toPaper);
      doc.setDrawColor(darken(color, 0.45));
      doc.setLineWidth(Math.max(0.35, def.t * k));
      path(line, false);
      doc.stroke();
      const total = s.line.reduce((d, p, i) => d + (i ? len(sub(p, s.line[i - 1])) : 0), 0);
      const count = Math.max(1, Math.round(total / (def.posts ?? 2.4)));
      const post = Math.max(0.9, 0.1 * k);
      doc.setFillColor(darken(color, 0.55));
      for (let i = 0; i <= count; i++) {
        const c = toPaper(alongLine(s.line, (i / count) * total)[0]);
        doc.rect(c[0] - post / 2, c[1] - post / 2, post, post, 'F');
      }
      return;
    }
    const poly = s.outline.map(toPaper);
    doc.setFillColor(darken(color, 0.15));
    doc.setDrawColor(INK);
    doc.setLineWidth(0.2);
    if (s.half * 2 * k < 0.6) {
      doc.setDrawColor(darken(color, 0.3));
      doc.setLineWidth(0.6);
      path(s.line.map(toPaper), false);
      doc.stroke();
      return;
    }
    path(poly);
    doc.fillStroke();
  }

  function drawSteps(rec, s) {
    const style = STEP_STYLES[rec.material];
    const poly = s.outline.map(toPaper);
    const color = SWATCH[style ? rec.material : 'timber'] ?? '#999999';
    if (vectorFill) {
      doc.setFillColor(lighten(color, 0.45));
      path(poly);
      doc.fill();
    }
    doc.setDrawColor(INK);
    doc.setLineWidth(0.25);
    path(poly);
    doc.stroke();
    doc.setLineWidth(0.15);
    for (let i = 1; i < s.n; i++) {
      const m = add(s.b, mul(s.dir, s.going * i));
      const a = toPaper(add(m, s.side)), b = toPaper(sub(m, s.side));
      doc.line(a[0], a[1], b[0], b[1]);
    }
    // Arrow pointing up the flight, labelled UP.
    const from = toPaper(add(s.b, mul(s.dir, s.going * 0.3)));
    const to = toPaper(add(s.b, mul(s.dir, s.going * (s.n - 0.25))));
    doc.setLineWidth(0.25);
    doc.line(from[0], from[1], to[0], to[1]);
    const d = norm(sub(to, from)), l = left(d);
    const head = 1.4;
    doc.setFillColor(INK);
    doc.triangle(to[0], to[1], to[0] - d[0] * head + l[0] * head * 0.5, to[1] - d[1] * head + l[1] * head * 0.5,
      to[0] - d[0] * head - l[0] * head * 0.5, to[1] - d[1] * head - l[1] * head * 0.5, 'F');
    font(5.5, true);
    const lab = add(from, mul(left(d), 1.6));
    doc.text('UP', lab[0], lab[1], { align: 'center', baseline: 'middle' });
  }

  // Material hatches, drawn at real size so pavers and boards read correctly at scale.
  function hatch(material, poly) {
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    const lines = (spacing, vertical, offsetEvery = 0, segment = 0) => {
      if (spacing * k < 0.9) return;
      const s = spacing * k;
      if (!vertical) {
        for (let y = box.y0 + s; y < box.y1; y += s) doc.line(box.x0, y, box.x1, y);
        return;
      }
      if (!segment) {
        for (let x = box.x0 + s; x < box.x1; x += s) doc.line(x, box.y0, x, box.y1);
        return;
      }
      // Running bond: short vertical joints, staggered every other course.
      const rowH = segment * k;
      let row = 0;
      for (let y = box.y0; y < box.y1; y += rowH, row++) {
        const shift = row % 2 ? s * offsetEvery : 0;
        for (let x = box.x0 + shift; x < box.x1; x += s) doc.line(x, y, x, Math.min(box.y1, y + rowH));
      }
    };
    const dots = (color, perMm2, size) => {
      const areaMm = (box.x1 - box.x0) * (box.y1 - box.y0);
      const n = Math.min(5000, Math.round(areaMm * perMm2));
      let seed = 1;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      doc.setFillColor(color);
      for (let i = 0; i < n; i++) {
        const p = [box.x0 + rnd() * (box.x1 - box.x0), box.y0 + rnd() * (box.y1 - box.y0)];
        if (pointInPolygon(p, poly)) doc.circle(p[0], p[1], size * (0.6 + rnd() * 0.8), 'F');
      }
    };
    doc.saveGraphicsState();
    path(poly);
    doc.clip();
    doc.discardPath();
    doc.setDrawColor(darken(SWATCH[material] ?? '#888888', 0.3));
    doc.setLineWidth(0.08);
    if (material === 'pavers') { lines(0.4, false); lines(0.4, true); }
    else if (material === 'brick') { lines(0.115, false); lines(0.23, true, 0.5, 0.115); }
    else if (material === 'decking') lines(0.14, false);
    else if (material === 'concrete') dots('#8d877c', 0.12, 0.08);
    else if (material === 'gravel') dots('#7d7464', 0.35, 0.09);
    else if (material === 'scoria') dots('#5a2a20', 0.35, 0.1);
    else if (material === 'lawn') dots('#3f6e2a', 0.25, 0.07);
    else if (material === 'flagstone') {
      // Irregular stone joints: a jittered grid.
      const s = 0.55 * k;
      if (s > 1) {
        let seed = 7;
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        for (let y = box.y0; y < box.y1; y += s) {
          const jitter = (rnd() - 0.5) * s * 0.4;
          doc.line(box.x0, y + jitter, box.x1, y - jitter);
          for (let x = box.x0 + rnd() * s; x < box.x1; x += s * (0.7 + rnd() * 0.6)) doc.line(x, y, x + (rnd() - 0.5) * s * 0.3, y + s);
        }
      }
    }
    doc.restoreGraphicsState();
  }

  // A tagged label for each feature: "L3", plus the area for paving, beds and lawns.
  function drawFeatureTag(rec, s, taken) {
    let at;
    if (rec.type === 'area') at = toPaper(centroid(s.outline));
    else if (rec.type === 'steps') at = toPaper(add(add(s.b, mul(s.dir, s.going * s.n * 0.5)), mul(s.side, -1.4)));
    else {
      const total = s.line.reduce((d, p, i) => d + (i ? len(sub(p, s.line[i - 1])) : 0), 0);
      const [p, dir] = alongLine(s.line, total / 2);
      const off = rec.type === 'wall' ? s.half + 5 / k : 0;
      at = toPaper(add(p, mul(left(dir), off)));
    }
    const ref = refs.get(rec.id);
    let sub2 = '';
    if (rec.type === 'area') sub2 = featureStats(rec).find(([kk]) => kk === 'Area')?.[1] ?? '';
    font(6.5, true);
    const w1 = doc.getTextWidth(ref);
    font(5.5);
    const w2 = sub2 ? doc.getTextWidth(sub2) : 0;
    const w = Math.max(w1, w2) + 2.4, h = sub2 ? 6 : 3.6;
    // Nudge the tag off any plant badge or earlier tag it would cover.
    const hits = (c) => taken.some((b) => c[0] - w / 2 < b.x1 + 0.4 && c[0] + w / 2 > b.x0 - 0.4 && c[1] - h / 2 < b.y1 + 0.4 && c[1] + h / 2 > b.y0 - 0.4);
    const tries = [[0, 0]];
    for (const r of [1, 2, 3]) tries.push([0, -r * (h + 1)], [0, r * (h + 1)], [r * (w + 1), 0], [-r * (w + 1), 0], [r * w, -r * h], [-r * w, -r * h], [r * w, r * h], [-r * w, r * h]);
    at = add(at, tries.find((t) => !hits(add(at, t))) ?? [0, 0]);
    taken.push({ x0: at[0] - w / 2, x1: at[0] + w / 2, y0: at[1] - h / 2, y1: at[1] + h / 2 });
    doc.setFillColor('#ffffff');
    doc.setDrawColor(INK);
    doc.setLineWidth(0.2);
    doc.roundedRect(at[0] - w / 2, at[1] - h / 2, w, h, 0.8, 0.8, 'FD');
    font(6.5, true);
    doc.text(ref, at[0], at[1] - (sub2 ? 1.2 : 0), { align: 'center', baseline: 'middle' });
    if (sub2) { font(5.5, false, GREY); doc.text(sub2, at[0], at[1] + 1.4, { align: 'center', baseline: 'middle' }); }
  }

  function drawDims(rec, s) {
    if (rec.type === 'steps') return;
    if (rec.type === 'area' && s.corners) {
      const poly = s.corners;
      for (let i = 0; i < poly.length; i++) dimension(poly[i], poly[(i + 1) % poly.length], poly);
      return;
    }
    if (rec.type === 'wall' && s.corners) {
      for (let i = 0; i + 1 < s.corners.length; i++) dimension(s.corners[i], s.corners[i + 1], null, s.half);
      return;
    }
    if (rec.type === 'area') return; // curved beds: the area tag and schedule say enough
    // Curved walls and all paths: total length written along the line.
    const total = s.line.reduce((d, p, i) => d + (i ? len(sub(p, s.line[i - 1])) : 0), 0);
    const [p, dir] = alongLine(s.line, total * (rec.type === 'path' ? 0.3 : 0.5));
    const off = s.half + 1.6 / k;
    const at = toPaper(add(p, mul(left(dir), -off)));
    alignedText(`${total.toFixed(2)} m`, at, toPaperDir(dir), 5.5);
  }

  // A dimension line offset outside the shape, with architectural ticks and the length above it.
  function dimension(a, b, poly, half = 0) {
    const L = len(sub(b, a));
    if (L < 0.2 || L * k < 5) return;
    const A = toPaper(a), B = toPaper(b);
    const d = norm(sub(B, A));
    let n = [-d[1], d[0]];
    if (poly) {
      const mid = toPaper(mul(add(a, b), 0.5));
      const probe = add(mid, mul(n, 0.6));
      const polyP = poly.map(toPaper);
      if (pointInPolygon(probe, polyP)) n = mul(n, -1);
    }
    const off = half * k + 3;
    const A2 = add(A, mul(n, off)), B2 = add(B, mul(n, off));
    doc.setDrawColor('#3b4540');
    doc.setLineWidth(0.12);
    const e1 = add(A, mul(n, half * k + 0.8)), e2 = add(B, mul(n, half * k + 0.8));
    doc.line(e1[0], e1[1], A2[0] + n[0], A2[1] + n[1]);
    doc.line(e2[0], e2[1], B2[0] + n[0], B2[1] + n[1]);
    doc.line(A2[0], A2[1], B2[0], B2[1]);
    doc.setLineWidth(0.25);
    for (const P of [A2, B2]) {
      const t = mul(norm(add(d, n)), 0.8);
      doc.line(P[0] - t[0], P[1] - t[1], P[0] + t[0], P[1] + t[1]);
    }
    const mid = mul(add(A2, B2), 0.5);
    alignedText(`${L.toFixed(2)}`, add(mid, mul(n, 1.1)), d, 5.5);
  }

  function toPaperDir(dPlan) { return norm([dPlan[0], -dPlan[1]]); }

  // Text centred on `at`, running along direction d (paper space), kept the right way up.
  function alignedText(str, at, d, size) {
    let dir = d;
    if (dir[0] < -1e-6 || (Math.abs(dir[0]) < 1e-6 && dir[1] > 0)) dir = mul(dir, -1);
    const angle = (Math.atan2(-dir[1], dir[0]) * 180) / Math.PI;
    font(size, false, '#26302b');
    const w = doc.getTextWidth(str);
    const up = [dir[1], -dir[0]]; // perpendicular, towards the top of the text
    const start = add(add(at, mul(dir, -w / 2)), mul(up, -size * PT * 0.35));
    // White halo so dimensions stay legible over the underlay.
    doc.saveGraphicsState();
    opacity(0.8);
    doc.setFillColor('#ffffff');
    const hw = w / 2 + 0.6, hh = size * PT * 0.6;
    const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([u, v]) => add(at, add(mul(dir, u), mul(up, v))));
    path(corners);
    doc.fill();
    doc.restoreGraphicsState();
    doc.text(str, start[0], start[1], { angle });
  }

  function alongLine(line, dist) {
    let acc = 0;
    for (let i = 1; i < line.length; i++) {
      const seg = len(sub(line[i], line[i - 1]));
      if (acc + seg >= dist || i === line.length - 1) {
        const t = seg ? Math.min(1, Math.max(0, (dist - acc) / seg)) : 0;
        return [add(line[i - 1], mul(sub(line[i], line[i - 1]), t)), norm(sub(line[i], line[i - 1]))];
      }
      acc += seg;
    }
    return [line[0], [1, 0]];
  }

  function drawNorthAndScale(x, y0, w) {
    doc.setDrawColor(LINE);
    doc.setLineWidth(0.2);
    doc.line(x, y0 - 2, x + w, y0 - 2);
    // North arrow
    const ncx = x + 8, ncy = y0 + 11;
    doc.setDrawColor(INK);
    doc.setLineWidth(0.25);
    doc.circle(ncx, ncy, 6, 'S');
    doc.setFillColor(INK);
    doc.triangle(ncx, ncy - 5.5, ncx - 2.4, ncy + 4, ncx, ncy + 2, 'F');
    doc.setFillColor('#ffffff');
    doc.triangle(ncx, ncy - 5.5, ncx + 2.4, ncy + 4, ncx, ncy + 2, 'FD');
    font(7, true);
    doc.text('N', ncx, ncy - 7, { align: 'center' });
    // Scale bar: four segments of a round length.
    const bx = x + 20, maxW = w - 22;
    const steps = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100];
    const seg = [...steps].reverse().find((v) => v * 4 * k <= maxW) ?? steps[0];
    const sw2 = seg * k;
    const by = y0 + 9;
    doc.setLineWidth(0.2);
    for (let i = 0; i < 4; i++) {
      doc.setFillColor(i % 2 ? '#ffffff' : INK);
      doc.rect(bx + i * sw2, by, sw2, 1.6, 'FD');
    }
    font(6);
    const unit = (v) => (v < 1 ? `${Math.round(v * 1000)} mm` : `${+v.toFixed(2)} m`);
    doc.text('0', bx, by + 4.6, { align: 'center' });
    doc.text(String(+(seg * 2).toFixed(2)), bx + sw2 * 2, by + 4.6, { align: 'center' });
    doc.text(unit(seg * 4), bx + sw2 * 4, by + 4.6, { align: 'center' });
    font(7, true);
    doc.text(`Scale 1:${scale} at ${opts.paper}`, bx, by - 2.5);
  }

  function drawTitleTable(x, y0, w, rows, heights, cells) {
    let yy = y0;
    doc.setDrawColor(INK);
    doc.setLineWidth(0.25);
    doc.rect(x, y0, w, heights.reduce((a, b) => a + b, 0));
    rows.forEach(([label, value], i) => {
      if (i) { doc.setLineWidth(0.12); doc.line(x, yy, x + w, yy); }
      font(5.5, false, GREY);
      doc.text(T(label.toUpperCase()), x + 1.5, yy + 3.2);
      if (value === '__SHEET__') cells.push({ page: 1, x: x + 18, y: yy + 3.4 });
      else {
        font(6.5, label === 'Scale');
        doc.splitTextToSize(T(value || '–'), w - 20).forEach((l, j) => doc.text(l, x + 18, yy + 3.4 + j * lineH(6.5)));
      }
      yy += heights[i];
    });
  }

  // Tables that flow from the sidebar on to extra sheets.
  function makeTableFlow() {
    let cursor = region.y;
    const room = (h) => {
      if (cursor + h <= region.bottom) return;
      region = nextRegion();
      cursor = region.y;
    };
    return {
      gap(h) { cursor += h; },
      heading(text) {
        room(lineH(8) + 10);
        font(8, true);
        cursor += lineH(8);
        doc.text(T(text), region.x, cursor);
        cursor += 1.2;
      },
      note(text) {
        font(6, false, GREY);
        const ls = doc.splitTextToSize(T(text), region.w);
        room(ls.length * lineH(6) + 1);
        for (const l of ls) { cursor += lineH(6); doc.text(l, region.x, cursor); }
        cursor += 1;
      },
      table(cols, rows) {
        const size = 6;
        const header = () => {
          room(lineH(size) + 6);
          doc.setDrawColor(INK);
          doc.setLineWidth(0.25);
          doc.line(region.x, cursor + 0.4, region.x + region.w, cursor + 0.4);
          font(5.5, true, GREY);
          let cx2 = region.x;
          for (const c of cols) {
            const cw = c.w * region.w;
            doc.text(T(c.title.toUpperCase()), c.align === 'right' ? cx2 + cw - 1.5 : cx2 + (c === cols[0] ? 0 : 1), cursor + 3.4, c.align === 'right' ? { align: 'right' } : undefined);
            cx2 += cw;
          }
          cursor += 4.6;
          doc.setLineWidth(0.12);
          doc.line(region.x, cursor, region.x + region.w, cursor);
        };
        header();
        for (const row of rows) {
          const wrapped = row.cells.map((cell, i) => {
            const cw = cols[i].w * region.w - 2 - (i === 0 && (row.swatch || row.dot) ? 3.4 : 0);
            return cell.flatMap((part) => {
              font(size, part.bold);
              return doc.splitTextToSize(T(part.text), cw).map((t) => ({ ...part, text: t }));
            });
          });
          const h = Math.max(...wrapped.map((c) => c.length)) * lineH(size) + 1.6;
          if (cursor + h > region.bottom) { region = nextRegion(); cursor = region.y; header(); }
          let cx2 = region.x;
          wrapped.forEach((lines, i) => {
            const cw = cols[i].w * region.w;
            let tx = cx2 + (i === 0 ? 0 : 1);
            if (i === 0 && row.swatch) {
              doc.setFillColor(row.swatch);
              doc.setDrawColor(darken(row.swatch, 0.35));
              doc.setLineWidth(0.15);
              doc.rect(tx, cursor + 1.1, 2.4, 2.4, 'FD');
              tx += 3.4;
            }
            if (i === 0 && row.dot) {
              doc.setFillColor(row.dot);
              doc.circle(tx + 1.2, cursor + 2.3, 1.2, 'F');
              tx += 3.4;
            }
            lines.forEach((part, j) => {
              font(size, part.bold, part.color ?? INK);
              const ty = cursor + 0.8 + (j + 1) * lineH(size) - 0.4;
              if (cols[i].align === 'right') doc.text(part.text, cx2 + cw - 1.5, ty, { align: 'right' });
              else doc.text(part.text, tx, ty);
            });
            cx2 += cw;
          });
          cursor += h;
          doc.setDrawColor('#c9cfcb');
          doc.setLineWidth(0.1);
          doc.line(region.x, cursor, region.x + region.w, cursor);
        }
        cursor += 1;
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

function mix(hex, target, t) {
  const c = new THREE.Color(hex).lerp(new THREE.Color(target), t);
  return `#${c.getHexString()}`;
}
const lighten = (hex, t) => mix(hex, '#ffffff', t);
const darken = (hex, t) => mix(hex, '#000000', t);
