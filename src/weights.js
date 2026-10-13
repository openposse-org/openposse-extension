// Kokoro's weights: what they are, where they come from, and how we know they are what we
// asked for.
//
// **This file is the whole of the amended rule made real.** The local-only rule, as amended on
// 2026-09-26, permits a model to be downloaded from setup, when the user asks, from a pinned
// URL, verified against a hash baked into the build. Every one of those clauses is a line of code here, and the verification is
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
 * the commit makes the bytes immutable and makes a hash mismatch mean what it should – that
 * something is wrong – rather than that upstream published a new build.
 */
const REVISION = 'a70f0e45c1cc0df9abdfbfa0f6dee9073579ee99';
const REPO = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve';

const at = (path) => `${REPO}/${REVISION}/${path}`;

/**
 * The model comes from the **timestamped** repository, and the voices do not.
 *
 * Two repositories publish `model_q8f16.onnx` at the same 86.1 MB with different bytes, and the
 * first version of this file pinned the wrong one – it downloaded and verified perfectly, and
 * would have been loaded by an engine asking for the other. The hash check cannot save you from
 * correctly verifying the wrong file.
 *
 * `Kokoro-82M-v1.0-ONNX-timestamped` is what HeadTTS requests by default, and it emits
 * phoneme-level timings, which is what would let the orb follow real speech instead of a
 * synthesised envelope.
 *
 * The **voices are style vectors rather than model weights** and are shared between the two, so
 * they stay where they are – which also means the six already downloaded do not have to be
 * fetched again. Keying the cache by URL makes that automatic: only the model reads as missing.
 */
const TS_REVISION = 'dd4401a9add81ac692d20e240d22ec9dda82cc29';
const TS_REPO = 'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/resolve';

/**
 * What the engine must be told to ask for, exported so it cannot drift from what was fetched.
 *
 * `kokoro.js` configures HeadTTS with these. Two copies of a model id or a voice base – one
 * here and one there – is how the engine ends up requesting a file nobody downloaded, which is
 * a failure at first use rather than at build time.
 */
export const MODEL_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped';
export const VOICES_BASE = `${REPO}/${REVISION}/voices`;

/**
 * The model: **fp32**, the only variant that is both numerically sound on the GPU and fully
 * accelerated by it. 326 MB, chosen knowingly.
 *
 * ## Do not switch this to fp16. It was tried, and it is silent.
 *
 * The reasoning that leads there is sound, which is what makes it worth writing down. int8
 * graphs frequently have no WebGPU kernels, so part of the graph falls back to the CPU – true,
 * and why q8 measured ~1.6× real time. fp16 fixes exactly that: 5.3 seconds of speech in
 * 660 ms, **0.12× real time**, thirteen times faster.
 *
 * Every sample was zero. Peak amplitude `0` on a buffer of the correct duration, at the correct
 * rate, from a session that ran on the GPU and reported no error.
 *
 * That is not this codebase's bug. **ONNX Runtime's WebGPU backend produces NaN for Kokoro at
 * fp16**, an open upstream issue across several transformers.js versions and several GPU
 * vendors – see microsoft/onnxruntime#29807 ("fp32 corrupts a subset of inputs, fp16 corrupts
 * all; same model clean on WASM") and #26732 for the same fp16-overflow shape in another model.
 * NaN reaches the WAV encoder and lands as silence, which is why the failure presents as a
 * voice that plays for exactly the right number of milliseconds and cannot be heard.
 *
 * So there is no free corner:
 *
 * | | size | speed | correct on WebGPU |
 * |---|---|---|---|
 * | `q8` | 92 MB | ~1.6× real time | yes |
 * | `fp16` | 156 MB | ~0.12× real time | **no – all NaN** |
 * | `q4f16` | 147 MB | fast | no – same fp16 path |
 * | **`fp32`** | **326 MB** | **fast, full GPU kernels** | **yes** |
 *
 * **fp32 is not unconditionally safe either**, and the same issue says so: it corrupts a subset
 * of inputs on Intel Iris Xe, while staying clean on WASM and on Qualcomm Adreno. It is correct
 * on Apple Silicon, which is where it was measured. That is a reason to keep the guard below,
 * not a reason to pick a slower default for everyone.
 *
 * q8 remains the fallback worth remembering: 92 MB, audible everywhere, and one line away
 * (`model_quantized.onnx`, sha256 `c0c02b3299fd97c34ea92a98e6d41eaa1a739c8f77bf685aac34bd7b34c1132c`).
 *
 * `model_q8f16.onnx` is 86 MB and would have been ideal, but transformers.js 4.0.0 has no such
 * dtype – it was silently ignored and the 326 MB fp32 default requested instead.
 *
 * **The guard against all of this is `peak` in `kokoro.js`**, which refuses a buffer of zeros
 * and falls back to a system voice. That matters beyond this machine: the upstream issue says
 * fp32 corrupts *a subset of inputs* on Intel Iris Xe, so a user whose GPU we cannot test can
 * hit this with a dtype that is correct here. A voice that checks its own output is the only
 * version of this that ships.
 *
 * `DTYPE` is exported so `kokoro.js` cannot disagree with what was downloaded, and the test
 * below ties the two together: an unrecognised dtype fails at first use, not at build time.
 *
 * **The hashes are read, not guessed.** They come from HuggingFace's own API, which reports the
 * Git-LFS object id – and an LFS oid *is* the SHA-256 of the file's contents. Cross-checked:
 * the oid the API gives for `model_quantized.onnx` matches the SHA-256 published on its file
 * page, which is what establishes the two are the same thing rather than assuming it.
 *
 * Sizes are exact for the same reason, so a progress bar cannot overshoot.
 */
export const DTYPE = 'fp32';

export const MODEL = {
  id: 'model',
  url: `${TS_REPO}/${TS_REVISION}/onnx/model.onnx`,
  bytes: 325_532_171,
  sha256: '651ea8291843a92276a4a003581a215cb07d15e47dde6fcfb1b768f9a1682054',
};

/**
 * What transformers.js 4.0.0 will accept, read from the bundled build rather than the docs.
 *
 * Kept so the test can assert `DTYPE` is one of them. An unrecognised name does not throw – it
 * is ignored, and the default fp32 model is requested instead, which surfaces as a refused
 * network request for a file nobody downloaded.
 */
export const KNOWN_DTYPES = ['fp32', 'fp16', 'q8', 'int8', 'uint8', 'q4', 'bnb4', 'q4f16'];

/**
 * **All 28 English voices.** 14.6 MB, every file exactly 522,240 bytes.
 *
 * This shipped as six, and the comment justifying that said all 28 would be 28.7 MB. It is
 * 14.6 – the figure was roughly doubled and nobody checked it, because it was only ever load
 *-bearing for a decision that looked obvious. The six were 3.1 MB, so the other 22 cost
 * **11.5 MB against a 326 MB model**: 3.5% more download, for four times the choice.
 *
 * **The bytes were never the real cost of shipping a subset.** With part of the set on disk,
 * "which voices exist" and "which voices are installed" were different questions, and every
 * caller had to know which one it was asking. One did not: `assignKokoroVoices` defaulted to
 * the published 28, so a third British agent was handed `bf_isabella` – a file the local-only
 * shim would refuse, correctly, presenting as a voice that simply did not speak. Shipping the
 * whole set collapses the two lists into one, and `tts.js` now derives its own from this one
 * rather than keeping a second copy of the same ids in another file.
 *
 * **The order is load-bearing, which is why the original six are still first and still in
 * their original order.** An agent with no chosen voice is assigned by position – the first
 * free voice of the right accent – so re-sorting this array would silently give every
 * auto-assigned agent a different voice on the next roster change. Anyone who already has
 * agents keeps the voices they have; the additions only reach the seventh agent onwards, who
 * until now was getting a collision.
 *
 * **The hashes are Git-LFS object ids from HuggingFace's own API, and an LFS oid is the SHA-256
 * of the contents.** All 28 were read together rather than the 22 being appended on faith: the
 * six already here came back byte-identical, which is what establishes the oid and the digest
 * are the same thing rather than assuming it a second time.
 */
export const VOICES = Object.entries({
  // The original six, in their original order. See above before touching this.
  bm_george: 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc',
  bf_emma: '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73',
  bm_daniel: '6b3194bbceffb746733cbc22c8f593dd44e401a71d53895a2dca891bc595a1e8',
  af_heart: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
  am_michael: '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1',
  af_bella: 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b',

  // British female
  bf_alice: '08afa6ba24da61ea5e8efa139e5aadc938d83f0a6da5a900adaf763ac1da5573',
  bf_isabella: '3754352c4aaa46d17f27654ab7518d65b62ad6163a0f55a5f4330c2da2c4e94f',
  bf_lily: '5e0ee32ebe64a467124976b14e69590746f1c4ce41a12b587a50c862edfea335',

  // British male
  bm_fable: 'f889083196807b4adb15e9204252165f503b8d33d3982e681c52443c49d798f1',
  bm_lewis: 'b8f671cef828c30e66fdf0b0756a76bba58f6bb3398cbbf27058642acbcedb97',

  // American female
  af_alloy: 'c4a6b876047fd7fb472edf4ebd63cfac7c3b958a7cae7c106e8f038ca6308c45',
  af_aoede: '4a004c33430762e2461eedb2013fad808ef4ab3121f5300f554476caf58d8361',
  af_jessica: 'a240a5e3c15b43563d6e923bdca8ef5613a23471d9b77653694012435df23bd8',
  af_kore: '9be5221b6a941c04b561959b8ff0b06e809444dcc4ab7e75a7b23606f691819e',
  af_nicole: 'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a',
  af_nova: '18778272caa0d0eebaea251c35fd635f038434f9eee5e691d02a174bd328414f',
  af_river: '00a2bcf82b1d86e8f19902ede58c65ccf6c0e43b44b7d74fad54e5d8933c9c30',
  af_sarah: '4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a',
  af_sky: '4435255c9744f3f31659e0d714ab7689bf65d9e77ec1cce060f083912614f0b9',

  // American male
  am_adam: '162b035ed91cfc48b6046982184c645f72edcdd1b82843347f605d7bf7b15716',
  am_echo: '3968b92c3c4cd1c4416dbded36c13eaa388a90d5788d02a13e4d781f5f8cf3c3',
  am_eric: 'e8b5be17edd1e3636901ce7598baafe2dc8dd8ff707a0c23bf9e461add7e2832',
  am_fenrir: 'c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43',
  am_liam: '52403be32fd047c6a44517cb0bcd6b134f2a18baa73e70ef41651e0eab921ade',
  am_onyx: 'da5d135b424164916d75a68ffb4c2abce3d7d5ccc82dd1ee6cf447ce286145e6',
  am_puck: 'fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0',
  am_santa: '61150cf726ab6c5ed7a99f90a304f91f5a72c00c592e89ec94e5df11c319227a',
}).map(([id, sha256]) => ({
  id,
  url: at(`voices/${id}.bin`),
  bytes: 522_240,
  sha256,
}));

/**
 * `en-GB` or `en-US`, from the id's first letter.
 *
 * Kokoro names every voice `<accent><gender>_<name>`, so the accent is in the id and does not
 * need a table beside it. It had one anyway – a hand-written `lang` per voice in `tts.js` and
 * a `/^b/` test in `offscreen.js` – which is two copies of a rule the naming already states.
 */
export const langOf = (id) => (String(id).startsWith('b') ? 'en-GB' : 'en-US');

/**
 * The model's own paperwork, which transformers.js loads before the weights.
 *
 * Tiny – 3.6 kB between them – and completely load-bearing: `from_pretrained` reads
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
 * The hosts a download actually touches – **both of them**.
 *
 * `huggingface.co/…/resolve/…` answers with a **302 to `us.aws.cdn.hf.co`**, and that response
 * carries `access-control-allow-origin: https://huggingface.co` rather than `*`. So a fetch
 * from an extension page is refused unless we hold host permission, and holding it for
 * `huggingface.co` alone is not enough – the bytes come from the CDN.
 *
 * Measured rather than assumed, after every file failed with a message the UI was throwing
 * away. A redirect to a second origin is invisible from the URL you wrote down.
 */
export const HOSTS = { origins: ['https://huggingface.co/*', 'https://*.hf.co/*'] };

/**
 * Asks for those hosts, if we do not already have them.
 *
 * **Must be called straight from the click.** `permissions.request` needs a live user gesture,
 * and an await before it spends one – the same trap that made the orb appear on Notion and
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
 * function exists to prevent. The caller decides what to do with `unverified` – setup refuses,
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
 * against the page – `chrome-extension://…/model` – so `put` fails with *"Request scheme
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

/**
 * `missing` · `partial` · `ready`, plus **why** it is partial.
 *
 * `partial` used to have exactly one cause – a download that stopped – so setup called it
 * "interrupted" and was right. Growing the voice set gave it a second cause with the same
 * shape and a completely different meaning: an install that was complete when it was made and
 * is now missing files that did not exist then. Both resume the same way, which is precisely
 * the trap – *same handling is not the same cause*, and the person reacts differently. Told
 * "interrupted" about a healthy install, they go looking for a fault that is not there.
 *
 * `core` is what tells them apart, and it is a fact rather than a guess: the model is 96% of
 * the bytes and is fetched first, so a download that stopped early does not have it, while an
 * install that predates a new voice has everything except that voice.
 */
export async function weightsStatus() {
  const present = await Promise.all(ALL.map(async (f) => Boolean(await stored(f.id))));
  const count = present.filter(Boolean).length;

  const isVoice = new Set(VOICES.map((v) => v.id));
  const core = ALL.every((f, i) => isVoice.has(f.id) || present[i]);
  // What is still to fetch, summed from the manifest rather than from a file size repeated in
  // the UI – the figure somebody decides on before committing a connection has to be the real
  // one, and a constant copied into setup would be right until the day it was not.
  const missingBytes = ALL.reduce((n, f, i) => (present[i] ? n : n + f.bytes), 0);

  if (count === 0) return { state: 'missing', have: 0, want: ALL.length, core: false, missingBytes };
  if (count < ALL.length) return { state: 'partial', have: count, want: ALL.length, core, missingBytes };
  return { state: 'ready', have: count, want: ALL.length, core: true, missingBytes: 0 };
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
   * report a network problem – and on the already-stored path it was not caught at all, which
   * is an uncaught TypeError from a function that had just succeeded.
   *
   * Neither is a download failure, and neither should be silent, so it gets its own guard.
   */
  const notify = (id) => {
    try {
      onProgress({ id, done, total: ALL.length, bytes, totalBytes: TOTAL_BYTES });
    } catch (error) {
      console.warn('[openposse] weights progress handler threw –', error?.message ?? error);
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
