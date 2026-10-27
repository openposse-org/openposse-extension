// Voice files to and from a folder on disk, for testing. Each build of OpenPosse has its own
// extension ID and so its own Cache Storage – the unpacked copy and the store beta never share
// a download – so a debug build exports what it has and another imports it instead of fetching
// 740 MB again (the owner's ask of 2026-10-26). Debug tools only.
//
// **A folder Chrome hands over, not a typed path.** An extension page cannot open a path given
// as a string; `showDirectoryPicker` gives a handle instead, and IndexedDB can keep a handle, so
// the folder is picked once and remembered. Chrome asks for access again each session.
//
// **Laid out as the caches are:** `<folder>/<cache name>/<file id>`. One folder holds both sets,
// and a set whose cache name moves on (`-v2`) never reads an older version's files.
//
// **Imported files are downloads with the folder standing in for the network**, through the
// set's own `download`, so each is checked against its pinned hash before it is kept. A file
// changed on disk is refused the way a bad download is.

import { KOKORO, SUPERTONIC, PHONON } from './weights.js';

export const SETS = [PHONON, SUPERTONIC, KOKORO];

/**
 * Copies every stored file of each set into `root`. Returns `{ written, missing }`: files
 * copied, and files the set has not downloaded here, which are skipped.
 */
export async function exportTo(root, sets = SETS) {
  let written = 0;
  let missing = 0;
  for (const set of sets) {
    const dir = await root.getDirectoryHandle(set.cache, { create: true });
    for (const file of set.files) {
      const hit = await set.stored(file.id);
      if (!hit) {
        missing += 1;
        continue;
      }
      const handle = await dir.getFileHandle(file.id, { create: true });
      const out = await handle.createWritable();
      await out.write(await hit.arrayBuffer());
      await out.close();
      written += 1;
    }
  }
  return { written, missing };
}

/**
 * Loads each set from `root`. Returns one `{ cache, found, ok, failed }` per set: `found` is
 * false for a set the folder has no files for, and `failed` lists `{ id, reason }` as
 * `download` does – a file absent from the folder is `HTTP 404`, a changed one a hash mismatch.
 */
export async function importFrom(root, sets = SETS) {
  const results = [];
  for (const set of sets) {
    let dir;
    try {
      dir = await root.getDirectoryHandle(set.cache);
    } catch (error) {
      if (error?.name !== 'NotFoundError') throw error;
      results.push({ cache: set.cache, found: false, ok: false, failed: [] });
      continue;
    }
    const idOf = new Map(set.files.map((file) => [file.url, file.id]));
    const fromFolder = async (url) => {
      try {
        const file = await (await dir.getFileHandle(idOf.get(url))).getFile();
        return new Response(file);
      } catch (error) {
        // Not there is the folder's 404; anything else is named, so it can be told apart.
        return { ok: false, status: error?.name === 'NotFoundError' ? 404 : error?.name ?? error };
      }
    };
    const { ok, failed } = await set.download({ fetchImpl: fromFolder });
    results.push({ cache: set.cache, found: true, ok, failed });
  }
  return results;
}

// ── The remembered folder ──────────────────────────────────────────────────────────────────

const DB = 'openposse-debug';
const STORE = 'handles';
const KEY = 'voice-folder';

function database() {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact(mode, work) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = work(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Keeps the picked folder for next time. */
export const rememberFolder = (handle) => transact('readwrite', (store) => store.put(handle, KEY));

/** The folder picked last time, or null. */
export async function rememberedFolder() {
  try {
    return (await transact('readonly', (store) => store.get(KEY))) ?? null;
  } catch (error) {
    console.warn('[openposse] could not read the remembered voice folder –', error?.message ?? error);
    return null;
  }
}

/**
 * Whether the page may use `handle` as `mode` ('read' or 'readwrite'), asking Chrome if it has
 * to. Asking needs the click that called this, so it comes before anything slow.
 */
export async function mayUse(handle, mode) {
  if ((await handle.queryPermission({ mode })) === 'granted') return true;
  return (await handle.requestPermission({ mode })) === 'granted';
}
