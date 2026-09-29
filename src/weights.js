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
 * The model comes from the **timestamped** repository, and the voices do not.
 *
 * Two repositories publish `model_q8f16.onnx` at the same 86.1 MB with different bytes, and the
 * first version of this file pinned the wrong one — it downloaded and verified perfectly, and
 * would have been loaded by an engine asking for the other. The hash check cannot save you from
 * correctly verifying the wrong file.
 *
 * `Kokoro-82M-v1.0-ONNX-timestamped` is what HeadTTS requests by default, and it emits
 * phoneme-level timings, which is what would let the orb follow real speech instead of a
 * synthesised envelope.
 *
 * The **voices are style vectors rather than model weights** and are shared between the two, so
 * they stay where they are — which also means the six already downloaded do not have to be
 * fetched again. Keying the cache by URL makes that automatic: only the model reads as missing.
 */
const TS_REVISION = 'dd4401a9add81ac692d20e240d22ec9dda82cc29';
const TS_REPO = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/resolve';

/**
 * What the engine must be told to ask for, exported so it cannot drift from what was fetched.
 *
 * `kokoro.js` configures HeadTTS with these. Two copies of a model id or a voice base — one
 * here and one there — is how the engine ends up requesting a file nobody downloaded, which is
 * a failure at first use rather than at build time.
 */
export const MODEL_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped';
export const VOICES_BASE = `${REPO}/${REVISION}/voices`;

/**
 * The model: **fp16**, chosen for the GPU rather than for the download.
 *
 * This was `q8` (92 MB) on the reasoning that smaller is better, and it measured **1.6× real
 * time** — six and a half seconds to synthesise four seconds of speech, twice in a row. That is
 * not conversation, it is waiting.
 *
 * The cause is a known shape rather than a mystery: **int8-quantized ONNX graphs frequently
 * have no WebGPU kernels**, so those operators fall back to the CPU while the rest runs on the
 * GPU. The result sits between WebGPU's ~0.3× and WASM's ~3×, which is exactly where the
 * measurement landed — and is why "is it using WebGPU" was the wrong question. It was, for part
 * of the graph.
 *
 * fp16 keeps the weights in a format the GPU has kernels for. 163 MB against 92: a real cost,
 * and the right one, because a voice nobody waits for is worth more than 71 MB.
 * `model_q4f16.onnx` is 155 MB and also GPU-friendly if size matters more than fidelity, though
 * 4-bit weights degrade a voice more audibly than they degrade text.
 *
 * `model_q8f16.onnx` is 86 MB and would have been ideal, but transformers.js 4.0.0 has no such
 * dtype — it was silently ignored and the 326 MB fp32 default requested instead.
 *
 * `DTYPE` is exported so `kokoro.js` cannot disagree with what was downloaded, and the test
 * below ties the two together: an unrecognised dtype fails at first use, not at build time.
 *
 * **The hashes are read, not guessed.** They come from HuggingFace's own API, which reports the
 * Git-LFS object id — and an LFS oid *is* the SHA-256 of the file's contents. Cross-checked:
 * the oid the API gives for `model_quantized.onnx` matches the SHA-256 published on its file
 * page, which is what establishes the two are the same thing rather than assuming it.
 *
 * Sizes are exact for the same reason, so a progress bar cannot overshoot.
 */
export const DTYPE = 'fp16';

export const MODEL = {
  id: 'model',
  url: `${TS_REPO}/${TS_REVISION}/onnx/model_fp16.onnx`,
  bytes: 163_232_776,
  sha256: '220724d5c5e0cc01be30f38faa6cf0c895a7cde6e7773e91db2973c8c7e5123c',
};

/**
 * What transformers.js 4.0.0 will accept, read from the bundled build rather than the docs.
 *
 * Kept so the test can assert `DTYPE` is one of them. An unrecognised name does not throw — it
 * is ignored, and the default fp32 model is requested instead, which surfaces as a refused
 * network request for a file nobody downloaded.
 */
export const KNOWN_DTYPES = ['fp32', 'fp16', 'q8', 'int8', 'uint8', 'q4', 'bnb4', 'q4f16'];

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

/**
 * The model's own paperwork, which transformers.js loads before the weights.
 *
 * Tiny — 3.6 kB between them — and completely load-bearing: `from_pretrained` reads
 * `config.json` to know what architecture it is building, and `AutoTokenizer` needs the other
 * two to turn phonemes into the ids the model expects. Without them the engine cannot start,
 * and the first version of this manifest had 89 MB of weights and none of these.
 *
 * Hashed here rather than read from the API, because these are stored inline in the repository
 * rather than through Git-LFS, so there is no object id to borrow. Fetched once and digested.
 */
const CONFIG = Object.entries({
  'config.json': 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
  'tokenizer.json': '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
  'tokenizer_config.json': 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
}).map(([name, sha256]) => ({
  id: name,
  url: `${TS_REPO}/${TS_REVISION}/${name}`,
  bytes: 4_000,
  sha256,
}));

export const ALL = [MODEL, ...CONFIG, ...VOICES];

/** Total download, for a sentence in setup that does not surprise anyone on a slow connection. */
export const TOTAL_BYTES = ALL.reduce((sum, f) => sum + f.bytes, 0);

const CACHE = 'openposse-kokoro-v1';

/**
 * The hosts a download actually touches — **both of them**.
 *
 * `huggingface.co/…/resolve/…` answers with a **302 to `us.aws.cdn.hf.co`**, and that response
 * carries `access-control-allow-origin: https://huggingface.co` rather than `*`. So a fetch
 * from an extension page is refused unless we hold host permission, and holding it for
 * `huggingface.co` alone is not enough — the bytes come from the CDN.
 *
 * Measured rather than assumed, after every file failed with a message the UI was throwing
 * away. A redirect to a second origin is invisible from the URL you wrote down.
 */
export const HOSTS = { origins: ['https://huggingface.co/*', 'https://*.hf.co/*'] };

/**
 * Asks for those hosts, if we do not already have them.
 *
 * **Must be called straight from the click.** `permissions.request` needs a live user gesture,
 * and an await before it spends one — the same trap that made the orb appear on Notion and
 * nowhere else. `contains` first, so a second download does not re-prompt.
 */
export async function ensureAccess() {
  try {
    if (await chrome.permissions.contains(HOSTS)) return true;
    return await chrome.permissions.request(HOSTS);
  } catch {
    return false;
  }
}

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

/**
 * Cached entries are keyed by their **source URL**, not by our short id.
 *
 * Cache Storage rejects any request scheme that is not http(s), and a bare `'model'` resolves
 * against the page — `chrome-extension://…/model` — so `put` fails with *"Request scheme
 * 'chrome-extension' is unsupported"*. The real URL is both a legal key and a better one: it
 * carries the pinned revision, so bumping `REVISION` invalidates the old entry by itself rather
 * than needing a migration.
 */
const keyFor = (id) => ALL.find((f) => f.id === id)?.url ?? null;

export async function stored(id) {
  const key = keyFor(id);
  if (!key) return null;
  try {
    const cache = await caches.open(CACHE);
    return (await cache.match(key)) ?? null;
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

  /**
   * Reports progress without letting the caller's UI break the download.
   *
   * **`onProgress` is somebody else's code and must not be inside our try.** In the loop below
   * a throw from it would be filed as a failure of the *file*, so a broken status line would
   * report a network problem — and on the already-stored path it was not caught at all, which
   * is an uncaught TypeError from a function that had just succeeded.
   *
   * Neither is a download failure, and neither should be silent, so it gets its own guard.
   */
  const notify = (id) => {
    try {
      onProgress({ id, done, total: ALL.length, bytes, totalBytes: TOTAL_BYTES });
    } catch (error) {
      console.warn('[openposse] weights progress handler threw —', error?.message ?? error);
    }
  };

  for (const file of ALL) {
    if (await stored(file.id)) {
      done += 1;
      bytes += file.bytes;
      notify(file.id);
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
      await cache.put(file.url, new Response(buffer));
      done += 1;
      bytes += file.bytes;
    } catch (error) {
      failed.push({ id: file.id, reason: String(error?.message ?? error) });
      continue;
    }
    notify(file.id);
  }

  return { ok: failed.length === 0, failed };
}
