// Tiny IndexedDB wrapper shared by the service worker and the editor page.
// Captures can be tens of megabytes, which is too big for chrome.storage or
// runtime messaging, so the frames are handed over as Blobs through IndexedDB.

const DB_NAME = 'scrollaroid';
const STORE = 'captures';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => {
      db.close();
      resolve(req && 'result' in req ? req.result : undefined);
    };
    tx.onerror = tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export const saveCapture = (id, data) => withStore('readwrite', (s) => s.put(data, id));
export const loadCapture = (id) => withStore('readonly', (s) => s.get(id));

// Captures are keyed by their creation timestamp; drop anything older than maxAgeMs.
export async function pruneCaptures(maxAgeMs) {
  const keys = (await withStore('readonly', (s) => s.getAllKeys())) || [];
  const cutoff = Date.now() - maxAgeMs;
  const stale = keys.filter((k) => Number(k) < cutoff);
  if (stale.length) await withStore('readwrite', (s) => stale.forEach((k) => s.delete(k)));
}
