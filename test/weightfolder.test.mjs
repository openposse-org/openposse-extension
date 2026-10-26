// Voice files to and from a folder: what one build exports, another imports, verified.
//
// The folder is a double of the File System Access handles, and Cache Storage one of named
// caches, so a round trip runs without a browser. Each test makes its own small set, with real
// hashes, so nothing here leans on the 740 MB the real sets describe.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { weightSet, digest } from '../src/weights.js';
import { exportTo, importFrom } from '../src/weightfolder.js';

function namedCaches() {
  const caches = new Map();
  const named = (name) => {
    if (!caches.has(name)) caches.set(name, new Map());
    return caches.get(name);
  };
  globalThis.caches = {
    open: async (name) => ({
      match: async (k) => named(name).get(String(k)) ?? null,
      put: async (k, v) => { named(name).set(String(k), v); },
    }),
    delete: async (name) => caches.delete(name),
  };
  return caches;
}

/** A folder as `showDirectoryPicker` hands one over, held in maps. */
function folder() {
  const dirs = new Map();
  const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' });
  return {
    dirs,
    async getDirectoryHandle(name, { create = false } = {}) {
      if (!dirs.has(name)) {
        if (!create) throw notFound();
        dirs.set(name, new Map());
      }
      const files = dirs.get(name);
      return {
        async getFileHandle(id, { create: make = false } = {}) {
          if (!files.has(id) && !make) throw notFound();
          return {
            getFile: async () => new Blob([files.get(id)]),
            createWritable: async () => ({
              write: async (data) => { files.set(id, new Uint8Array(data)); },
              close: async () => {},
            }),
          };
        },
      };
    },
  };
}

const bytes = (text) => new TextEncoder().encode(text).buffer;

async function smallSet(cache) {
  const files = [
    { id: 'graph', url: `https://example.test/${cache}/graph.onnx`, bytes: 5, sha256: await digest(bytes('graph')) },
    { id: 'voice', url: `https://example.test/${cache}/voice.bin`, bytes: 5, sha256: await digest(bytes('voice')) },
  ];
  return weightSet({ files, cache });
}

const served = (set) => async (url) => {
  const file = set.files.find((f) => f.url === url);
  return new Response(bytes(file.id));
};

test('what one build exports, another imports, and the files are checked on the way in', async () => {
  const set = await smallSet('openposse-test-v1');
  const dir = folder();

  // The first build downloads, then exports into the folder, under the cache's name.
  namedCaches();
  assert.equal((await set.download({ fetchImpl: served(set) })).ok, true);
  assert.deepEqual(await exportTo(dir, [set]), { written: 2, missing: 0 });
  assert.deepEqual([...dir.dirs.get('openposse-test-v1').keys()], ['graph', 'voice']);

  // The second build has storage of its own, empty, and fills it from the folder.
  namedCaches();
  assert.equal((await set.status()).state, 'missing');
  const [result] = await importFrom(dir, [set]);
  assert.deepEqual(result, { cache: 'openposse-test-v1', found: true, ok: true, failed: [] });
  assert.equal((await set.status()).state, 'ready');
});

test('a file changed in the folder is refused, as a bad download would be', async () => {
  const set = await smallSet('openposse-test-v1');
  const dir = folder();
  namedCaches();
  await set.download({ fetchImpl: served(set) });
  await exportTo(dir, [set]);
  dir.dirs.get('openposse-test-v1').set('voice', new TextEncoder().encode('other'));

  namedCaches();
  const [result] = await importFrom(dir, [set]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed.map((f) => f.id), ['voice']);
  assert.equal((await set.status()).state, 'partial');
});

test('a set the folder has nothing for is said so, and one missing a file names it', async () => {
  const set = await smallSet('openposse-test-v1');
  const other = await smallSet('openposse-other-v1');
  const dir = folder();
  namedCaches();
  await set.download({ fetchImpl: served(set) });
  await exportTo(dir, [set]);
  dir.dirs.get('openposse-test-v1').delete('graph');

  namedCaches();
  const [mine, theirs] = await importFrom(dir, [set, other]);
  assert.deepEqual(mine.failed, [{ id: 'graph', reason: 'HTTP 404' }]);
  assert.deepEqual(theirs, { cache: 'openposse-other-v1', found: false, ok: false, failed: [] });
});

test('only what this build has is exported', async () => {
  const set = await smallSet('openposse-test-v1');
  const dir = folder();
  namedCaches();
  assert.deepEqual(await exportTo(dir, [set]), { written: 0, missing: 2 });
});
