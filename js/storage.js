// Persistence: the layout (plants + settings) lives in localStorage,
// the scan files (often tens of MB) live in IndexedDB.

export const STATE_KEY = 'northall-garden.state.v1';
const DB_NAME = 'northall-garden';
const STORE = 'files';

export function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveState(state) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req?.result); };
    t.onerror = t.onabort = () => { db.close(); reject(t.error); };
  });
}

// files: array of { name, blob }
export const saveScanFiles = (files) => tx('readwrite', (s) => s.put(files, 'scan'));
export const loadScanFiles = () => tx('readonly', (s) => s.get('scan')).catch(() => null);
export const clearScanFiles = () => tx('readwrite', (s) => s.delete('scan'));

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
