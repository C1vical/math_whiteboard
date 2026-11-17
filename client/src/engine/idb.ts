import type { Notebook } from '../../../shared/types';

// Per-device safety copy: the latest notebook snapshot and the image blobs it uses.
// Every function swallows errors (private browsing, quota…) — the cache is best-effort.

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('mathboard', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('notebooks')) db.createObjectStore('notebooks');
        if (!db.objectStoreNames.contains('images')) db.createObjectStore('images');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

async function get<T>(store: string, key: string): Promise<T | null> {
  try {
    const db = await open();
    return await new Promise<T | null>((resolve) => {
      const req = db.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function put(store: string, key: string, value: unknown): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch { /* ignore */ }
}

export const getCachedNotebook = (id: string) => get<Notebook>('notebooks', id);
export const putCachedNotebook = (nb: Notebook) => put('notebooks', nb.id, nb);
export const getCachedImage = (src: string) => get<Blob>('images', src);
export const putCachedImage = (src: string, blob: Blob) => put('images', src, blob);
