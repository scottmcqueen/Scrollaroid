import { loadCapture, deleteCapture } from './db.js';

// Chrome's canvas limits: 32,767 px per side and ~268 M pixels. Stay well inside both.
const MAX_SIDE = 32000;
const MAX_AREA = 100_000_000;
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const HANDLE_TOLERANCE = 9; // CSS px
const MIN_RECT = 3; // image px
const CROP_ZOOM = 0.5; // zoom level the crop tool steps out to

const $ = (s) => document.querySelector(s);
const stage = $('#stage');
const wrap = $('#wrap');
const rectLayer = $('#rects');
const sel = $('#sel');
const selSize = $('#selSize');

// Document model. The stitched image (`base`) is never modified: cropping only
// changes which part of it is shown, and redactions are boxes kept on top of it
// (in base-image coordinates) until the image is exported. Undo/redo snapshot
// just these two small pieces of state.
let captureId = null;
let meta = null;
let textIndex = null; // words on the page and where they are, for Find and redact
let base = null;
let view = null; // canvas on screen: `base` itself, or a cropped copy of it
let crop = null; // {x, y, w, h} in base px
let rects = []; // [{id, x, y, w, h}] in base px
let selectedId = null;
let history = [];
let future = [];
let nextId = 1;

let tool = 'redact';
let zoom = 1;
let fitMode = true;
let cropSel = null; // crop selection in view px
let drag = null;
let lastPointer = null;
let scrollRaf = 0;

init().catch((err) => {
  console.error(err);
  showMessage(`Something went wrong: ${err.message || err}`);
});

/* ------------------------------ setup ------------------------------ */

async function init() {
  const id = new URLSearchParams(location.search).get('id');
  captureId = id;
  const data = id ? await loadCapture(id) : null;
  if (!data || !data.frames?.length) {
    showMessage('This capture is no longer available. Click the toolbar button on any page to take a new one.');
    return;
  }
  meta = data.meta;
  document.title = `Scrollaroid — ${meta.title || hostOf(meta.url) || 'page'}`;

  const source = $('#source');
  source.textContent = meta.title || meta.url;
  source.href = meta.url;
  source.title = meta.url;

  const { canvas, scale, px } = await stitch(data);
  base = canvas;
  crop = { x: 0, y: 0, w: base.width, h: base.height };
  if (data.text?.nodes?.length) textIndex = buildTextIndex(data.text, px);

  // Area captures open already cropped to the selection; undo shows the whole strip.
  if (meta.initialCrop) {
    const c = meta.initialCrop;
    const x = clamp(Math.round(c.x * px), 0, base.width - 1);
    const y = clamp(Math.round(c.y * px), 0, base.height - 1);
    const full = snapshot();
    crop = { x, y, w: clamp(Math.round(c.w * px), 1, base.width - x), h: clamp(Math.round(c.h * px), 1, base.height - y) };
    history.push(full);
  }

  const notes = [];
  if (scale < 0.999) notes.push(`Very tall page — scaled to ${Math.round(scale * 100)}% to fit Chrome's image size limit`);
  if (meta.truncated) notes.push(`Stopped after ${data.frames.length} screens (endless-scroll page?)`);
  if (meta.stoppedEarly) notes.push(`Stopped early after ${data.frames.length} screen${data.frames.length === 1 ? '' : 's'}`);
  $('#note').textContent = notes.join(' · ');

  rebuildView();
  $('#message').hidden = true;
  wrap.hidden = false;
  layout();
  bindUi();
}

async function stitch({ meta, frames }) {
  const first = await createImageBitmap(frames[0].blob);
  const sy = first.height / meta.vh; // device pixels per CSS px on the captured page
  const W = first.width;
  const y0 = frames[0].y; // area captures start part-way down the page
  const lastY = frames[frames.length - 1].y - y0;
  const H = Math.round(lastY * sy) + first.height;
  const k = Math.min(1, MAX_SIDE / H, MAX_SIDE / W, Math.sqrt(MAX_AREA / (W * H)));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(W * k));
  canvas.height = Math.max(1, Math.floor(H * k));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';

  const bandTop = Math.round(meta.bandTop * sy);
  const bandH = Math.min(first.height - bandTop, Math.round(meta.bandH * sy));
  const bottomH = first.height - bandTop - bandH;
  const joins = [];
  const put = (bmp, srcY, h, destY) => {
    if (h <= 0) return;
    ctx.drawImage(bmp, 0, srcY, W, h, 0, Math.round(destY * k), canvas.width, Math.round((destY + h) * k) - Math.round(destY * k));
  };

  for (let i = 0; i < frames.length; i++) {
    showMessage(`Stitching ${i + 1} of ${frames.length}…`);
    const bmp = i === 0 ? first : await createImageBitmap(frames[i].blob);
    const destY = bandTop + Math.round((frames[i].y - y0) * sy);
    if (i > 0) joins.push(Math.round(destY * k));
    if (i === 0) put(bmp, 0, bandTop, 0); // anything above a scrolling panel
    put(bmp, bandTop, bandH, destY);
    if (i === frames.length - 1) put(bmp, bandTop + bandH, bottomH, destY + bandH); // anything below it
    bmp.close();
  }
  return { canvas, scale: k, joins, px: sy * k };
}

/* --------------------------- state & undo -------------------------- */

const snapshot = () => ({ crop: { ...crop }, rects: rects.map((r) => ({ ...r })) });
const sameRect = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const sameState = (a, b) =>
  sameRect(a.crop, b.crop) && a.rects.length === b.rects.length && a.rects.every((r, i) => r.id === b.rects[i].id && sameRect(r, b.rects[i]));

// Record `before` as an undo step if the state has changed since then.
function commit(before) {
  if (sameState(before, snapshot())) return;
  history.push(before);
  future = [];
  refreshUi();
}

function restore(s) {
  const cropChanged = !sameRect(s.crop, crop);
  crop = { ...s.crop };
  rects = s.rects.map((r) => ({ ...r }));
  if (!rects.some((r) => r.id === selectedId)) selectedId = null;
  if (cropChanged) {
    cropSel = null;
    rebuildView();
  }
  renderRects();
  drawSel();
  refreshUi();
}

function undo() {
  if (!history.length || drag) return;
  future.push(snapshot());
  restore(history.pop());
}

function redo() {
  if (!future.length || drag) return;
  history.push(snapshot());
  restore(future.pop());
}

/* ------------------------------ canvas ----------------------------- */

function rebuildView() {
  let next = base;
  if (crop.x || crop.y || crop.w !== base.width || crop.h !== base.height) {
    next = document.createElement('canvas');
    next.width = crop.w;
    next.height = crop.h;
    next.getContext('2d').drawImage(base, -crop.x, -crop.y);
  }
  const old = view;
  view = next;
  if (old !== next) {
    if (old) {
      old.remove();
      if (old !== base) old.width = old.height = 0; // free memory right away
    }
    wrap.prepend(next);
  }
  layout();
}

// The final image: cropped view with redactions burned into the pixels.
function flatten() {
  const out = document.createElement('canvas');
  out.width = view.width;
  out.height = view.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(view, 0, 0);
  ctx.fillStyle = '#000';
  for (const r of rects) ctx.fillRect(r.x - crop.x, r.y - crop.y, r.w, r.h);
  return out;
}

/* ------------------------------ layout ----------------------------- */

function layout() {
  if (!view) return;
  const dpr = window.devicePixelRatio || 1;
  const naturalW = view.width / dpr;
  if (fitMode) {
    const avail = Math.max(100, stage.clientWidth - 48);
    zoom = Math.min(1, avail / naturalW);
  }
  const w = Math.max(1, Math.round(naturalW * zoom));
  const h = Math.max(1, Math.round((view.height / dpr) * zoom));
  view.style.width = `${w}px`;
  view.style.height = `${h}px`;
  wrap.style.width = `${w}px`;
  wrap.style.height = `${h}px`;
  $('#zoomLabel').textContent = fitMode ? `Fit · ${Math.round(zoom * 100)}%` : `${Math.round(zoom * 100)}%`;
  renderRects();
  drawSel();
}

function setZoom(z, anchor) {
  if (!view) return;
  const before = view.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  const ax = anchor ? anchor.x : sr.left + sr.width / 2;
  const ay = anchor ? anchor.y : sr.top + sr.height / 2;
  const fx = (ax - before.left) / before.width;
  const fy = (ay - before.top) / before.height;

  fitMode = false;
  zoom = Math.min(4, Math.max(0.05, z));
  layout();

  const after = view.getBoundingClientRect();
  stage.scrollLeft += after.left + fx * after.width - ax;
  stage.scrollTop += after.top + fy * after.height - ay;
}

function zoomStep(dir, anchor) {
  const next = dir > 0 ? ZOOM_STEPS.find((z) => z > zoom + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001);
  setZoom(next ?? zoom, anchor);
}

function fit() {
  fitMode = true;
  layout();
}

/* -------------------------- redaction boxes ------------------------- */

const HANDLES = '<i data-h="nw"></i><i data-h="n"></i><i data-h="ne"></i><i data-h="e"></i><i data-h="se"></i><i data-h="s"></i><i data-h="sw"></i><i data-h="w"></i>';

const toView = (r) => ({ x: r.x - crop.x, y: r.y - crop.y, w: r.w, h: r.h });

function renderRects() {
  if (!view) return;
  const s = view.clientWidth / view.width;
  const html = [];
  for (const r of rects) {
    const v = toView(r);
    if (v.x + v.w <= 0 || v.y + v.h <= 0 || v.x >= view.width || v.y >= view.height) continue; // cropped away
    const selected = r.id === selectedId;
    html.push(
      `<div class="box redaction${selected ? ' selected' : ''}" style="left:${v.x * s}px;top:${v.y * s}px;width:${v.w * s}px;height:${v.h * s}px">${selected ? HANDLES : ''}</div>`,
    );
  }
  rectLayer.innerHTML = html.join('');
  rectLayer.classList.toggle('inactive', tool !== 'redact');
}

function selectRect(id) {
  selectedId = id;
  renderRects();
  refreshUi();
}

function deleteSelected() {
  if (selectedId == null) return;
  const before = snapshot();
  rects = rects.filter((r) => r.id !== selectedId);
  selectedId = null;
  commit(before, 'Deleted a redaction box');
  renderRects();
  refreshUi();
}

function nudgeSelected(dx, dy) {
  const r = rects.find((r) => r.id === selectedId);
  if (!r) return;
  const before = snapshot();
  r.x = clamp(r.x + dx, crop.x, crop.x + crop.w - r.w);
  r.y = clamp(r.y + dy, crop.y, crop.y + crop.h - r.h);
  commit(before, 'Moved a redaction box');
  renderRects();
}

// Topmost visible box under the pointer, with the handle that was hit.
function rectAt(clientX, clientY) {
  for (let i = rects.length - 1; i >= 0; i--) {
    const h = hitTest(toView(rects[i]), clientX, clientY, rects[i].id === selectedId);
    if (h) return { rect: rects[i], handle: h };
  }
  return null;
}

/* ---------------------------- selection ---------------------------- */

function toImage(clientX, clientY) {
  const r = view.getBoundingClientRect();
  const x = ((clientX - r.left) * view.width) / r.width;
  const y = ((clientY - r.top) * view.height) / r.height;
  return { x: clamp(x, 0, view.width), y: clamp(y, 0, view.height) };
}

function rectFrom(a, b) {
  const x = Math.round(Math.min(a.x, b.x));
  const y = Math.round(Math.min(a.y, b.y));
  return { x, y, w: Math.round(Math.max(a.x, b.x)) - x, h: Math.round(Math.max(a.y, b.y)) - y };
}

// Move or resize `o` (view px) by a pointer delta, kept inside the image.
function adjustRect(o, handle, dx, dy) {
  if (handle === 'move') {
    return {
      x: Math.round(clamp(o.x + dx, 0, view.width - o.w)),
      y: Math.round(clamp(o.y + dy, 0, view.height - o.h)),
      w: o.w,
      h: o.h,
    };
  }
  let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
  if (handle.includes('n')) y1 = clamp(o.y + dy, 0, view.height);
  if (handle.includes('s')) y2 = clamp(o.y + o.h + dy, 0, view.height);
  if (handle.includes('w')) x1 = clamp(o.x + dx, 0, view.width);
  if (handle.includes('e')) x2 = clamp(o.x + o.w + dx, 0, view.width);
  return rectFrom({ x: x1, y: y1 }, { x: x2, y: y2 });
}

// The live selection outline: a box being drawn, or the crop selection.
function drawSel() {
  let rect = null;
  let kind = 'crop';
  if (drag?.kind === 'rect-new') {
    rect = drag.rect;
    kind = 'redact';
  } else if (tool === 'crop') {
    rect = cropSel;
  }
  if (!rect || !view) {
    sel.hidden = true;
    return;
  }
  const s = view.clientWidth / view.width;
  sel.hidden = false;
  sel.className = `box ${kind}`;
  sel.style.left = `${rect.x * s}px`;
  sel.style.top = `${rect.y * s}px`;
  sel.style.width = `${rect.w * s}px`;
  sel.style.height = `${rect.h * s}px`;
  sel.classList.toggle('flip', rect.y * s < 30);
  selSize.textContent = `${rect.w} × ${rect.h}`;
}

// Which handle of `rect` (view px) is under the pointer: n/s/e/w/corners, 'move', or null.
function hitTest(rect, clientX, clientY, withHandles = true) {
  if (!rect) return null;
  const r = view.getBoundingClientRect();
  const s = r.width / view.width;
  const L = r.left + rect.x * s;
  const T = r.top + rect.y * s;
  const R = L + rect.w * s;
  const B = T + rect.h * s;
  const t = withHandles ? HANDLE_TOLERANCE : 0;
  if (clientX < L - t || clientX > R + t || clientY < T - t || clientY > B + t) return null;
  if (withHandles) {
    let h = '';
    if (Math.abs(clientY - T) <= t) h += 'n';
    else if (Math.abs(clientY - B) <= t) h += 's';
    if (Math.abs(clientX - L) <= t) h += 'w';
    else if (Math.abs(clientX - R) <= t) h += 'e';
    if (h) return h;
  }
  return clientX >= L && clientX <= R && clientY >= T && clientY <= B ? 'move' : null;
}

const CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize', move: 'move' };

function updateDrag() {
  if (!drag || !lastPointer) return;
  const p = toImage(lastPointer.x, lastPointer.y);
  const dx = p.x - drag.start.x;
  const dy = p.y - drag.start.y;

  if (drag.kind === 'rect-new') {
    drag.rect = rectFrom(drag.start, p);
    drawSel();
  } else if (drag.kind === 'rect-edit') {
    const r = rects.find((r) => r.id === drag.id);
    if (r) {
      const v = adjustRect(drag.orig, drag.handle, dx, dy);
      Object.assign(r, { x: v.x + crop.x, y: v.y + crop.y, w: v.w, h: v.h });
      renderRects();
    }
  } else if (drag.kind === 'crop-new') {
    cropSel = rectFrom(drag.start, p);
    drawSel();
  } else if (drag.kind === 'crop-adjust') {
    cropSel = adjustRect(drag.orig, drag.handle, dx, dy);
    drawSel();
  }
  refreshUi();
}

// Scroll the stage while dragging near its edges, so selections can span a long page.
function autoScroll() {
  scrollRaf = 0;
  if (!drag || !lastPointer) return;
  const r = stage.getBoundingClientRect();
  const edge = 50;
  const speed = (d) => Math.ceil(Math.min(1, d / edge) ** 2 * 28);
  let dx = 0, dy = 0;
  if (lastPointer.y > r.bottom - edge) dy = speed(lastPointer.y - (r.bottom - edge));
  else if (lastPointer.y < r.top + edge) dy = -speed(r.top + edge - lastPointer.y);
  if (lastPointer.x > r.right - edge) dx = speed(lastPointer.x - (r.right - edge));
  else if (lastPointer.x < r.left + edge) dx = -speed(r.left + edge - lastPointer.x);
  if (dx || dy) {
    const beforeTop = stage.scrollTop, beforeLeft = stage.scrollLeft;
    stage.scrollTop += dy;
    stage.scrollLeft += dx;
    if (stage.scrollTop !== beforeTop || stage.scrollLeft !== beforeLeft) updateDrag();
  }
  scrollRaf = requestAnimationFrame(autoScroll);
}

/* ------------------------------- UI -------------------------------- */

function setTool(t) {
  if (drag) return;
  tool = t;
  document.querySelectorAll('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  if (t !== 'crop') {
    cropSel = null;
  } else {
    selectedId = null;
    if (view && zoom > CROP_ZOOM + 0.001) {
      // Step back so more of the page is visible, and show that zoom is adjustable.
      setZoom(CROP_ZOOM);
      toast('Zoomed out to 50% for cropping. Use − / + to change', 3500);
    }
  }
  renderRects();
  drawSel();
  refreshUi();
}

function applyCrop() {
  if (!cropSel || cropSel.w < MIN_RECT || cropSel.h < MIN_RECT) return;
  const before = snapshot();
  crop = { x: crop.x + cropSel.x, y: crop.y + cropSel.y, w: cropSel.w, h: cropSel.h };
  cropSel = null;
  rebuildView();
  commit(before, 'Cropped');
  stage.scrollTop = 0;
  stage.scrollLeft = 0;
  toast('Cropped');
}

function cancelCrop() {
  cropSel = null;
  drawSel();
  refreshUi();
}

/* -------------------------- find and redact ------------------------ */

function buildTextIndex(raw, f) {
  let text = '';
  const words = [];
  for (const node of raw.nodes) {
    const start = text.length;
    text += `${node.t}\n`;
    for (const [s, e, x, y, w, h] of node.w) words.push({ s: start + s, e: start + e, x: x * f, y: y * f, w: w * f, h: h * f });
  }
  return { text, words, pad: 2 * f };
}

const luhn = (digits) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = +digits[digits.length - 1 - i];
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
};

const PATTERNS = [
  { id: 'email', label: 'Email addresses', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  {
    id: 'card',
    label: 'Card numbers',
    re: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
    keep: (t) => {
      const d = t.replace(/\D/g, '');
      return d.length >= 13 && d.length <= 19 && luhn(d);
    },
  },
  {
    id: 'phone',
    label: 'Phone numbers',
    // International (+...), US style (555) 123-4567 / 555-123-4567, or local numbers starting with 0.
    // Not preceded by a letter-and-digit code, so tracking and order numbers aren't caught.
    re: /(?<![\w+])(?<!\d[A-Za-z]?\s)(?:\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d(?:[\s.-]?\d){6,12}|\(\d{3}\)\s?\d{3}[-.\s]\d{4}|\d{3}[-.\s]\d{3}[-.\s]\d{4}|0\d{1,4}[-.\s]?\d{3,4}[-.\s]?\d{3,4})(?!\d)/g,
    keep: (t) => {
      const d = t.replace(/\D/g, '');
      if (d.length < 8 || d.length > 15) return false;
      if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(t) || /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/.test(t)) return false; // dates
      return true;
    },
  },
  { id: 'handle', label: 'Usernames (@name, u/name)', re: /(?<![\w@/])(?:@[A-Za-z0-9_.]{2,30}|u\/[A-Za-z0-9_-]{3,20})/g },
];

// Boxes (base px) covering the words of text[ms, me), one box per line.
function boxesFor(ms, me) {
  const words = textIndex.words;
  let lo = 0, hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].e <= ms) lo = mid + 1;
    else hi = mid;
  }
  const lines = [];
  for (let i = lo; i < words.length && words[i].s < me; i++) {
    const w = words[i];
    const line = lines.find((l) => Math.abs(l.cy - (w.y + w.h / 2)) < w.h / 2);
    if (line) {
      line.x1 = Math.min(line.x1, w.x);
      line.y1 = Math.min(line.y1, w.y);
      line.x2 = Math.max(line.x2, w.x + w.w);
      line.y2 = Math.max(line.y2, w.y + w.h);
    } else {
      lines.push({ cy: w.y + w.h / 2, x1: w.x, y1: w.y, x2: w.x + w.w, y2: w.y + w.h });
    }
  }
  const p = textIndex.pad;
  return lines.map((l) => {
    const x = clamp(Math.floor(l.x1 - p), 0, base.width);
    const y = clamp(Math.floor(l.y1 - p), 0, base.height);
    return { x, y, w: clamp(Math.ceil(l.x2 + p), 0, base.width) - x, h: clamp(Math.ceil(l.y2 + p), 0, base.height) - y };
  });
}

const inCrop = (b) => b.w > 0 && b.h > 0 && b.x < crop.x + crop.w && b.x + b.w > crop.x && b.y < crop.y + crop.h && b.y + b.h > crop.y;

function findMatches(re, keep, taken = []) {
  const out = [];
  for (const m of textIndex.text.matchAll(re)) {
    const t = m[0].trim();
    if (!t || (keep && !keep(t))) continue;
    const ms = m.index, me = m.index + m[0].length;
    if (taken.some(([a, b]) => ms < b && me > a)) continue;
    const boxes = boxesFor(ms, me).filter(inCrop);
    if (!boxes.length) continue;
    out.push({ text: t, boxes, range: [ms, me] });
  }
  return out;
}

let findGroups = [];

function runFind() {
  const groups = [];
  const taken = [];
  for (const p of PATTERNS) {
    const matches = findMatches(p.re, p.keep, taken);
    matches.forEach((m) => taken.push(m.range));
    groups.push({ ...p, matches });
  }
  const q = $('#findText').value.trim();
  if (q.length >= 2) {
    const re = new RegExp(q.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'gi');
    groups.unshift({ id: 'custom', label: `"${q}"`, matches: findMatches(re) });
  }
  findGroups = groups;
  renderFind();
}

function renderFind() {
  const list = $('#findResults');
  list.innerHTML = '';
  const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  findGroups.forEach((g, gi) => {
    const section = document.createElement('section');
    const n = g.matches.length;
    section.innerHTML = `<label class="group-head"><input type="checkbox" data-g="${gi}" ${n ? 'checked' : 'disabled'}> ${esc(g.label)} <span>${n}</span></label>`;
    if (n) {
      const ul = document.createElement('ul');
      ul.innerHTML = g.matches
        .slice(0, 300)
        .map((m, mi) => `<li><label><input type="checkbox" data-g="${gi}" data-m="${mi}" checked> <span>${esc(m.text)}</span></label></li>`)
        .join('');
      section.appendChild(ul);
    }
    list.appendChild(section);
  });
  updateFindCount();
}

function selectedMatches() {
  const out = [];
  for (const cb of $('#findResults').querySelectorAll('input[data-m]:checked')) out.push(findGroups[+cb.dataset.g].matches[+cb.dataset.m]);
  return out;
}

function updateFindCount() {
  const n = selectedMatches().length;
  $('#findApply').textContent = n ? `Redact ${n} match${n === 1 ? '' : 'es'}` : 'Redact matches';
  $('#findApply').disabled = !n;
}

function openFind() {
  if (!textIndex) {
    toast('No page text was recorded for this capture');
    return;
  }
  setTool('redact');
  runFind();
  $('#findDialog').returnValue = '';
  $('#findDialog').showModal();
  $('#findText').focus();
}

function applyFind() {
  const before = snapshot();
  const key = (b) => `${b.x},${b.y},${b.w},${b.h}`;
  const existing = new Set(rects.map(key));
  let added = 0;
  for (const m of selectedMatches()) {
    for (const b of m.boxes) {
      if (existing.has(key(b))) continue;
      existing.add(key(b));
      rects.push({ id: nextId++, ...b });
      added++;
    }
  }
  selectedId = null;
  commit(before, `Added ${added} redaction box${added === 1 ? '' : 'es'} with Find and redact`);
  renderRects();
  refreshUi();
  toast(added ? `Added ${added} box${added === 1 ? '' : 'es'}. Check them before saving` : 'Those matches are already covered', 4000);
}

function refreshUi() {
  $('#undo').disabled = !history.length;
  $('#redo').disabled = !future.length;
  $('.crop-actions').hidden = tool !== 'crop';
  $('.box-actions').hidden = tool !== 'redact' || selectedId == null;
  $('#find').hidden = tool !== 'redact';
  $('#find').disabled = !textIndex;
  $('#find').title = textIndex ? 'Find emails, phone numbers, names and more, and black them out (F)' : 'No page text was recorded for this capture';
  $('#applyCrop').disabled = !(cropSel && cropSel.w >= MIN_RECT && cropSel.h >= MIN_RECT);
  $('#cancelCrop').disabled = !cropSel;
  if (view) $('#dims').textContent = `${view.width.toLocaleString()} × ${view.height.toLocaleString()} px`;
}

function endDrag(e) {
  if (!drag) return;
  if (e.type === 'pointerup') {
    lastPointer = { x: e.clientX, y: e.clientY };
    updateDrag();
  }
  const d = drag;
  drag = null;
  cancelAnimationFrame(scrollRaf);
  scrollRaf = 0;
  const cancelled = e.type !== 'pointerup';

  if (d.kind === 'rect-new') {
    if (!cancelled && d.rect.w >= MIN_RECT && d.rect.h >= MIN_RECT) {
      const id = nextId++;
      rects.push({ id, x: d.rect.x + crop.x, y: d.rect.y + crop.y, w: d.rect.w, h: d.rect.h });
      selectedId = id;
      commit(d.before, 'Added a redaction box');
    }
  } else if (d.kind === 'rect-edit') {
    const r = rects.find((r) => r.id === d.id);
    if (cancelled) restore(d.before);
    else if (r && (r.w < MIN_RECT || r.h < MIN_RECT)) {
      // Shrunk to nothing: treat as a delete rather than keep an invisible box.
      rects = rects.filter((x) => x !== r);
      selectedId = null;
      commit(d.before, 'Deleted a redaction box');
    } else commit(d.before, d.handle === 'move' ? 'Moved a redaction box' : 'Resized a redaction box');
  } else if (cropSel && (cropSel.w < MIN_RECT || cropSel.h < MIN_RECT)) {
    cropSel = null;
  }
  renderRects();
  drawSel();
  refreshUi();
}

function bindUi() {
  document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#applyCrop').addEventListener('click', applyCrop);
  $('#cancelCrop').addEventListener('click', cancelCrop);
  $('#deleteBox').addEventListener('click', deleteSelected);
  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#zoomIn').addEventListener('click', () => zoomStep(1));
  $('#zoomOut').addEventListener('click', () => zoomStep(-1));
  $('#zoomLabel').addEventListener('click', fit);
  $('#download').addEventListener('click', download);
  $('#copy').addEventListener('click', copy);
  $('#discard').addEventListener('click', () => $('#confirmDiscard').showModal());
  $('#help').addEventListener('click', () => $('#helpDialog').showModal());
  $('#find').addEventListener('click', openFind);
  let findTimer = 0;
  $('#findText').addEventListener('input', () => {
    clearTimeout(findTimer);
    findTimer = setTimeout(runFind, 200);
  });
  $('#findText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();
  });
  $('#findResults').addEventListener('change', (e) => {
    const cb = e.target;
    if (cb.dataset.g != null && cb.dataset.m == null) {
      cb.closest('section').querySelectorAll('input[data-m]').forEach((x) => (x.checked = cb.checked));
    } else if (cb.dataset.m != null) {
      const section = cb.closest('section');
      const all = section.querySelectorAll('input[data-m]');
      const on = section.querySelectorAll('input[data-m]:checked').length;
      const head = section.querySelector('input:not([data-m])');
      head.checked = on > 0;
      head.indeterminate = on > 0 && on < all.length;
    }
    updateFindCount();
  });
  $('#findDialog').addEventListener('close', () => {
    if ($('#findDialog').returnValue === 'apply') applyFind();
  });
  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !view || drag) return;
    e.preventDefault();
    lastPointer = { x: e.clientX, y: e.clientY };
    const p = toImage(e.clientX, e.clientY);
    const before = snapshot();

    if (tool === 'crop') {
      const h = hitTest(cropSel, e.clientX, e.clientY);
      drag = h ? { kind: 'crop-adjust', handle: h, start: p, orig: { ...cropSel } } : { kind: 'crop-new', start: p };
    } else {
      const hit = rectAt(e.clientX, e.clientY);
      if (hit) {
        selectedId = hit.rect.id;
        drag = { kind: 'rect-edit', id: hit.rect.id, handle: hit.handle, start: p, orig: toView(hit.rect), before };
      } else {
        selectedId = null;
        drag = { kind: 'rect-new', start: p, rect: { x: Math.round(p.x), y: Math.round(p.y), w: 0, h: 0 }, before };
      }
      renderRects();
    }
    wrap.setPointerCapture(e.pointerId);
    updateDrag();
    if (!scrollRaf) scrollRaf = requestAnimationFrame(autoScroll);
  });

  wrap.addEventListener('pointermove', (e) => {
    if (drag) {
      lastPointer = { x: e.clientX, y: e.clientY };
      updateDrag();
      return;
    }
    let h = null;
    if (tool === 'crop') h = hitTest(cropSel, e.clientX, e.clientY);
    else h = rectAt(e.clientX, e.clientY)?.handle;
    wrap.style.cursor = h ? CURSORS[h] : 'crosshair';
  });

  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);

  stage.addEventListener(
    'wheel',
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setZoom(zoom * Math.exp(-e.deltaY * 0.0025), { x: e.clientX, y: e.clientY });
    },
    { passive: false },
  );

  window.addEventListener('resize', () => fitMode && layout());

  window.addEventListener('keydown', (e) => {
    if (document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (mod && k === 'y') {
      e.preventDefault();
      redo();
    } else if (mod && k === 's') {
      e.preventDefault();
      download();
    } else if (mod && k === 'c') {
      if (!String(window.getSelection())) {
        e.preventDefault();
        copy();
      }
    } else if (mod || e.altKey) {
      return;
    } else if ((k === 'delete' || k === 'backspace') && selectedId != null) {
      e.preventDefault();
      deleteSelected();
    } else if (k.startsWith('arrow') && selectedId != null) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      nudgeSelected(k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0, k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0);
    } else if (k === 'f') {
      e.preventDefault();
      openFind();
    } else if (k === '?' || (k === '/' && e.shiftKey)) {
      $('#helpDialog').showModal();
    } else if (k === 'b' || k === 'r') {
      setTool('redact');
    } else if (k === 'c') {
      setTool('crop');
    } else if (k === 'enter' && tool === 'crop') {
      e.preventDefault();
      applyCrop();
    } else if (k === 'escape') {
      if (drag) endDrag({ type: 'cancel' });
      else if (tool === 'crop') cancelCrop();
      else selectRect(null);
    } else if (k === '+' || k === '=') {
      zoomStep(1);
    } else if (k === '-' || k === '_') {
      zoomStep(-1);
    } else if (k === '0') {
      fit();
    }
  });

  refreshUi();
}

/* ------------------------------ discard ---------------------------- */

async function discard() {
  try {
    if (captureId) await deleteCapture(captureId);
  } catch (err) {
    console.error(err);
  }
  const tab = await chrome.tabs.getCurrent().catch(() => null);
  if (tab?.id != null) chrome.tabs.remove(tab.id);
  else window.close();
}

/* ------------------------------ export ----------------------------- */

const canvasBlob = (c, type = 'image/png', q) => new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, q));

// The image as shared: cropped, with redactions burned into the pixels.
async function exportBlob() {
  const flat = flatten();
  try {
    return await canvasBlob(flat);
  } finally {
    flat.width = flat.height = 0;
  }
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120_000);
}

function fileStamp() {
  const d = new Date(meta.createdAt || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

async function download() {
  if (!view) return;
  toast('Preparing PNG…', 0);
  try {
    saveBlob(await exportBlob(), fileName());
    toast('Downloaded');
  } catch (err) {
    toast(`Download failed: ${err.message}`);
  }
}

async function copy() {
  if (!view) return;
  try {
    // Passing the promise keeps the click's user activation while the PNG encodes.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': exportBlob() })]);
    toast('Copied to clipboard');
  } catch (err) {
    toast(`Copy failed: ${err.message}`);
  }
}

function fileName() {
  const stamp = fileStamp();
  const name = (meta.title || hostOf(meta.url) || 'screenshot')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${name} ${stamp}.png`;
}

/* ------------------------------ helpers ---------------------------- */

let toastTimer = 0;
function toast(text, ms = 2200) {
  const el = $('#toast');
  el.textContent = text;
  el.style.opacity = '1';
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => (el.style.opacity = '0'), ms);
}

function showMessage(text) {
  const m = $('#message');
  m.textContent = text;
  m.hidden = false;
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
