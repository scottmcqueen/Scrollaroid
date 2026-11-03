import { loadCapture, deleteCapture } from './db.js';
import { sha256Hex, addPngText, withFooter, makeZip, PdfReport } from './evidence.js';

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
let frames = [];
let stitchInfo = null; // {scale, joins}
let editLog = []; // evidence mode: timestamped list of edits
let originalCache = null; // evidence mode: promise of {bytes, sha256}
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

  const { canvas, scale, joins } = await stitch(data);
  base = canvas;
  frames = data.frames;
  stitchInfo = { scale, joins };
  crop = { x: 0, y: 0, w: base.width, h: base.height };
  const notes = [];
  if (scale < 0.999) notes.push(`Very tall page — scaled to ${Math.round(scale * 100)}% to fit Chrome's image size limit`);
  if (meta.truncated) notes.push(`Stopped after ${data.frames.length} screens (endless-scroll page?)`);
  $('#note').textContent = notes.join(' · ');

  if (meta.evidence) {
    $('#evidencePill').hidden = false;
    $('#package').hidden = false;
    $('#download').classList.remove('primary');
  }

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
  const joins = [];
  const put = (bmp, srcY, h, destY) => {
    if (h <= 0) return;
    ctx.drawImage(bmp, 0, srcY, W, h, 0, Math.round(destY * k), canvas.width, Math.round((destY + h) * k) - Math.round(destY * k));
  };

  for (let i = 0; i < frames.length; i++) {
    showMessage(`Stitching ${i + 1} of ${frames.length}…`);
    const bmp = i === 0 ? first : await createImageBitmap(frames[i].blob);
    const destY = bandTop + Math.round(frames[i].y * sy);
    if (i > 0) joins.push(Math.round(destY * k));
    if (i === 0) put(bmp, 0, bandTop, 0); // anything above a scrolling panel
    put(bmp, bandTop, bandH, destY);
    if (i === frames.length - 1) put(bmp, bandTop + bandH, bottomH, destY + bandH); // anything below it
    bmp.close();
  }
  return { canvas, scale: k, joins };
}

/* --------------------------- state & undo -------------------------- */

const snapshot = () => ({ crop: { ...crop }, rects: rects.map((r) => ({ ...r })) });
const sameRect = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
const sameState = (a, b) =>
  sameRect(a.crop, b.crop) && a.rects.length === b.rects.length && a.rects.every((r, i) => r.id === b.rects[i].id && sameRect(r, b.rects[i]));

// Record `before` as an undo step if the state has changed since then.
function commit(before, action) {
  if (sameState(before, snapshot())) return;
  logEdit(action);
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

function logEdit(action) {
  if (meta?.evidence && action) editLog.push({ at: new Date().toISOString(), action });
}

function undo() {
  if (!history.length || drag) return;
  logEdit('Undo');
  future.push(snapshot());
  restore(history.pop());
}

function redo() {
  if (!future.length || drag) return;
  logEdit('Redo');
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

function refreshUi() {
  $('#undo').disabled = !history.length;
  $('#redo').disabled = !future.length;
  $('.crop-actions').hidden = tool !== 'crop';
  $('.box-actions').hidden = tool !== 'redact' || selectedId == null;
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
  $('#package').addEventListener('click', async () => {
    const saved = await chrome.storage.local.get(['examiner', 'reference']).catch(() => ({}));
    $('#examiner').value = saved.examiner || '';
    $('#reference').value = saved.reference || '';
    $('#notes').value = '';
    $('#packageDialog').returnValue = '';
    $('#packageDialog').showModal();
  });
  $('#packageDialog').addEventListener('close', () => {
    if ($('#packageDialog').returnValue !== 'create') return;
    const caseInfo = {
      examiner: $('#examiner').value.trim(),
      reference: $('#reference').value.trim(),
      notes: $('#notes').value.trim(),
    };
    chrome.storage.local.set({ examiner: caseInfo.examiner, reference: caseInfo.reference }).catch(() => {});
    $('#package').disabled = true;
    exportPackage(caseInfo)
      .catch((err) => {
        console.error(err);
        toast(`Package failed: ${err.message}`);
      })
      .finally(() => ($('#package').disabled = false));
  });
  $('#confirmDiscard').addEventListener('close', () => {
    if ($('#confirmDiscard').returnValue === 'discard') discard();
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
const blobBytes = async (b) => new Uint8Array(await b.arrayBuffer());

// The image as shared: cropped, redactions burned in, and in evidence mode a provenance footer.
async function exportBlob() {
  const flat = flatten();
  if (!meta.evidence) {
    try {
      return await canvasBlob(flat);
    } finally {
      flat.width = flat.height = 0;
    }
  }
  const original = await getOriginal();
  const stamped = withFooter(flat, footerLines(original.sha256));
  flat.width = flat.height = 0;
  try {
    const bytes = addPngText(await blobBytes(await canvasBlob(stamped)), pngMeta('Redacted copy', original.sha256));
    return new Blob([bytes], { type: 'image/png' });
  } finally {
    stamped.width = stamped.height = 0;
  }
}

/* -------------------------- evidence export ------------------------ */

const fmtUtc = (iso) => iso && iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
function fmtLocal(iso) {
  if (!iso) return '';
  const tz = meta.timeZone;
  try {
    return `${new Date(iso).toLocaleString('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'long' })} (${tz})`;
  } catch {
    return new Date(iso).toString();
  }
}

// The stitched, unedited image. Encoded once so its hash stays stable for the session.
function getOriginal() {
  originalCache ??= (async () => {
    const png = await blobBytes(await canvasBlob(base));
    const bytes = addPngText(png, pngMeta('Original (unedited) full-page capture'));
    return { bytes, sha256: await sha256Hex(bytes) };
  })();
  return originalCache;
}

function pngMeta(kind, originalSha) {
  return {
    Title: meta.title,
    Source: meta.pageUrl || meta.url,
    'Creation Time': meta.startedAt,
    Software: `Scrollaroid ${meta.toolVersion} (evidence mode)`,
    Description: kind,
    'Original SHA-256': originalSha,
  };
}

function cropInBase() {
  return crop.x || crop.y || crop.w !== base.width || crop.h !== base.height ? { ...crop } : null;
}

// Redaction boxes that are at least partly inside the final crop, in original-image pixels.
function visibleRedactions() {
  return rects
    .filter((r) => r.x < crop.x + crop.w && r.x + r.w > crop.x && r.y < crop.y + crop.h && r.y + r.h > crop.y)
    .map(({ x, y, w, h }) => ({ x, y, w, h }));
}

function editsSummary() {
  const c = cropInBase();
  const n = visibleRedactions().length;
  const parts = [];
  if (c) parts.push(`cropped to ${c.w}x${c.h} at (${c.x}, ${c.y})`);
  if (n) parts.push(`${n} area${n === 1 ? '' : 's'} redacted`);
  return parts.length ? parts.join('; ') : 'none';
}

function footerLines(originalSha) {
  return [
    `Captured with Scrollaroid ${meta.toolVersion} in evidence mode`,
    `URL: ${meta.pageUrl || meta.url}`,
    `Captured: ${fmtUtc(meta.startedAt)}  |  ${fmtLocal(meta.startedAt)}`,
    `Original image SHA-256: ${originalSha}`,
    `Edits to this copy: ${editsSummary()}`,
  ];
}

async function exportPackage(caseInfo) {
  const stamp = fileStamp();
  const folder = `Scrollaroid evidence ${stamp}`;
  const exportedAt = new Date().toISOString();
  const files = []; // {name, data, sha256}
  const addFile = async (name, data) => {
    const f = { name, data, sha256: await sha256Hex(data) };
    files.push(f);
    return f;
  };

  toast('Packaging: original image…', 0);
  const original = await getOriginal();
  await addFile('original.png', original.bytes);

  toast('Packaging: redacted copy…', 0);
  const redacted = await addFile('redacted.png', await blobBytes(await exportBlob()));

  toast('Packaging: raw frames…', 0);
  const frameFiles = [];
  for (let i = 0; i < frames.length; i++) {
    const name = `frames/frame-${String(i + 1).padStart(3, '0')}.png`;
    const bytes = await blobBytes(frames[i].blob);
    const f = await addFile(name, bytes);
    frameFiles.push({
      file: name,
      scrollY: frames[i].y,
      capturedAt: frames[i].capturedAt,
      sha256AtCapture: frames[i].sha256,
      sha256: f.sha256,
      matchesCaptureHash: frames[i].sha256 === f.sha256,
    });
  }

  toast('Packaging: report…', 0);
  const redactedImg = await createImageBitmap(new Blob([redacted.data], { type: 'image/png' }));
  const report = await buildReport({ caseInfo, exportedAt, files, frameFiles, redactedImg });
  redactedImg.close();
  const reportFile = await addFile('report.pdf', report);

  const manifest = {
    format: 'scrollaroid-evidence/1',
    tool: { name: 'Scrollaroid', version: meta.toolVersion, exportedWith: chrome.runtime.getManifest().version },
    case: caseInfo,
    capture: {
      url: meta.pageUrl || meta.url,
      tabUrl: meta.url,
      title: meta.title,
      startedAt: meta.startedAt,
      completedAt: meta.completedAt,
      timeZone: meta.timeZone,
      browser: meta.browser,
      userAgent: meta.userAgent,
      viewport: { width: meta.vw, height: meta.vh, devicePixelRatio: meta.dpr },
      scrollMode: meta.mode === 'element' ? 'inner scrolling panel' : 'window',
      repeatingElementsHidden: false,
      truncatedAtFrameLimit: !!meta.truncated,
      frames: frameFiles,
    },
    original: {
      file: 'original.png',
      sha256: original.sha256,
      width: base.width,
      height: base.height,
      scaledToFitCanvasLimit: stitchInfo.scale < 0.999 ? stitchInfo.scale : 1,
      frameJoinsAtY: stitchInfo.joins,
    },
    redacted: {
      file: 'redacted.png',
      sha256: redacted.sha256,
      derivedFrom: 'original.png',
      crop: cropInBase(),
      redactions: visibleRedactions(),
      footerAdded: true,
    },
    report: { file: 'report.pdf', sha256: reportFile.sha256 },
    editLog,
    exportedAt,
    note: 'Coordinates are in original.png pixels. Every file is listed in SHA256SUMS.txt.',
  };
  await addFile('manifest.json', new TextEncoder().encode(JSON.stringify(manifest, null, 2)));

  const sums = files.map((f) => `${f.sha256}  ${f.name}`).join('\n') + '\n';
  files.push({ name: 'SHA256SUMS.txt', data: new TextEncoder().encode(sums) });

  const zip = makeZip(files.map((f) => ({ name: `${folder}/${f.name}`, data: f.data })));
  saveBlob(zip, `${folder}.zip`);
  toast('Evidence package downloaded');
}

async function buildReport({ caseInfo, exportedAt, files, frameFiles, redactedImg }) {
  const pdf = new PdfReport();
  const sha = (name) => files.find((f) => f.name === name)?.sha256 || '';

  pdf.text('Web capture record', { font: 'bold', size: 18, gap: 6 });
  pdf.text(meta.title || meta.url, { size: 11, color: 0.3, gap: 10 });
  pdf.rule();

  pdf.text('Capture', { font: 'bold', size: 11, gap: 6 });
  pdf.field('URL', meta.pageUrl || meta.url);
  pdf.field('Page title', meta.title);
  pdf.field('Capture started', `${fmtUtc(meta.startedAt)}  (${fmtLocal(meta.startedAt)})`);
  pdf.field('Capture finished', fmtUtc(meta.completedAt));
  pdf.field('Browser', meta.browser);
  pdf.field('Window size', `${meta.vw} x ${meta.vh} CSS px at ${meta.dpr}x pixel density`);
  pdf.field('Screens captured', `${frames.length}${meta.truncated ? ' (stopped at the frame limit; the page may continue)' : ''}`);
  pdf.field('Tool', `Scrollaroid ${meta.toolVersion}, evidence mode`);
  pdf.space(6);

  if (caseInfo.examiner || caseInfo.reference || caseInfo.notes) {
    pdf.text('Case', { font: 'bold', size: 11, gap: 6 });
    if (caseInfo.examiner) pdf.field('Captured by', caseInfo.examiner);
    if (caseInfo.reference) pdf.field('Reference', caseInfo.reference);
    if (caseInfo.notes) pdf.field('Notes', caseInfo.notes);
    pdf.space(6);
  }

  pdf.text('Method', { font: 'bold', size: 11, gap: 6 });
  pdf.text(
    `The page was scrolled automatically from top to bottom and captured as ${frames.length} screen image${frames.length === 1 ? '' : 's'} using Chrome's built-in tab capture. ` +
      'Nothing on the page was hidden or altered, so headers or other elements fixed to the screen can appear more than once. ' +
      'Each screen image was fingerprinted with SHA-256 at the moment it was captured, before any processing. ' +
      'The screen images were then joined vertically to form original.png. ' +
      'redacted.png is a separate copy made from original.png; the crop and the opaque black redaction areas listed below were applied to that copy only. ' +
      'original.png and the raw screen images are included unaltered.',
    { size: 9.5, gap: 3.5 },
  );
  if (stitchInfo.scale < 0.999) {
    pdf.text(`Because the page was very tall, original.png was scaled to ${Math.round(stitchInfo.scale * 100)}% of full resolution to fit Chrome's image size limit. The raw screen images are full resolution.`, { size: 9.5, gap: 3.5 });
  }
  pdf.space(6);

  pdf.text('Edits in redacted.png', { font: 'bold', size: 11, gap: 6 });
  const c = cropInBase();
  pdf.field('Crop', c ? `x ${c.x}, y ${c.y}, width ${c.w}, height ${c.h} (pixels of original.png)` : 'None');
  const reds = visibleRedactions();
  pdf.field('Redacted areas', reds.length ? reds.map((r, i) => `${i + 1}. x ${r.x}, y ${r.y}, ${r.w} x ${r.h}`).join('\n') : 'None');
  pdf.field('Footer', 'A provenance band (URL, capture time, original hash, edit summary) was added below the image.');
  pdf.space(6);

  pdf.text('File fingerprints (SHA-256)', { font: 'bold', size: 11, gap: 6 });
  for (const name of ['original.png', 'redacted.png']) {
    pdf.text(name, { font: 'bold', size: 9, gap: 2 });
    pdf.text(sha(name), { font: 'mono', size: 8.5, gap: 5 });
  }
  pdf.text('Raw screen images are listed at the end of this report. All files, including this report, are listed in SHA256SUMS.txt.', { size: 9, gap: 4, color: 0.3 });
  pdf.space(6);

  pdf.text('How to verify', { font: 'bold', size: 11, gap: 6 });
  pdf.text('Open a terminal in the package folder and run one of:', { size: 9.5, gap: 3 });
  pdf.text('macOS / Linux:  shasum -a 256 -c SHA256SUMS.txt', { font: 'mono', size: 8.5, gap: 3, indent: 10 });
  pdf.text('Windows:  Get-FileHash -Algorithm SHA256 <file>', { font: 'mono', size: 8.5, gap: 5, indent: 10 });
  pdf.text('Every file should report OK, or its hash should match the value listed. Any change to a file, even one pixel, produces a different fingerprint.', { size: 9.5, gap: 3.5 });
  pdf.space(6);
  pdf.text(`Report generated ${fmtUtc(exportedAt)}. This report records how the capture was made; it is not a legal opinion.`, { size: 8.5, color: 0.4 });

  // The redacted image, sliced into page-sized JPEGs.
  const area = PdfReport.imageArea();
  const sliceH = Math.max(1, Math.floor((redactedImg.width * area.h) / area.w));
  const slices = Math.ceil(redactedImg.height / sliceH);
  const tmp = document.createElement('canvas');
  for (let i = 0; i < slices; i++) {
    const y = i * sliceH;
    const h = Math.min(sliceH, redactedImg.height - y);
    tmp.width = redactedImg.width;
    tmp.height = h;
    const ctx = tmp.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, tmp.width, h);
    ctx.drawImage(redactedImg, 0, y, redactedImg.width, h, 0, 0, tmp.width, h);
    const jpg = await blobBytes(await canvasBlob(tmp, 'image/jpeg', 0.9));
    pdf.imagePage(jpg, tmp.width, h, `redacted.png, part ${i + 1} of ${slices} (pixels ${y}-${y + h} of ${redactedImg.height}). JPEG preview; the PNG in this package is the reference copy.`);
  }
  tmp.width = tmp.height = 0;

  pdf.newPage();
  pdf.text('Raw screen images', { font: 'bold', size: 11, gap: 6 });
  pdf.text('Fingerprinted when captured. "Match" confirms the file in this package is identical to what was captured.', { size: 9, gap: 6, color: 0.3 });
  for (const f of frameFiles) {
    pdf.text(`${f.file}   scroll ${f.scrollY}px   ${fmtUtc(f.capturedAt)}   ${f.matchesCaptureHash ? 'Match' : 'MISMATCH'}`, { size: 8.5, gap: 2 });
    pdf.text(f.sha256, { font: 'mono', size: 8, gap: 5, indent: 10 });
  }

  return pdf.build(`Scrollaroid evidence record  |  ${meta.pageUrl || meta.url}`);
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
