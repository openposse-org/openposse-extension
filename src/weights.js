// Kokoro's weights: what they are, where they come from, and how we know they are what we
// asked for.
//
// **This file is the whole of the amended rule made real.** `CLAUDE.md` permits a model to be
// downloaded from setup, when the user asks, from a pinned URL, verified against a hash baked
// into the build. Every one of those clauses is a line of code here, and the verification is
// the one that turns a promise into a property: a model is code in every sense that counts, and
// one that arrives unverified is arbitrary code from a third party.
//
// Nothing here is called during a turn. Speaking reads from local storage or falls back to the
// system voices; it never fetches.

/**
 * Where the files live, pinned to a **revision** rather than to `main`.
 *
 * A `main` URL is a moving target: the file behind it can change without the URL changing, so
 * the hash below would start failing one day for reasons nobody could see from here. Pinning
 * the commit makes the bytes immutable and makes a hash mismatch mean what it should — that
 * something is wrong — rather than that upstream published a new build.
 */
const REVISION = 'a70f0e45c1cc0df9abdfbfa0f6dee9073579ee99';
const REPO = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve';

const at = (path) => `${REPO}/${REVISION}/${path}`;

/**
 * The model: q8f16, the smallest variant that is not visibly degraded.
 *
 * 86 MB against 326 MB for fp32 and 163 MB for fp16. The full-precision model is better and
 * nobody is going to download a third of a gigabyte to hear a joke read out.
 *
 * **The hashes are read, not guessed.** They come from HuggingFace's own API, which reports the
 * Git-LFS object id — and an LFS oid *is* the SHA-256 of the file's contents. Cross-checked:
 * the oid the API gives for `model_quantized.onnx` matches the SHA-256 published on its file
 * page, which is what establishes the two are the same thing rather than assuming it.
 *
 * Sizes are exact for the same reason, so a progress bar cannot overshoot.
 */
export const MODEL = {
  id: 'model',
  url: at('onnx/model_q8f16.onnx'),
  bytes: 86_033_585,
  sha256: '04c658aec1b6008857c2ad10f8c589d4180d0ec427e7e6118ceb487e215c3cd0',
};

/**
 * Six voices, which is more than any plausible roster and about 3 MB.
 *
 * Three British and three American, split by gender, so `assignKokoroVoices` can keep an
 * agent's accent and still hand every agent something different. All 28 would be 28.7 MB for
 * voices nobody has asked for.
 */
export const VOICES = Object.entries({
  bm_george: 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc',
  bf_emma: '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73',
  bm_daniel: '6b3194bbceffb746733cbc22c8f593dd44e401a71d53895a2dca891bc595a1e8',
  af_heart: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
  am_michael: '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1',
  af_bella: 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b',
}).map(([id, sha256]) => ({
  id,
  url: at(`voices/${id}.bin`),
  bytes: 522_240,
  sha256,
}));

export const ALL = [MODEL, ...VOICES];

/** Total download, for a sentence in setup that does not surprise anyone on a slow connection. */
export const TOTAL_BYTES = ALL.reduce((sum, f) => sum + f.bytes, 0);

const CACHE = 'openposse-kokoro-v1';

// ── Verification ──────────────────────────────────────────────────────────────────────────

/** Hex SHA-256 of a buffer, via WebCrypto. */
export async function digest(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether a downloaded file is the file we pinned.
 *
 * **An unmeasured hash returns `unverified`, never `true`.** The difference matters: `true`
 * would let a null constant read as a passed check, which is precisely the failure this
 * function exists to prevent. The caller decides what to do with `unverified` — setup refuses,
 * and says so, rather than installing something it cannot vouch for.
 */
export async function verify(file, buffer) {
  if (!file.sha256) return 'unverified';
  return (await digest(buffer)) === file.sha256 ? 'ok' : 'mismatch';
}

// ── Storage ───────────────────────────────────────────────────────────────────────────────
//
// Cache Storage rather than IndexedDB: these are large immutable blobs fetched over HTTP, which
// is exactly what it is for, and it hands back a `Response` so the reader gets `arrayBuffer()`
// without a serialisation step. Version in the cache name, so a future model is a new cache
// rather than a migration.

export async function stored(id) {
  try {
    const cache = await caches.open(CACHE);
    return (await cache.match(id)) ?? null;
  } catch {
    return null;
  }
}

export async function readWeight(id) {
  const hit = await stored(id);
  return hit ? hit.arrayBuffer() : null;
}

/** `missing` · `partial` · `ready`. Partial is worth naming: a download that was interrupted. */
export async function weightsStatus() {
  const present = await Promise.all(ALL.map(async (f) => Boolean(await stored(f.id))));
  const count = present.filter(Boolean).length;
  if (count === 0) return { state: 'missing', have: 0, want: ALL.length };
  if (count < ALL.length) return { state: 'partial', have: count, want: ALL.length };
  return { state: 'ready', have: count, want: ALL.length };
}

export async function removeWeights() {
  try {
    await caches.delete(CACHE);
    return true;
  } catch {
    return false;
  }
}

// ── Downloading ───────────────────────────────────────────────────────────────────────────

/**
 * Fetches everything that is missing, verifying each file before it is kept.
 *
 * Sequential rather than parallel, and deliberately: six concurrent requests for 89 MB saturate
 * a modest connection, and the progress then reports six things all moving at once, which reads
 * as slower than it is. One at a time is honest about what is happening.
 *
 * `fetchImpl` is a seam so the accounting can be tested without the network. It is the only
 * reason this function is testable at all, and the accounting is the part with the bugs in it.
 *
 * @param onProgress `{ id, done, total, bytes, totalBytes }`
 * @returns `{ ok, failed: [{ id, reason }] }`
 */
export async function downloadWeights({ onProgress = () => {}, fetchImpl = fetch } = {}) {
  const failed = [];
  let bytes = 0;
  let done = 0;

  for (const file of ALL) {
    if (await stored(file.id)) {
      done += 1;
      bytes += file.bytes;
      onProgress({ id: file.id, done, total: ALL.length, bytes, totalBytes: TOTAL_BYTES });
      continue;
    }

    try {
      const response = await fetchImpl(file.url);
      if (!response?.ok) throw new Error(`HTTP ${response?.status ?? '?'}`);
      const buffer = await response.arrayBuffer();

      const check = await verify(file, buffer);
      if (check !== 'ok') {
        // **Not stored, on either failure.** A mismatch is the case this exists for; an
        // unmeasured hash is our own omission, and installing anyway would quietly convert
        // "verified" into "downloaded", which is the whole thing the rule forbids.
        failed.push({ id: file.id, reason: check });
        continue;
      }

      const cache = await caches.open(CACHE);
      await cache.put(file.id, new Response(buffer));
      done += 1;
      bytes += file.bytes;
      onProgress({ id: file.id, done, total: ALL.length, bytes, totalBytes: TOTAL_BYTES });
    } catch (error) {
      failed.push({ id: file.id, reason: String(error?.message ?? error) });
    }
  }

  return { ok: failed.length === 0, failed };
}
