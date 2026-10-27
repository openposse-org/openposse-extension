// The voice models' weights – Phonon's, Supertonic's and Kokoro's: what they are, where they come
// from, and how we know they are what we asked for.
//
// **This file is the whole of the amended rule made real.** The local-only rule, as amended on
// 2026-09-26, permits a model to be downloaded from setup, when the user asks, from a pinned
// URL, verified against a hash baked into the build. Every one of those clauses is a line of code here, and the verification is
// the one that turns a promise into a property: a model is code in every sense that counts, and
// one that arrives unverified is arbitrary code from a third party.
//
// Nothing here is called during a turn. Speaking reads from local storage or falls back to the
// system voices; it never fetches.
//
// Each model is a **set**: a list of pinned, hashed files and a cache of its own, made by
// `weightSet` below. The sets share every line that verifies, stores and reports, so the rule
// is enforced once rather than per model. Kokoro's set keeps the names it has always had
// (`weightsStatus`, `downloadWeights` and the rest); the others are `SUPERTONIC` and `PHONON`.

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

// ── Supertonic ────────────────────────────────────────────────────────────────────────────

/**
 * Supertonic 3's weights, pinned to a revision of `supertone-oss-archive/supertonic-3`.
 *
 * **The repository is archived**, so this revision is the last there will be. That makes the
 * pin a formality rather than a precaution, and it is kept anyway: a URL that names a commit
 * says what it fetches, and a hash mismatch then can only mean that something is wrong.
 *
 * **The weights are BigScience Open RAIL-M, not Apache-2.0**, and that is why Kokoro stays. The
 * licence allows commercial use and asks that its use restrictions bind everyone who uses the
 * model, so setup shows them and asks for agreement before this set may be downloaded. Kokoro
 * has no such restrictions, which some organisations will need. The code that runs the model,
 * `src/supertonic/helper.js`, is MIT.
 *
 * **No phonemizer, so no eSpeak.** Supertonic reads characters: `unicode_indexer.json` maps each
 * NFKD-normalised code point to an id. The GPL route that ruled out `kokoro-js` does not exist here.
 *
 * Four ONNX graphs, two JSON files the code needs before it can build them, and the voices. The
 * hashes are the Git-LFS object ids from Hugging Face's API (the SHA-256 of the contents, as for
 * Kokoro's), and the two JSON files were digested after download; the sizes are exact. Measured
 * on 2026-10-15 at real-time factor 0.03–0.04 on WebGPU, and 0.73 at best on WebAssembly, which
 * is why this set is only offered where WebGPU is.
 */
export const SUPERTONIC_LICENCE = {
  name: 'BigScience Open RAIL-M',
  // The licence's own date, which is how it is versioned. A stored agreement names this, so an
  // agreement to some other version is not taken as agreement to this one.
  version: '2022-08-18',
};

const SUPERTONIC_REVISION = 'aafc6e32416a594460b32413efc49d7fe4ce6d46';
const SUPERTONIC_REPO = 'https://huggingface.co/supertone-oss-archive/supertonic-3/resolve';

const supertonicFile = (id, path, bytes, sha256) => ({
  id,
  url: `${SUPERTONIC_REPO}/${SUPERTONIC_REVISION}/${path}`,
  bytes,
  sha256,
});

const SUPERTONIC_CORE = [
  supertonicFile('vector_estimator', 'onnx/vector_estimator.onnx', 256_534_781,
    '883ac868ea0275ef0e991524dc64f16b3c0376efd7c320af6b53f5b780d7c61c'),
  supertonicFile('vocoder', 'onnx/vocoder.onnx', 101_424_195,
    '085de76dd8e8d5836d6ca66826601f615939218f90e519f70ee8a36ed2a4c4ba'),
  supertonicFile('text_encoder', 'onnx/text_encoder.onnx', 36_416_150,
    'c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff'),
  supertonicFile('duration_predictor', 'onnx/duration_predictor.onnx', 3_700_147,
    'c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db'),
  supertonicFile('tts.json', 'onnx/tts.json', 8_253,
    '42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09'),
  supertonicFile('unicode_indexer.json', 'onnx/unicode_indexer.json', 277_676,
    '9bf7346e43883a81f8645c81224f786d43c5b57f3641f6e7671a7d6c493cb24f'),
];

/**
 * **All ten voices**, F1–F5 and M1–M5, about 0.3 MB each. Every voice speaks every one of the
 * 31 languages, so there is no per-language set to choose from.
 *
 * The whole set ships for the reason Kokoro's does: with part of it on disk, "which voices exist"
 * and "which are installed" become different questions and a caller eventually asks the wrong
 * one. **The order is load-bearing once agents are assigned voices by position**, so it does not
 * change after it ships; new voices, if any ever came, would go after these.
 */
const SUPERTONIC_VOICES = Object.entries({
  F1: [292_046, 'bbdec6ee00231c2c742ad05483df5334cab3b52fda3ba38e6a07059c4563dbc2'],
  F2: [292_423, '7c722c6a72707b1a77f035d67f0d1351ba187738e06f7683e8c72b1df3477fc6'],
  F3: [290_794, '12f6ef2573baa2defa1128069cb59f203e3ab67c92af77b42df8a0e3a2f7c6ab'],
  F4: [291_808, 'c2fa764c1225a76dfc3e2c73e8aa4f70d9ee48793860eb34c295fff01c2e032b'],
  F5: [291_479, '45966e73316415626cf41a7d1c6f3b4c70dbc1ba2bee5c1978ef0ce33244fc8d'],
  M1: [291_748, 'e35604687f5d23694b8e91593a93eec0e4eca6c0b02bb8ed69139ab2ea6b0a5b'],
  M2: [292_055, 'b76cbf62bac707c710cf0ae5aba5e31eea1a6339a9734bfae33ab98499534a50'],
  M3: [290_198, 'ea1ac35ccb91b0d7ecad533a2fbd0eec10c91513d8951e3b25fbba99954e159b'],
  M4: [291_522, 'ca8eefad4fcd989c9379032ff3e50738adc547eeb5e221b82593a6d7b3bac303'],
  M5: [291_469, 'dd22b92740314321f8ae11c5e87f8dd60d060f15dd3a632b5adf77f471f77af2'],
}).map(([id, [bytes, sha256]]) => supertonicFile(id, `voice_styles/${id}.json`, bytes, sha256));

// ── Phonon ────────────────────────────────────────────────────────────────────────────────

/**
 * Phonon 31M English's weights, pinned to a revision of `gradium/phonon-31m-en`: the revision
 * phonon-tts 0.4.2 names as its own `DEFAULT_MODEL`, which the spike of 2026-10-27 measured.
 *
 * **Apache-2.0, weights, tokenizer and voices alike**, so there is nothing to agree to. Only this
 * model: Phonon 40M and 40M multilingual are CC BY-NC 4.0 and must never be pinned here.
 *
 * **No phonemizer, so no eSpeak.** The tokenizer is SentencePiece, and the text normalisation
 * (numbers, currency, emails) is Rust compiled into phonon-tts's WebAssembly, whose crates are
 * MIT, ISC, zlib and Unicode-3.0 (`vendor/phonon/THIRD_PARTY_LICENSES.md`).
 *
 * **q8 only, 64.5 MB.** It is the only weights WebGPU accepts (f32 is refused by the package:
 * "f32 weights cannot be quantized on the GPU"), and on the CPU it was faster than f32 as well.
 * Measured on an M3 Pro: 0.04–0.05× real time on WebGPU, 0.15× on one CPU thread.
 *
 * The hashes are the Git-LFS object ids from Hugging Face's API, as for the other two sets, and
 * the two JSON files were digested after download; the sizes are exact.
 */
const PHONON_REVISION = '8c64b55ec301728e2d1695bfea87a08a267d0c2d';
const PHONON_REPO = 'https://huggingface.co/gradium/phonon-31m-en/resolve';

/**
 * The voice catalog, `gradium/phonon-voices`, pinned the same way. 102 voices; the four here are
 * the ones the spike tried, two American and two British, a woman and a man of each.
 */
const PHONON_VOICES_REVISION = '0ee17205f254b5abc43b266c8a0f215565c352f7';
const PHONON_VOICES_REPO = 'https://huggingface.co/gradium/phonon-voices/resolve';

const PHONON_CORE = [
  { id: 'weights', url: `${PHONON_REPO}/${PHONON_REVISION}/model.q8.gguf`, bytes: 64_512_352,
    sha256: 'a7d9aad2cd6dc66473f24a08bc6d2939030ef4d751ef82349361fbef3272dbae' },
  { id: 'tokenizer', url: `${PHONON_REPO}/${PHONON_REVISION}/tokenizer.json`, bytes: 277_967,
    sha256: '691a00068fa7b989f2f3e5ae5daa2d1a5bb319f2d5360deafcfb19a8bb6e7936' },
  { id: 'config', url: `${PHONON_REPO}/${PHONON_REVISION}/config.json`, bytes: 2_851,
    sha256: '7062ea376e6b158543c8abec8e5af67df171c49ad70eb7e2a0fb25c16f265e06' },
];

/**
 * **The voices, in assignment order**, which is load-bearing as it is for the other two sets: an
 * agent with no chosen voice gets the first free one of its accent and gender, so this order does
 * not change once it ships. New voices go after these.
 *
 * `lang` and `gender` are stated rather than read from an id, because Phonon's voices are names:
 * the catalog's `voices.jsonl` gives each one's language, and the gender is the spike's note.
 * `name` is what Settings shows.
 */
export const PHONON_VOICES = [
  { id: 'phonon-harper', name: 'Harper', lang: 'en-US', gender: 'female', path: 'voices/4SZHfMpw-p46Ywgs.safetensors', sha256: null },
  { id: 'phonon-miles', name: 'Miles', lang: 'en-US', gender: 'male', path: 'voices/d9XCyhjo4JhkHF1d.safetensors', sha256: null },
  { id: 'phonon-maeve', name: 'Maeve', lang: 'en-GB', gender: 'female', path: 'voices/6PWnV0Nq4wu7RVBT.safetensors', sha256: null },
  { id: 'phonon-edwin', name: 'Edwin', lang: 'en-GB', gender: 'male', path: 'voices/zUCxzrOrugTSis03.safetensors', sha256: null },
].map(({ path, sha256, ...voice }) => ({
  ...voice,
  url: `${PHONON_VOICES_REPO}/${PHONON_VOICES_REVISION}/${path}`,
  bytes: 256_136,
  sha256,
}));

/**
 * The hosts a download actually touches – **both of them**, and the same two for every set.
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
  } catch (error) {
    console.warn('[openposse] could not ask for access to the weights hosts –', error?.message ?? error);
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
// rather than a migration. One cache per set, so removing one model leaves the other alone.
//
// Each function below takes the set it works on first. `weightSet` binds them, and Kokoro's
// long-standing exports at the end of the file are those bindings for Kokoro's set.

/**
 * Cached entries are keyed by their **source URL**, not by our short id.
 *
 * Cache Storage rejects any request scheme that is not http(s), and a bare `'model'` resolves
 * against the page – `chrome-extension://…/model` – so `put` fails with *"Request scheme
 * 'chrome-extension' is unsupported"*. The real URL is both a legal key and a better one: it
 * carries the pinned revision, so bumping `REVISION` invalidates the old entry by itself rather
 * than needing a migration.
 */
const keyFor = (set, id) => set.files.find((f) => f.id === id)?.url ?? null;

async function storedIn(set, id) {
  const key = keyFor(set, id);
  if (!key) return null;
  try {
    const cache = await caches.open(set.cache);
    return (await cache.match(key)) ?? null;
  } catch (error) {
    console.warn(`[openposse] could not read ${id} from ${set.cache} –`, error?.message ?? error);
    return null;
  }
}

async function readFrom(set, id) {
  const hit = await storedIn(set, id);
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
 * install that predates a new voice has everything except that voice. The same holds for
 * Supertonic, whose four graphs are 99% of its set and come before its voices.
 */
async function statusOf(set) {
  const { files } = set;
  const present = await Promise.all(files.map(async (f) => Boolean(await storedIn(set, f.id))));
  const count = present.filter(Boolean).length;

  const isVoice = new Set(set.voices.map((v) => v.id));
  const core = files.every((f, i) => isVoice.has(f.id) || present[i]);
  // What is still to fetch, summed from the manifest rather than from a file size repeated in
  // the UI – the figure somebody decides on before committing a connection has to be the real
  // one, and a constant copied into setup would be right until the day it was not.
  const missingBytes = files.reduce((n, f, i) => (present[i] ? n : n + f.bytes), 0);

  if (count === 0) return { state: 'missing', have: 0, want: files.length, core: false, missingBytes };
  if (count < files.length) return { state: 'partial', have: count, want: files.length, core, missingBytes };
  return { state: 'ready', have: count, want: files.length, core: true, missingBytes: 0 };
}

async function removeFrom(set) {
  try {
    await caches.delete(set.cache);
    return true;
  } catch (error) {
    console.warn(`[openposse] could not delete ${set.cache} –`, error?.message ?? error);
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
async function downloadInto(set, { onProgress = () => {}, fetchImpl = fetch } = {}) {
  const { files, totalBytes } = set;
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
  // `arriving` is the part of the current file received so far, so progress moves during a file
  // as well as between them.
  const notify = (id, arriving = 0) => {
    try {
      onProgress({ id, done, total: files.length, bytes: bytes + arriving, totalBytes });
    } catch (error) {
      console.warn('[openposse] weights progress handler threw –', error?.message ?? error);
    }
  };

  for (const file of files) {
    if (await storedIn(set, file.id)) {
      done += 1;
      bytes += file.bytes;
      notify(file.id);
      continue;
    }

    try {
      const response = await fetchImpl(file.url);
      if (!response?.ok) throw new Error(`HTTP ${response?.status ?? '?'}`);
      const buffer = await readBody(response, (received) => notify(file.id, received));

      const check = await verify(file, buffer);
      if (check !== 'ok') {
        // **Not stored, on either failure.** A mismatch is the case this exists for; an
        // unmeasured hash is our own omission, and installing anyway would quietly convert
        // "verified" into "downloaded", which is the whole thing the rule forbids.
        failed.push({ id: file.id, reason: check });
        continue;
      }

      const cache = await caches.open(set.cache);
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

/**
 * Reads a response body as it arrives, reporting how much has come in.
 *
 * **`arrayBuffer()` says nothing until the last byte**, and the model is 326 MB of the 340 – so
 * the status line read "starting…" for minutes, which is indistinguishable from a stall.
 *
 * One buffer, sized from `Content-Length` when the server sends it, so the model is held once
 * rather than as chunks plus a joined copy. It grows by doubling when the length is missing or
 * wrong, which keeps it correct either way; the hash check afterwards is what says whether the
 * bytes are right. A response with no readable body falls back to `arrayBuffer()`.
 */
async function readBody(response, onBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) return response.arrayBuffer();

  const announced = Number(response.headers?.get?.('content-length'));
  let out = new Uint8Array(Number.isFinite(announced) && announced > 0 ? announced : 0);
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.byteLength > out.byteLength) {
      const grown = new Uint8Array(Math.max(out.byteLength * 2, received + value.byteLength));
      grown.set(out.subarray(0, received));
      out = grown;
    }
    out.set(value, received);
    received += value.byteLength;
    onBytes(received);
  }
  return received === out.byteLength ? out.buffer : out.slice(0, received).buffer;
}

// ── The sets ──────────────────────────────────────────────────────────────────────────────

/**
 * One model's files and its cache, with everything that reads or fills that cache bound to it.
 *
 * The file objects are held, not copied, so a test that swaps a hash in `ALL` swaps it here too.
 *
 * @param files   every file, each `{ id, url, bytes, sha256 }`; ids are unique within a set
 * @param cache   the Cache Storage name, versioned
 * @param voices  the files that are voices, which `status` counts apart from the rest
 */
export function weightSet({ files, cache, voices = [] }) {
  const set = {
    files,
    cache,
    voices,
    totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
  };
  return Object.freeze({
    ...set,
    stored: (id) => storedIn(set, id),
    read: (id) => readFrom(set, id),
    status: () => statusOf(set),
    remove: () => removeFrom(set),
    download: (options) => downloadInto(set, options),
  });
}

export const KOKORO = weightSet({ files: ALL, cache: 'openposse-kokoro-v1', voices: VOICES });

/**
 * Supertonic's set: about 401 MB, in a cache of its own.
 *
 * The graphs come first, largest first, so a download that stops early is missing the expensive
 * part and `status` reports it as interrupted rather than as an install short of a voice.
 */
export const SUPERTONIC = weightSet({
  files: [...SUPERTONIC_CORE, ...SUPERTONIC_VOICES],
  cache: 'openposse-supertonic-v1',
  voices: SUPERTONIC_VOICES,
});

/**
 * Phonon's set: about 66 MB, in a cache of its own. The weights come first, so a download that
 * stopped early reads as interrupted rather than as an install short of a voice.
 */
export const PHONON = weightSet({
  files: [...PHONON_CORE, ...PHONON_VOICES],
  cache: 'openposse-phonon-v1',
  voices: PHONON_VOICES,
});

// Kokoro's names from before there were two sets. Setup, the offscreen page and the tests use
// them, and nothing about Kokoro changed, so neither do they.
export const stored = KOKORO.stored;
export const readWeight = KOKORO.read;
export const weightsStatus = KOKORO.status;
export const removeWeights = KOKORO.remove;
export const downloadWeights = KOKORO.download;
