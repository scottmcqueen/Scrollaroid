import { saveCapture, pruneCaptures } from './db.js';

// Chrome allows roughly two captureVisibleTab calls per second.
const MIN_CAPTURE_INTERVAL_MS = 550;
// Time after each scroll for lazy content and animations to settle.
const SETTLE_MS = 250;
// Safety cap for infinite-scroll pages.
const MAX_FRAMES = 80;
const KEEP_CAPTURES_MS = 24 * 60 * 60 * 1000;

let busy = false;
let stopRequested = false;

/* ------------------------------ triggers ------------------------------ */

// Clicking the icon captures the full page, or stops a capture in progress.
chrome.action.onClicked.addListener((tab) => trigger(tab, {}));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'capture-area') trigger(tab, { area: true });
});

const MENU = {
  'capture-page': {},
  'capture-area': { area: true },
};

async function setupMenu() {
  await chrome.contextMenus.removeAll();
  const add = (id, title) => chrome.contextMenus.create({ id, title, contexts: ['action'] });
  add('capture-page', 'Capture full page');
  add('capture-area', 'Capture selected area');
  add('help', 'Help and shortcuts');
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await setupMenu();
  // Tidy up settings left by earlier versions.
  chrome.storage?.local.clear().catch(() => {});
  chrome.action.setBadgeText({ text: '' });
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});
chrome.runtime.onStartup.addListener(setupMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'help') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  else if (MENU[info.menuItemId]) trigger(tab, MENU[info.menuItemId]);
});

// Esc on the page being captured.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'scrollaroid-stop' && busy) stopRequested = true;
});

function trigger(tab, opts) {
  if (busy) {
    stopRequested = true;
    return;
  }
  captureTab(tab, opts);
}

/* ------------------------------- capture ------------------------------- */

async function captureTab(tab, { area = false } = {}) {
  if (!tab?.id) return;
  busy = true;
  stopRequested = false;
  const tabId = tab.id;
  let prepared = false;

  try {
    pruneCaptures(KEEP_CAPTURES_MS).catch(() => {});

    let selection = null;
    if (area) {
      selection = await run(tabId, selectArea);
      if (!selection) return; // cancelled
    }

    await setBadge(tabId, '…', '#4b5563');
    const info = await run(tabId, preparePage);
    prepared = true;

    // Which part of the page to capture, in scroll positions.
    const singleScreen = !!selection && info.mode === 'element';
    let target = 0;
    let endY = Infinity; // content position the capture must reach
    if (singleScreen) {
      target = info.scrollPos;
    } else if (selection) {
      target = Math.max(0, selection.y);
      endY = selection.y + selection.h;
    }

    const frames = [];
    let lastCapture = 0;
    let truncated = false;
    let stoppedEarly = false;

    for (;;) {
      if (frames.length >= MAX_FRAMES) {
        truncated = true;
        break;
      }
      if (stopRequested && frames.length) {
        stoppedEarly = true;
        break;
      }
      const pct = frames.length ? progress(frames, info, endY) : 0;
      const step = await run(tabId, scrollStep, [target, frames.length > 0, `Capturing… ${pct}%`]);
      if (frames.length && step.y <= frames[frames.length - 1].y + 0.5) break; // reached the bottom
      if (!frames.length) await run(tabId, collectText, [1, step.y]);

      const wait = Math.max(SETTLE_MS, MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCapture));
      await sleep(Math.max(0, wait - 60));
      await run(tabId, hidePill); // keep the progress pill out of the image
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      lastCapture = Date.now();

      frames.push({ y: step.y, blob: await (await fetch(dataUrl)).blob() });
      info.contentH = step.contentH;
      setBadge(tabId, `${progress(frames, info, endY)}%`, '#2563eb');

      if (singleScreen) break;
      const maxY = Math.max(0, step.contentH - info.bandH);
      if (step.y >= maxY - 0.5) break;
      if (step.y + info.bandH >= endY) break;
      target = step.y + info.bandH;
    }

    const text = await run(tabId, collectText, [2, frames[0].y]).catch(() => null);
    await run(tabId, restorePage);
    prepared = false;

    // Area captures open with the selection already cropped (in CSS px of the stitched image).
    let initialCrop = null;
    if (selection) {
      const y0 = frames[0].y;
      const top = singleScreen ? selection.y : selection.y - y0;
      initialCrop = { x: selection.x, y: Math.max(0, top), w: selection.w, h: selection.h };
    }

    const id = String(Date.now());
    await saveCapture(id, {
      meta: {
        vw: info.vw,
        vh: info.vh,
        bandTop: info.bandTop,
        bandH: info.bandH,
        mode: info.mode,
        title: tab.title || '',
        url: tab.url || '',
        truncated,
        stoppedEarly,
        area: !!selection,
        initialCrop,
        createdAt: Date.now(),
      },
      frames,
      text,
    });

    await chrome.tabs.create({
      url: chrome.runtime.getURL(`editor.html?id=${id}`),
      index: tab.index + 1,
      openerTabId: tabId,
    });
    await clearBadge(tabId);
  } catch (err) {
    console.error('Scrollaroid:', err);
    if (prepared) await run(tabId, restorePage).catch(() => {});
    await setBadge(tabId, 'ERR', '#dc2626');
    await chrome.action.setTitle({ tabId, title: `Couldn't capture this page: ${err.message || err}` }).catch(() => {});
    setTimeout(async () => {
      await clearBadge(tabId);
      chrome.action.setTitle({ tabId, title: chrome.runtime.getManifest().action.default_title }).catch(() => {});
    }, 5000);
  } finally {
    busy = false;
    stopRequested = false;
  }
}

function progress(frames, info, endY) {
  const last = frames[frames.length - 1].y;
  const first = frames[0].y;
  const end = Math.min(endY, info.contentH ?? Infinity);
  if (!Number.isFinite(end)) return 0;
  return Math.min(99, Math.max(1, Math.round((100 * (last + info.bandH - first)) / Math.max(1, end - first))));
}

async function run(tabId, func, args = []) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res?.result;
}

function setBadge(tabId, text, color) {
  return Promise.all([
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color }),
  ]).catch(() => {});
}

async function clearBadge(tabId) {
  await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* The functions below are injected into the page. They must be fully  */
/* self-contained (no references to anything outside their own body).  */
/* ------------------------------------------------------------------ */

// Let the user drag out a rectangle on the live page. Resolves to document
// coordinates {x, y, w, h} in CSS px, or null if cancelled.
function selectArea() {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const css = `
        .layer { position: fixed; inset: 0; cursor: crosshair; }
        .shade { position: absolute; inset: 0; background: rgba(15, 23, 42, 0.35); }
        .sel { position: absolute; display: none; outline: 2px solid #3b82f6; box-shadow: 0 0 0 100000px rgba(15, 23, 42, 0.45); background: transparent; }
        .tip { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); background: #111827; color: #fff;
               font: 13px/1.4 system-ui, -apple-system, sans-serif; padding: 8px 14px; border-radius: 999px;
               box-shadow: 0 4px 18px rgba(0,0,0,.35); pointer-events: none; white-space: nowrap; }
        .tip b { font-weight: 600; }
        .size { position: absolute; font: 600 11px ui-monospace, Menlo, monospace; background: #111827; color: #fff; padding: 2px 6px; border-radius: 4px; transform: translateY(-120%); white-space: nowrap; }`;
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
    root.innerHTML = `
      <div class="layer"><div class="shade"></div><div class="sel"><span class="size"></span></div>
      <div class="tip"><b>Drag to select.</b> Drag past the edge to scroll. Esc to cancel.</div></div>`;
    const layer = root.querySelector('.layer');
    const shade = root.querySelector('.shade');
    const sel = root.querySelector('.sel');
    const size = root.querySelector('.size');
    document.documentElement.appendChild(host);

    let start = null;
    let last = null;
    let raf = 0;
    const doc = (cx, cy) => ({ x: cx + window.scrollX, y: cy + window.scrollY });
    const rect = () => {
      const a = start, b = doc(last.x, last.y);
      return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
    };
    const draw = () => {
      if (!start) return;
      const r = rect();
      shade.style.display = 'none';
      sel.style.display = 'block';
      sel.style.left = `${r.x - window.scrollX}px`;
      sel.style.top = `${r.y - window.scrollY}px`;
      sel.style.width = `${r.w}px`;
      sel.style.height = `${r.h}px`;
      size.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
    };
    const tick = () => {
      raf = 0;
      if (!start) return;
      const edge = 40;
      let dy = 0;
      if (last.y > window.innerHeight - edge) dy = Math.ceil((last.y - (window.innerHeight - edge)) / 2);
      else if (last.y < edge) dy = -Math.ceil((edge - last.y) / 2);
      if (dy) window.scrollBy(0, dy);
      draw();
      raf = requestAnimationFrame(tick);
    };
    const finish = (result) => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', draw, true);
      host.remove();
      // Two frames so the overlay is gone before anything is captured.
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(result)));
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    };

    layer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      layer.setPointerCapture(e.pointerId);
      start = doc(e.clientX, e.clientY);
      last = { x: e.clientX, y: e.clientY };
      draw();
      raf = requestAnimationFrame(tick);
    });
    layer.addEventListener('pointermove', (e) => {
      if (!start) return;
      last = { x: e.clientX, y: e.clientY };
      draw();
    });
    layer.addEventListener('pointerup', () => {
      if (!start) return;
      const r = rect();
      if (r.w < 8 || r.h < 8) {
        start = null;
        sel.style.display = 'none';
        shade.style.display = 'block';
        return;
      }
      finish(r);
    });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', draw, true);
  });
}

function preparePage() {
  const de = document.documentElement;
  const st = (window.__fpsState = { candidates: [] });

  st.style = document.createElement('style');
  st.style.textContent = `
    html, body { scroll-behavior: auto !important; }
    html { scrollbar-width: none !important; }
    html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }
  `;
  (document.head || de).appendChild(st.style);
  st.winX = window.scrollX;
  st.winY = window.scrollY;

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const se = document.scrollingElement || de;

  // Pages like web apps don't scroll the window; find the main scrolling panel instead.
  let container = null;
  if (se.scrollHeight <= window.innerHeight + 2) {
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('body *')) {
      if (el.scrollHeight <= el.clientHeight + 40) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      const r = el.getBoundingClientRect();
      const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (w * h > bestArea) {
        bestArea = w * h;
        best = el;
      }
    }
    if (best && bestArea > vw * vh * 0.2) container = best;
  }

  let bandTop = 0;
  let bandH = vh;
  if (container) {
    const r = container.getBoundingClientRect();
    bandTop = Math.max(0, r.top + container.clientTop);
    bandH = Math.min(container.clientHeight, vh - bandTop);
    st.containerY = container.scrollTop;
  }
  st.container = container;

  // Fixed and sticky elements would repeat in every frame; remember them so they
  // can be hidden after the first one.
  const scope = container || document.body;
  if (scope) {
    for (const el of scope.querySelectorAll('*')) {
      const p = getComputedStyle(el).position;
      if (p === 'fixed' || p === 'sticky') st.candidates.push({ el, p });
    }
  }

  // Progress pill, in a closed shadow root so page styles can't touch it.
  st.pillHost = document.createElement('div');
  st.pillHost.style.cssText = 'all:initial;position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483647;pointer-events:none;';
  const pr = st.pillHost.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
      div { font: 600 13px/1 system-ui, -apple-system, sans-serif; color: #fff; background: #111827; padding: 10px 16px;
            border-radius: 999px; box-shadow: 0 4px 18px rgba(0,0,0,.35); white-space: nowrap; }
      span { font-weight: 400; opacity: .7; margin-left: 8px; }`);
  pr.adoptedStyleSheets = [sheet];
  pr.innerHTML = '<div><b></b><span>Esc or click the icon to stop</span></div>';
  st.pillText = pr.querySelector('b');
  de.appendChild(st.pillHost);

  st.onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      chrome.runtime.sendMessage({ type: 'scrollaroid-stop' }).catch(() => {});
      st.pillText.textContent = 'Stopping…';
    }
  };
  window.addEventListener('keydown', st.onKey, true);

  return {
    vw,
    vh,
    bandTop,
    bandH,
    mode: container ? 'element' : 'window',
    scrollPos: container ? container.scrollTop : window.scrollY,
    url: location.href,
    dpr: window.devicePixelRatio,
  };
}

async function scrollStep(target, hideRepeating, pillLabel) {
  const st = window.__fpsState;
  const c = st.container;
  if (c) c.scrollTop = target;
  else window.scrollTo(0, target);
  if (st.pillText.textContent !== 'Stopping…') st.pillText.textContent = pillLabel;
  st.pillHost.style.visibility = 'visible';
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let refTop = 0;
  let refBottom = vh;
  if (c) {
    const r = c.getBoundingClientRect();
    refTop = r.top + c.clientTop;
    refBottom = refTop + c.clientHeight;
  }

  const setHidden = (cand, hide) => {
    const s = cand.el.style;
    if (hide && !cand.saved) {
      cand.saved = { v: s.getPropertyValue('visibility'), p: s.getPropertyPriority('visibility') };
      s.setProperty('visibility', 'hidden', 'important');
    } else if (!hide && cand.saved) {
      s.setProperty('visibility', cand.saved.v, cand.saved.p);
      if (!cand.saved.v) s.removeProperty('visibility');
      cand.saved = null;
    }
  };

  for (const cand of st.candidates) {
    if (!cand.el.isConnected) continue;
    if (!hideRepeating) {
      setHidden(cand, false);
      continue;
    }
    const r = cand.el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    let hide;
    if (cand.p === 'fixed') {
      // Leave full-screen backgrounds alone; hide headers, footers, chat bubbles, etc.
      hide = !(r.width >= vw * 0.95 && r.height >= vh * 0.95);
    } else {
      // Sticky: only hide while it's actually stuck to an edge.
      const cs = getComputedStyle(cand.el);
      const top = parseFloat(cs.top);
      const bottom = parseFloat(cs.bottom);
      hide =
        (!Number.isNaN(top) && Math.abs(r.top - (refTop + top)) < 1.5) ||
        (!Number.isNaN(bottom) && Math.abs(r.bottom - (refBottom - bottom)) < 1.5);
    }
    setHidden(cand, hide);
  }

  const se = document.scrollingElement || document.documentElement;
  return {
    y: c ? c.scrollTop : window.scrollY,
    contentH: c ? c.scrollHeight : se.scrollHeight,
  };
}

async function hidePill() {
  const st = window.__fpsState;
  if (!st) return;
  st.pillHost.style.visibility = 'hidden';
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

// Record where each word of text sits in the stitched image (CSS px), so the
// editor can find and redact text. Pass 1 runs at the first frame; pass 2 runs
// at the end and adds text that loaded during the scroll. Returns the index on pass 2.
function collectText(pass, firstY) {
  const st = window.__fpsState;
  if (!st) return null;
  const c = st.container;
  const MAX_WORDS = 200000;
  st.text ??= { nodes: [], seen: new WeakSet(), words: 0 };
  const idx = st.text;
  const scrollPos = c ? c.scrollTop : window.scrollY;
  const offset = scrollPos - firstY; // how far we've scrolled since the first frame
  const vh = window.innerHeight;
  let bandBottom = vh;
  let cRect = null;
  if (c) {
    cRect = c.getBoundingClientRect();
    bandBottom = cRect.top + c.clientTop + c.clientHeight;
  }

  const fixedCache = new WeakMap();
  const isPinned = (el) => {
    // Inside a fixed or sticky element (its position on screen doesn't follow the scroll).
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      if (fixedCache.has(e)) return fixedCache.get(e);
      const p = getComputedStyle(e).position;
      if (p === 'fixed' || p === 'sticky') {
        fixedCache.set(el, true);
        return true;
      }
    }
    fixedCache.set(el, false);
    return false;
  };

  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TEMPLATE', 'SVG']);
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !/\S/.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
      const p = n.parentElement;
      if (!p || skip.has(p.tagName.toUpperCase())) return NodeFilter.FILTER_REJECT;
      if (idx.seen.has(n)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const range = document.createRange();
  for (let n = walker.nextNode(); n && idx.words < MAX_WORDS; n = walker.nextNode()) {
    const el = n.parentElement;
    const inside = !c || c.contains(el);
    if (pass === 2) {
      if (!inside || isPinned(el)) continue; // only new, normally scrolling content
    }
    const text = n.nodeValue;
    const words = [];
    for (const m of text.matchAll(/\S+/g)) {
      range.setStart(n, m.index);
      range.setEnd(n, m.index + m[0].length);
      const r = range.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      let y = r.top + (pass === 2 ? offset : 0);
      if (c && !inside && r.top >= bandBottom) continue; // below an inner panel; not in the image
      words.push([m.index, m.index + m[0].length, +r.left.toFixed(1), +y.toFixed(1), +r.width.toFixed(1), +r.height.toFixed(1)]);
    }
    idx.seen.add(n);
    if (!words.length) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.opacity === '0') continue;
    idx.nodes.push({ t: text, w: words });
    idx.words += words.length;
  }
  range.detach?.();
  return pass === 2 ? { nodes: idx.nodes } : null;
}

function restorePage() {
  const st = window.__fpsState;
  if (!st) return;
  for (const cand of st.candidates) {
    if (!cand.saved) continue;
    const s = cand.el.style;
    if (cand.saved.v) s.setProperty('visibility', cand.saved.v, cand.saved.p);
    else s.removeProperty('visibility');
  }
  window.removeEventListener('keydown', st.onKey, true);
  st.pillHost.remove();
  if (st.container) st.container.scrollTop = st.containerY;
  window.scrollTo(st.winX, st.winY);
  st.style.remove();
  delete window.__fpsState;
}
