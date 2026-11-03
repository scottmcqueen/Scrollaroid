import { saveCapture, pruneCaptures } from './db.js';

// Chrome allows roughly two captureVisibleTab calls per second.
const MIN_CAPTURE_INTERVAL_MS = 550;
// Time after each scroll for lazy content and animations to settle.
const SETTLE_MS = 250;
// Safety cap for infinite-scroll pages.
const MAX_FRAMES = 80;
const KEEP_CAPTURES_MS = 24 * 60 * 60 * 1000;

const DEFAULT_TITLE = 'Capture full page (Alt+Shift+S)';
const EVIDENCE_TITLE = 'Capture full page — Evidence mode on (Alt+Shift+S)';

let busy = false;

chrome.action.onClicked.addListener((tab) => captureTab(tab));

/* ---------------------------- evidence mode ---------------------------- */

async function evidenceEnabled() {
  const { evidenceMode = false } = await chrome.storage.local.get('evidenceMode');
  return evidenceMode;
}

async function setupMenu() {
  const on = await evidenceEnabled();
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'evidence-mode',
    type: 'checkbox',
    title: 'Evidence mode',
    checked: on,
    contexts: ['action'],
  });
  showEvidenceState(on);
}

function showEvidenceState(on) {
  chrome.action.setBadgeText({ text: on ? 'EV' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
  chrome.action.setTitle({ title: on ? EVIDENCE_TITLE : DEFAULT_TITLE });
}

chrome.runtime.onInstalled.addListener(setupMenu);
chrome.runtime.onStartup.addListener(setupMenu);
chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'evidence-mode') chrome.storage.local.set({ evidenceMode: info.checked });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('evidenceMode' in changes)) return;
  const on = !!changes.evidenceMode.newValue;
  showEvidenceState(on);
  chrome.contextMenus.update('evidence-mode', { checked: on }).catch(() => {});
});

async function sha256Hex(buf) {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function browserVersion() {
  try {
    const ua = await navigator.userAgentData.getHighEntropyValues(['fullVersionList', 'platformVersion']);
    const chrome = ua.fullVersionList.find((b) => /Chrome|Chromium/.test(b.brand));
    return `${chrome ? `${chrome.brand} ${chrome.version}` : 'Chromium'} on ${ua.platform} ${ua.platformVersion || ''}`.trim();
  } catch {
    return navigator.userAgent;
  }
}

async function captureTab(tab) {
  if (busy || !tab?.id) return;
  busy = true;
  const tabId = tab.id;
  let prepared = false;

  try {
    await setBadge(tabId, '…', '#4b5563');
    pruneCaptures(KEEP_CAPTURES_MS).catch(() => {});

    const evidence = await evidenceEnabled();
    const startedAt = new Date().toISOString();
    const info = await run(tabId, preparePage, [evidence]);
    prepared = true;

    const frames = [];
    let target = 0;
    let lastCapture = 0;
    let truncated = false;

    for (;;) {
      if (frames.length >= MAX_FRAMES) {
        truncated = true;
        break;
      }
      // In evidence mode nothing on the page is hidden, so the image shows exactly what was on screen.
      const step = await run(tabId, scrollStep, [target, !evidence && frames.length > 0]);
      // The page stopped moving: we've reached the bottom.
      if (frames.length && step.y <= frames[frames.length - 1].y + 0.5) break;

      const wait = Math.max(SETTLE_MS, MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCapture));
      await sleep(wait);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      lastCapture = Date.now();
      const blob = await (await fetch(dataUrl)).blob();
      const frame = { y: step.y, blob };
      if (evidence) {
        // Fingerprint each raw screen image the moment it's captured, before any processing.
        frame.capturedAt = new Date(lastCapture).toISOString();
        frame.sha256 = await sha256Hex(await blob.arrayBuffer());
      }
      frames.push(frame);

      const maxY = Math.max(0, step.contentH - info.bandH);
      const pct = Math.min(99, Math.round((100 * (step.y + info.bandH)) / Math.max(1, step.contentH)));
      setBadge(tabId, `${pct}%`, '#2563eb');
      if (step.y >= maxY - 0.5) break;
      target = step.y + info.bandH;
    }

    await run(tabId, restorePage);
    prepared = false;

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
        createdAt: Date.now(),
        evidence,
        ...(evidence && {
          startedAt,
          completedAt: new Date().toISOString(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          pageUrl: info.url,
          dpr: info.dpr,
          userAgent: navigator.userAgent,
          browser: await browserVersion(),
          toolVersion: chrome.runtime.getManifest().version,
        }),
      },
      frames,
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
      chrome.action.setTitle({ tabId, title: (await evidenceEnabled()) ? EVIDENCE_TITLE : DEFAULT_TITLE }).catch(() => {});
    }, 5000);
  } finally {
    busy = false;
  }
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

// Drop this tab's progress badge so the global one (EV in evidence mode) shows again.
async function clearBadge(tabId) {
  await chrome.action.setBadgeText({ tabId, text: null }).catch(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}));
  const on = await evidenceEnabled();
  chrome.action.setBadgeBackgroundColor({ tabId, color: on ? '#b45309' : '#4b5563' }).catch(() => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* The functions below are injected into the page. They must be fully  */
/* self-contained (no references to anything outside their own body).  */
/* ------------------------------------------------------------------ */

function preparePage(evidence) {
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
  if (scope && !evidence) {
    for (const el of scope.querySelectorAll('*')) {
      const p = getComputedStyle(el).position;
      if (p === 'fixed' || p === 'sticky') st.candidates.push({ el, p });
    }
  }

  return {
    vw,
    vh,
    bandTop,
    bandH,
    mode: container ? 'element' : 'window',
    url: location.href,
    dpr: window.devicePixelRatio,
  };
}

async function scrollStep(target, hideRepeating) {
  const st = window.__fpsState;
  const c = st.container;
  if (c) c.scrollTop = target;
  else window.scrollTo(0, target);
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

function restorePage() {
  const st = window.__fpsState;
  if (!st) return;
  for (const cand of st.candidates) {
    if (!cand.saved) continue;
    const s = cand.el.style;
    if (cand.saved.v) s.setProperty('visibility', cand.saved.v, cand.saved.p);
    else s.removeProperty('visibility');
  }
  if (st.container) st.container.scrollTop = st.containerY;
  window.scrollTo(st.winX, st.winY);
  st.style.remove();
  delete window.__fpsState;
}
