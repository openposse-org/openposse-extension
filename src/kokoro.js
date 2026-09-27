// Speaking with Kokoro, through HeadTTS, entirely on this machine.
//
// The other half of `tts.js`'s gate. `chooseEngine` decides *whether* this runs; this is what
// runs. It is the only thing in the extension that touches the vendored engine, so the rest of
// the codebase never learns that HeadTTS exists.
//
// **Everything here is lazy.** Constructing HeadTTS loads a 24 MB WASM binary and an 86 MB
// model, which is not something to do because somebody opened a popup. It happens on the first
// answer that is actually going to be spoken by it, and the session is kept afterwards.
//
// Nothing fetches. The worker's `fetch` is replaced by `vendor/headtts/openposse-local-only.mjs`
// so the model, the tokenizer and the voices come from the cache `weights.js` verified, and a
// request for anything else throws rather than reaching the network.

import { MODEL_REPO, VOICES_BASE } from './weights.js';

/** The warm engine, or a promise for one. Null before first use and after a failure. */
let session = null;

/** What `speak` is currently playing, so it can be stopped. */
let playing = null;

/**
 * Builds and connects the engine.
 *
 * Every remote default HeadTTS ships is replaced here, and the shim then makes that
 * belt-and-braces: `transformersModule` would otherwise load from jsDelivr, which is remotely
 * hosted *code* and both a CSP violation and a documented Web Store rejection.
 *
 * `endpoints: ['webgpu']` with no `wasm` fallback is deliberate. `chooseEngine` has already
 * established WebGPU is present, and the WASM path is roughly ten times slower than real
 * time — falling back to it silently would produce something far worse than the system voices
 * this was meant to improve on.
 */
async function connect() {
  const { HeadTTS } = await import(
    /* webpackIgnore: true */ chrome.runtime.getURL('vendor/headtts/headtts.mjs')
  );

  const engine = new HeadTTS({
    endpoints: ['webgpu'],
    transformersModule: chrome.runtime.getURL('vendor/transformers/transformers.web.min.js'),
    // **`workerModule` is deliberately not set**, and setting it was the first thing that
    // broke. Given one, HeadTTS wraps it in `import "<url>"` inside a Blob and starts a worker
    // from a `blob:` URL — which MV3's CSP refuses, because `script-src 'self'` does not cover
    // `blob:` and an extension may not widen it. The failure reads "Failed to start Module Web
    // Worker" and says nothing about why.
    //
    // Left null, it falls back to `new URL("./worker-tts.mjs", import.meta.url)` — a direct
    // `chrome-extension://` URL beside this module, which *is* `'self'`. The upstream default
    // is the path that works here; being explicit chose the one that does not.
    dictionaryURL: chrome.runtime.getURL('dictionaries'),
    // Pointed at the URLs we cached, so the shim finds them by exact match rather than by
    // falling back to a path-tail comparison.
    voiceURL: VOICES_BASE,
    model: MODEL_REPO,
    // The variant that was downloaded. HeadTTS's own list does not mention q8f16, but it passes
    // the value straight to transformers.js, which names model files `model_<dtype>.onnx` —
    // and q8f16 is what `weights.js` pinned, at 86 MB against 326 MB for fp32.
    dtypeWebgpu: 'q8f16',
    languages: ['en-us'],
  });

  await engine.connect();
  return engine;
}

/** Whether the engine can be built at all, without building it. Used by the gate's copy. */
export function available() {
  return typeof MODEL_REPO === 'string';
}

/**
 * Says something, in one of Kokoro's voices.
 *
 * @param text     what to say
 * @param voice    a Kokoro voice id, e.g. `bm_george`
 * @param onPulse  called as each chunk starts playing, for the orb
 * @returns `{ ok }` or `{ ok: false, reason }`
 */
export async function speak(text, voice, { onPulse = () => {} } = {}) {
  if (!text) return { ok: true };

  try {
    session ??= connect();
    const engine = await session;

    await engine.setup({ voice, language: 'en-us', audioEncoding: 'wav' });

    // Collected rather than streamed into the speakers by HeadTTS itself, because playback has
    // to be ours: `cancel` must be able to stop mid-sentence when somebody presses the shortcut
    // to interrupt, and an engine that owns its own output gives us nothing to stop.
    const chunks = [];
    await engine.synthesize({ input: text }, (message) => {
      if (message?.data?.audio) chunks.push(message.data.audio);
    });

    if (chunks.length === 0) return { ok: false, reason: 'kokoro-no-audio' };
    return play(chunks, onPulse);
  } catch (error) {
    // The session is dropped rather than latched, so one bad load does not disable neural
    // voices for the rest of the browser session. The reason is passed up: a refused network
    // request from the shim and a WASM compile failure read very differently.
    session = null;
    return { ok: false, reason: `kokoro: ${error?.message ?? error}` };
  }
}

/**
 * Plays the synthesised buffers in order, pulsing as each starts.
 *
 * Sequential `AudioBufferSourceNode`s rather than one concatenation: HeadTTS splits on
 * sentences, so a chunk boundary is a sentence boundary, and starting each one is a natural
 * moment to move the orb. It is a coarser signal than a real amplitude envelope and a much
 * better one than `speechSynthesis` allows — that exposes no audio at all.
 */
function play(buffers, onPulse) {
  return new Promise((resolve) => {
    const ctx = new AudioContext();
    let index = 0;

    const next = () => {
      if (index >= buffers.length) {
        playing = null;
        ctx.close().catch(() => {});
        resolve({ ok: true });
        return;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffers[index];
      source.connect(ctx.destination);
      source.onended = () => { if (playing) next(); };
      playing = { ctx, source };
      index += 1;
      onPulse();
      source.start();
    };

    next();
  });
}

/** Stops mid-sentence. The promise from `speak` resolves as cancelled, not as an error. */
export function cancel() {
  if (!playing) return;
  const { ctx, source } = playing;
  playing = null;
  try { source.stop(); } catch { /* already finished */ }
  ctx.close().catch(() => {});
}
