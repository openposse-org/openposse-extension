// The weights manifest and the verification that makes the amended rule true.
//
// `CLAUDE.md` now permits a download that is user-started, pinned and **verified**. The first
// two are visible in the UI; the third is only true if the code actually refuses a file that
// does not match — and the interesting case is not a corrupted download, it is a hash constant
// that was never filled in. A `null` that reads as a passed check would convert "verified" into
// "downloaded" silently, which is the whole thing the rule forbids.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MODEL, VOICES, ALL, TOTAL_BYTES, verify, digest, downloadWeights, DTYPE, KNOWN_DTYPES, langOf,
  weightsStatus,
} from '../src/weights.js';

/**
 * Minimal Cache Storage, so the download path can be exercised without a browser.
 *
 * **It enforces the scheme rule, and the first version did not.** Keying entries by our short
 * id passed every test here and failed all seven files in the browser with *"Request scheme
 * 'chrome-extension' is unsupported"* — because Cache Storage resolves a bare `'model'` against
 * the page and then refuses the result. A double more permissive than the thing it stands for
 * does not test the code; it agrees with it.
 */
function fakeCaches() {
  const store = new Map();
  globalThis.caches = {
    open: async () => ({
      match: async (k) => store.get(String(k)) ?? null,
      put: async (k, v) => {
        const key = String(k);
        if (!/^https?:\/\//.test(key)) {
          throw new TypeError(
            `Failed to execute 'put' on 'Cache': Request scheme '${key.split(':')[0]}' is unsupported`,
          );
        }
        store.set(key, v);
      },
    }),
    delete: async () => { store.clear(); return true; },
  };
  return store;
}

const response = (buffer) => ({ ok: true, status: 200, arrayBuffer: async () => buffer });

test('the URLs are pinned to a revision, not to a branch', () => {
  // A `main` URL is a moving target: the bytes behind it can change without the URL changing,
  // so a hash mismatch would one day mean "upstream rebuilt" rather than "something is wrong",
  // and the check would be retired as flaky. Pinning makes a mismatch mean what it should.
  for (const file of ALL) {
    assert.ok(!file.url.includes('/main/'), `${file.id} points at a branch: ${file.url}`);
    assert.match(file.url, /\/resolve\/[0-9a-f]{40}\//, file.id);
  }
});

test('the dtype and the model file agree, and the dtype is one that exists', () => {
  // The bug this earns its keep on, found three layers away at first use. `q8f16` names a real
  // published file — 6 MB smaller — but is not a dtype transformers.js recognises, so it was
  // **ignored rather than rejected** and the 326 MB fp32 default was requested instead.
  //
  // An unrecognised dtype is silent by design, which is why the pairing has to be asserted
  // here: nothing downstream will ever complain that the two disagree.
  assert.ok(KNOWN_DTYPES.includes(DTYPE), `${DTYPE} is not a dtype transformers.js accepts`);

  // transformers.js has **two** names that do not follow the pattern, and both are load-bearing
  // here: fp32 is the unsuffixed `model.onnx`, because it is the default the others are derived
  // from, and q8 is `model_quantized.onnx` from before the dtype names were generalised.
  // Everything else is `model_<dtype>.onnx`.
  const expected = {
    fp32: /(^|\/)model\.onnx$/,
    q8: /model_quantized\.onnx$/,
  }[DTYPE] ?? new RegExp(`model_${DTYPE}\\.onnx$`);

  assert.match(MODEL.url, expected, `the pinned file does not match dtype ${DTYPE}`);
});

test('all 28 voices, each named once', () => {
  // The whole published English set, 14.6 MB. It was six, on a comment claiming the full set
  // would be 28.7 MB — it is 14.6, so the other 22 cost 11.5 MB against a 326 MB model and the
  // saving never justified having two different answers to "which voices exist".
  assert.equal(VOICES.length, 28);
  assert.equal(new Set(VOICES.map((v) => v.id)).size, 28, 'no id listed twice');
  assert.ok(VOICES.every((v) => /^[ab][fm]_[a-z]+$/.test(v.id)), 'naming is <accent><gender>_<name>');

  // Both accents and both genders, or `assignKokoroVoices` cannot keep a British agent British.
  for (const prefix of ['af', 'am', 'bf', 'bm']) {
    assert.ok(VOICES.some((v) => v.id.startsWith(prefix)), `a ${prefix} voice`);
  }
});

test('the first six are still the first six, in order', () => {
  // **This is an upgrade guarantee, not tidiness.** An agent with no chosen voice is assigned
  // by position — the first free voice of its accent — so re-sorting this array hands every
  // auto-assigned agent a different voice on the next roster change, days later, with nothing
  // connecting cause to effect. The 22 additions go after the six that were already shipping.
  assert.deepEqual(
    VOICES.slice(0, 6).map((v) => v.id),
    ['bm_george', 'bf_emma', 'bm_daniel', 'af_heart', 'am_michael', 'af_bella'],
  );
});

test('a half-finished download and an install that grew are told apart', async () => {
  // **They are the same `partial` and the same fix, and that is exactly the trap.** The person
  // is not the same: "interrupted" sends somebody to look for a failure, and an install that
  // was complete when it was made and is now short some voices did not have one. This case
  // arrives the moment the voice set changes, so it is the upgrade path, not a hypothetical.
  const store = fakeCaches();
  const put = (id) => store.set(ALL.find((f) => f.id === id).url, response(new ArrayBuffer(1)));

  // Stopped early: the model is 96% of the bytes and `ALL` fetches it first, so it is exactly
  // what a download that gave up partway is missing.
  for (const f of ALL) if (f.id !== 'model') put(f.id);
  assert.equal((await weightsStatus()).core, false, 'no model — this one really was interrupted');

  // Grew: everything that is not a voice is here, and so are the six that used to be the set.
  store.clear();
  for (const f of ALL) if (!/^[ab][fm]_/.test(f.id)) put(f.id);
  for (const id of ['bm_george', 'bf_emma', 'bm_daniel', 'af_heart', 'am_michael', 'af_bella']) put(id);

  const grown = await weightsStatus();
  assert.equal(grown.state, 'partial');
  assert.equal(grown.core, true, 'the expensive part is already here');
  assert.equal(grown.want - grown.have, 22);
  assert.equal(grown.missingBytes, 22 * 522_240, 'summed from the manifest, not from a constant');
});

test('a voice id says its own accent', () => {
  // The rule Kokoro's naming already states, which had been written out by hand in two other
  // files. One of the two is how `bf_isabella` was offered on a machine that had six voices.
  assert.equal(langOf('bm_george'), 'en-GB');
  assert.equal(langOf('bf_lily'), 'en-GB');
  assert.equal(langOf('af_heart'), 'en-US');
  assert.equal(langOf('am_puck'), 'en-US');
});

test('the advertised total matches what is actually listed', () => {
  // The number setup shows before somebody commits their connection to it, so it has to be the
  // real sum rather than a figure that was true once.
  assert.equal(TOTAL_BYTES, ALL.reduce((n, f) => n + f.bytes, 0));

  // A sanity band, not an expectation, and it has now caught the model changing twice: ~89 MB
  // to ~166 MB (q8 → fp16, for GPU kernels), then to ~329 MB (fp16 → fp32, because fp16 turned
  // out to synthesise silence on WebGPU). Both were deliberate, and the test is doing its job
  // by making each one an explicit edit here rather than a number that drifted.
  //
  // The upper bound is where a download stops being something to offer casually. 329 MB is
  // already past that — it is offered on purpose, with the figure shown, and the ceiling is set
  // just above it so the *next* increase still has to be argued for.
  assert.ok(TOTAL_BYTES > 50e6 && TOTAL_BYTES < 400e6, `${Math.round(TOTAL_BYTES / 1e6)} MB`);
});

test('every file has a hash, and they look like hashes', () => {
  // The invariant the amended rule rests on. Adding a voice without its hash would sail past
  // review and quietly reduce "verified" to "downloaded" for that file alone.
  for (const file of ALL) {
    assert.match(file.sha256 ?? '', /^[0-9a-f]{64}$/, `${file.id} has no usable hash`);
    assert.ok(file.bytes > 0, file.id);
  }
  assert.equal(new Set(ALL.map((f) => f.sha256)).size, ALL.length, 'no two files share a hash');
});

test('a missing hash is "unverified", never a pass', async () => {
  // The failure mode this guards: a `null` that reads as a check that succeeded. Tested against
  // a synthetic file, since the real ones now carry hashes — which is what the test above is
  // there to keep true.
  assert.equal(await verify({ sha256: null }, new Uint8Array([1]).buffer), 'unverified');
  assert.equal(await verify({}, new Uint8Array([1]).buffer), 'unverified');
});

test('a matching hash passes and a wrong one does not', async () => {
  const buffer = new TextEncoder().encode('kokoro').buffer;
  const real = await digest(buffer);
  assert.equal(await verify({ sha256: real }, buffer), 'ok');
  assert.equal(await verify({ sha256: 'deadbeef' }, buffer), 'mismatch');
});

test('a file whose bytes do not match its hash is not stored', async () => {
  // The rule in one assertion, and now against the *real* pinned hashes: bytes that are not
  // what we asked for do not get installed, and the caller is told which file and why.
  const store = fakeCaches();
  const result = await downloadWeights({
    fetchImpl: async () => response(new Uint8Array([9, 9, 9]).buffer),
  });
  assert.equal(result.ok, false);
  assert.equal(result.failed.length, ALL.length);
  assert.ok(result.failed.every((f) => f.reason === 'mismatch'), 'every one rejected');
  assert.equal(store.size, 0, 'nothing was kept');
});

/** Swaps in hashes that match what the fake server serves, and puts the real ones back. */
async function withServedBytes(buffer, run) {
  const real = ALL.map((f) => f.sha256);
  const hash = await digest(buffer);
  for (const f of ALL) f.sha256 = hash;
  try {
    return await run();
  } finally {
    ALL.forEach((f, i) => { f.sha256 = real[i]; });
  }
}

test('a network failure names the file rather than aborting the rest', async () => {
  // One bad file out of six should not lose the other five: a partial state is recoverable by
  // pressing the button again, an all-or-nothing failure makes someone re-download 86 MB.
  const store = fakeCaches();
  const buffer = new TextEncoder().encode('x').buffer;
  const result = await withServedBytes(buffer, () => downloadWeights({
    fetchImpl: async (url) => (url.includes('af_heart')
      ? { ok: false, status: 404 }
      : response(buffer)),
  }));

  assert.equal(result.ok, false);
  assert.deepEqual(result.failed.map((f) => f.id), ['af_heart']);
  assert.equal(store.size, ALL.length - 1, 'the others were kept');
});

test('progress accounts for every file exactly once', async () => {
  const store = fakeCaches();
  const buffer = new TextEncoder().encode('x').buffer;

  const seen = [];
  await withServedBytes(buffer, () => downloadWeights({
    fetchImpl: async () => response(buffer),
    onProgress: (p) => seen.push(p),
  }));

  assert.equal(seen.length, ALL.length);
  assert.equal(seen[seen.length - 1].done, ALL.length);
  assert.equal(seen[seen.length - 1].bytes, TOTAL_BYTES, 'ends at the advertised total');
  assert.deepEqual(seen.map((p) => p.done), ALL.map((_, i) => i + 1), 'monotonic, no repeats');
  assert.equal(store.size, ALL.length);
});

test("a broken progress handler is not reported as a download failure", async () => {
  // It is the caller's code, not ours, and putting it inside the try made a broken status line
  // look like a network problem. On the already-stored path it was not caught at all — an
  // uncaught TypeError thrown by a download that had just succeeded.
  fakeCaches();
  const buffer = new TextEncoder().encode('x').buffer;
  const result = await withServedBytes(buffer, () => downloadWeights({
    fetchImpl: async () => response(buffer),
    onProgress: () => { throw new TypeError("Cannot read properties of null (reading 'classList')"); },
  }));
  assert.equal(result.ok, true, 'the files still downloaded');
  assert.deepEqual(result.failed, []);
});

test('an already-downloaded file is counted but not fetched again', async () => {
  // Pressing Download after an interrupted attempt finishes the job rather than restarting it.
  const store = fakeCaches();
  store.set(MODEL.url, new Response(new Uint8Array([1]).buffer));

  const asked = [];
  const buffer = new TextEncoder().encode('x').buffer;
  await withServedBytes(buffer, () => downloadWeights({
    fetchImpl: async (url) => { asked.push(url); return response(buffer); },
  }));

  assert.ok(!asked.some((u) => u.includes('model_q8f16')), 'the model was not re-fetched');
  assert.equal(asked.length, ALL.length - 1, 'everything else was');
});
