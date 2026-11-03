import { loadCapture } from './db.js';

// Chrome's canvas limits: 32,767 px per side and ~268 M pixels. Stay well inside both
// so that the working copy plus the undo base fit comfortably in memory.
const MAX_SIDE = 32000;
const MAX_AREA = 100_000_000;
const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const HANDLE_TOLERANCE = 9; // CSS px
const MIN_RECT = 3; // image px

const $ = (s) => document.querySelector(s);
const stage = $('#stage');
const wrap = $('#wrap');
const sel = $('#sel');
const selSize = $('#selSize');

let meta = null;
let base = null; // pristine stitched image, used to replay edits on undo
let current = null; // canvas on screen, with edits applied
let ops = [];
let redoStack = [];
let tool = 'redact';
let zoom = 1;
let fitMode = true;
let cropSel = null; // {x, y, w, h} in image px
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

  const { canvas, scale } = await stitch(data);
  base = canvas;
  const notes = [];
  if (scale < 0.999) notes.push(`Very tall page — scaled to ${Math.round(scale * 100)}% to fit Chrome's image size limit`);
  if (meta.truncated) notes.push(`Stopped after ${data.frames.length} screens (endless-scroll page?)`);
  $('#note').textContent = notes.join(' · ');

  setCurrent(cloneCanvas(base));
  $('#message').hidden = true;
  wrap.hidden = false;
  layout();
  bindUi();
}

async function stitch({ meta, frames }) {
  const first = await createImageBitmap(frames[0].blob);
  const sy = first.height / meta.vh; // device pixels per CSS px on the captured page
  const W = first.width;
  const lastY = frames[frames.length - 1].y;
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
  const put = (bmp, srcY, h, destY) => {
    if (h <= 0) return;
    ctx.drawImage(bmp, 0, srcY, W, h, 0, Math.round(destY * k), canvas.width, Math.round((destY + h) * k) - Math.round(destY * k));
  };

  for (let i = 0; i < frames.length; i++) {
    showMessage(`Stitching ${i + 1} of ${frames.length}…`);
    const bmp = i === 0 ? first : await createImageBitmap(frames[i].blob);
    const destY = bandTop + Math.round(frames[i].y * sy);
    if (i === 0) put(bmp, 0, bandTop, 0); // anything above a scrolling panel
    put(bmp, bandTop, bandH, destY);
    if (i === frames.length - 1) put(bmp, bandTop + bandH, bottomH, destY + bandH); // anything below it
    bmp.close();
  }
  return { canvas, scale: k };
}

/* ------------------------------ edits ------------------------------ */

function applyOp(canvas, op) {
  if (op.type === 'rect') {
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(op.x, op.y, op.w, op.h);
    return canvas;
  }
  if (op.type === 'crop') {
    const out = document.createElement('canvas');
    out.width = op.w;
    out.height = op.h;
    out.getContext('2d').drawImage(canvas, -op.x, -op.y);
    return out;
  }
  return canvas;
}

function pushOp(op) {
  ops.push(op);
  redoStack = [];
  setCurrent(applyOp(current, op));
}

function undo() {
  if (!ops.length) return;
  redoStack.push(ops.pop());
  let c = cloneCanvas(base);
  for (const op of ops) c = applyOp(c, op);
  setCurrent(c);
}

function redo() {
  if (!redoStack.length) return;
  const op = redoStack.pop();
  ops.push(op);
  setCurrent(applyOp(current, op));
}

function setCurrent(canvas) {
  const old = current;
  current = canvas;
  if (old !== canvas) {
    if (old) {
      old.remove();
      if (old !== base) old.width = old.height = 0; // free memory right away
    }
    wrap.prepend(canvas);
  }
  cropSel = null;
  hideSel();
  layout();
  refreshUi();
}

function cloneCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

/* ------------------------------ layout ------------------------------ */

function layout() {
  if (!current) return;
  const dpr = window.devicePixelRatio || 1;
  const naturalW = current.width / dpr;
  if (fitMode) {
    const avail = Math.max(100, stage.clientWidth - 48);
    zoom = Math.min(1, avail / naturalW);
  }
  const w = Math.max(1, Math.round(naturalW * zoom));
  const h = Math.max(1, Math.round((current.height / dpr) * zoom));
  current.style.width = `${w}px`;
  current.style.height = `${h}px`;
  wrap.style.width = `${w}px`;
  wrap.style.height = `${h}px`;
  $('#zoomLabel').textContent = fitMode ? `Fit · ${Math.round(zoom * 100)}%` : `${Math.round(zoom * 100)}%`;
  drawSel();
}

function setZoom(z, anchor) {
  if (!current) return;
  const before = current.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  const ax = anchor ? anchor.x : sr.left + sr.width / 2;
  const ay = anchor ? anchor.y : sr.top + sr.height / 2;
  const fx = (ax - before.left) / before.width;
  const fy = (ay - before.top) / before.height;

  fitMode = false;
  zoom = Math.min(4, Math.max(0.05, z));
  layout();

  const after = current.getBoundingClientRect();
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

/* ---------------------------- selection ---------------------------- */

function toImage(clientX, clientY) {
  const r = current.getBoundingClientRect();
  const x = ((clientX - r.left) * current.width) / r.width;
  const y = ((clientY - r.top) * current.height) / r.height;
  return { x: clamp(x, 0, current.width), y: clamp(y, 0, current.height) };
}

function rectFrom(a, b) {
  const x = Math.round(Math.min(a.x, b.x));
  const y = Math.round(Math.min(a.y, b.y));
  return { x, y, w: Math.round(Math.max(a.x, b.x)) - x, h: Math.round(Math.max(a.y, b.y)) - y };
}

function drawSel(rect = drag?.kind === 'redact' ? drag.rect : cropSel, kind = drag?.kind === 'redact' ? 'redact' : 'crop') {
  if (!rect || !current) return hideSel();
  const s = current.clientWidth / current.width;
  sel.hidden = false;
  sel.className = kind;
  sel.style.left = `${rect.x * s}px`;
  sel.style.top = `${rect.y * s}px`;
  sel.style.width = `${rect.w * s}px`;
  sel.style.height = `${rect.h * s}px`;
  sel.classList.toggle('flip', rect.y * s < 30);
  selSize.textContent = `${rect.w} × ${rect.h}`;
}

function hideSel() {
  sel.hidden = true;
}

// Which crop handle (if any) is under the pointer?
function hitTest(clientX, clientY) {
  if (!cropSel) return null;
  const r = current.getBoundingClientRect();
  const s = r.width / current.width;
  const L = r.left + cropSel.x * s;
  const T = r.top + cropSel.y * s;
  const R = L + cropSel.w * s;
  const B = T + cropSel.h * s;
  const t = HANDLE_TOLERANCE;
  if (clientX < L - t || clientX > R + t || clientY < T - t || clientY > B + t) return null;
  let h = '';
  if (Math.abs(clientY - T) <= t) h += 'n';
  else if (Math.abs(clientY - B) <= t) h += 's';
  if (Math.abs(clientX - L) <= t) h += 'w';
  else if (Math.abs(clientX - R) <= t) h += 'e';
  if (h) return h;
  return clientX > L && clientX < R && clientY > T && clientY < B ? 'move' : null;
}

const CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize', move: 'move' };

function updateDrag() {
  if (!drag || !lastPointer) return;
  const p = toImage(lastPointer.x, lastPointer.y);

  if (drag.kind === 'redact') {
    drag.rect = rectFrom(drag.start, p);
    drawSel(drag.rect, 'redact');
  } else if (drag.kind === 'crop-new') {
    cropSel = rectFrom(drag.start, p);
    drawSel(cropSel, 'crop');
  } else if (drag.kind === 'crop-adjust') {
    const o = drag.orig;
    const dx = p.x - drag.start.x;
    const dy = p.y - drag.start.y;
    if (drag.handle === 'move') {
      cropSel = {
        x: Math.round(clamp(o.x + dx, 0, current.width - o.w)),
        y: Math.round(clamp(o.y + dy, 0, current.height - o.h)),
        w: o.w,
        h: o.h,
      };
    } else {
      let x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
      if (drag.handle.includes('n')) y1 = clamp(o.y + dy, 0, current.height);
      if (drag.handle.includes('s')) y2 = clamp(o.y + o.h + dy, 0, current.height);
      if (drag.handle.includes('w')) x1 = clamp(o.x + dx, 0, current.width);
      if (drag.handle.includes('e')) x2 = clamp(o.x + o.w + dx, 0, current.width);
      cropSel = rectFrom({ x: x1, y: y1 }, { x: x2, y: y2 });
    }
    drawSel(cropSel, 'crop');
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
  tool = t;
  document.querySelectorAll('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === t)));
  if (t !== 'crop') {
    cropSel = null;
    hideSel();
  }
  refreshUi();
}

function applyCrop() {
  if (!cropSel || cropSel.w < MIN_RECT || cropSel.h < MIN_RECT) return;
  pushOp({ type: 'crop', ...cropSel });
  stage.scrollTop = 0;
  stage.scrollLeft = 0;
  toast('Cropped');
}

function cancelCrop() {
  cropSel = null;
  hideSel();
  refreshUi();
}

function refreshUi() {
  $('#undo').disabled = !ops.length;
  $('#redo').disabled = !redoStack.length;
  $('.crop-actions').hidden = tool !== 'crop';
  $('#applyCrop').disabled = !(cropSel && cropSel.w >= MIN_RECT && cropSel.h >= MIN_RECT);
  $('#cancelCrop').disabled = !cropSel;
  if (current) $('#dims').textContent = `${current.width.toLocaleString()} × ${current.height.toLocaleString()} px`;
}

function bindUi() {
  document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  $('#applyCrop').addEventListener('click', applyCrop);
  $('#cancelCrop').addEventListener('click', cancelCrop);
  $('#undo').addEventListener('click', undo);
  $('#redo').addEventListener('click', redo);
  $('#zoomIn').addEventListener('click', () => zoomStep(1));
  $('#zoomOut').addEventListener('click', () => zoomStep(-1));
  $('#zoomLabel').addEventListener('click', fit);
  $('#download').addEventListener('click', download);
  $('#copy').addEventListener('click', copy);

  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !current) return;
    e.preventDefault();
    lastPointer = { x: e.clientX, y: e.clientY };
    const p = toImage(e.clientX, e.clientY);
    if (tool === 'crop') {
      const h = hitTest(e.clientX, e.clientY);
      drag = h ? { kind: 'crop-adjust', handle: h, start: p, orig: { ...cropSel } } : { kind: 'crop-new', start: p };
    } else {
      drag = { kind: 'redact', start: p, rect: { x: Math.round(p.x), y: Math.round(p.y), w: 0, h: 0 } };
    }
    wrap.setPointerCapture(e.pointerId);
    updateDrag();
    if (!scrollRaf) scrollRaf = requestAnimationFrame(autoScroll);
  });

  wrap.addEventListener('pointermove', (e) => {
    if (drag) {
      lastPointer = { x: e.clientX, y: e.clientY };
      updateDrag();
    } else if (tool === 'crop') {
      const h = hitTest(e.clientX, e.clientY);
      wrap.style.cursor = h ? CURSORS[h] : 'crosshair';
    } else {
      wrap.style.cursor = 'crosshair';
    }
  });

  const endDrag = (e) => {
    if (!drag) return;
    if (e.type === 'pointerup') {
      lastPointer = { x: e.clientX, y: e.clientY };
      updateDrag();
    }
    const d = drag;
    drag = null;
    cancelAnimationFrame(scrollRaf);
    scrollRaf = 0;
    if (d.kind === 'redact') {
      hideSel();
      if (e.type === 'pointerup' && d.rect.w >= MIN_RECT && d.rect.h >= MIN_RECT) pushOp({ type: 'rect', ...d.rect });
      else drawSel(cropSel, 'crop');
    } else if (cropSel && (cropSel.w < MIN_RECT || cropSel.h < MIN_RECT)) {
      cancelCrop();
    }
    refreshUi();
  };
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
    } else if (k === 'b' || k === 'r') {
      setTool('redact');
    } else if (k === 'c') {
      setTool('crop');
    } else if (k === 'enter' && tool === 'crop') {
      e.preventDefault();
      applyCrop();
    } else if (k === 'escape') {
      if (drag) {
        endDrag({ type: 'cancel' });
        if (drag === null && tool === 'crop') cancelCrop();
      } else cancelCrop();
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

/* ------------------------------ export ----------------------------- */

function toBlob() {
  return new Promise((resolve, reject) => current.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), 'image/png'));
}

async function download() {
  if (!current) return;
  toast('Preparing PNG…', 0);
  try {
    const url = URL.createObjectURL(await toBlob());
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast('Downloaded');
  } catch (err) {
    toast(`Download failed: ${err.message}`);
  }
}

async function copy() {
  if (!current) return;
  try {
    // Passing the promise keeps the click's user activation while the PNG encodes.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': toBlob() })]);
    toast('Copied to clipboard');
  } catch (err) {
    toast(`Copy failed: ${err.message}`);
  }
}

function fileName() {
  const d = new Date(meta.createdAt || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
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
