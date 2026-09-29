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

import { MODEL_REPO, VOICES_BASE, DTYPE } from './weights.js';

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
    // **`transformers.min.js`, not `transformers.web.min.js`.** The `.web.` build carries bare
    // import specifiers — `onnxruntime-web/webgpu`, `onnxruntime-common` — which a bundler is
    // expected to resolve and a browser cannot: `import()` of it dies with "Failed to resolve
    // module specifier". This is the file HeadTTS loads from a CDN by default, and it is
    // self-contained for exactly that reason.
    transformersModule: chrome.runtime.getURL('vendor/transformers/transformers.min.js'),
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
    // From `weights.js`, so the dtype and the file that was downloaded cannot disagree. They
    // did: `q8f16` names a real published file but is not a dtype transformers.js recognises,
    // so it was **ignored rather than rejected** and the 326 MB fp32 default was requested
    // instead — surfacing three layers away as a refused network request.
    dtypeWebgpu: DTYPE,
    languages: ['en-us'],
  });

  await engine.connect();
  return engine;
}

/**
 * Loads the model before anything needs it.
 *
 * Measured at ~1.7 s to reach ready — the model onto the GPU, the tokenizer, the dictionary.
 * Noticeable if it happens when an answer arrives, and invisible if it happens earlier.
 *
 * **Called when a turn starts, not at browser launch**, and that is the whole design. A turn is
 * already several seconds of somebody speaking and a vendor thinking, so the load hides
 * completely inside it. Warming at launch would put 92 MB on the GPU of every Chrome session
 * whether or not OpenPosse is used in it, to save time nobody was going to notice.
 *
 * Fire and forget: failures are the speaking path's business, and a warm-up that reported
 * problems would report them before there was anything to say.
 */
export async function warm() {
  try {
    session ??= connect();
    await session;
    return true;
  } catch {
    session = null;
    return false;
  }
}

/**
 * Says something, in one of Kokoro's voices.
 *
 * @param text     what to say
 * @param voice    a Kokoro voice id, e.g. `bm_george`
 * @param onPulse  called as each chunk starts playing, for the orb
 * @returns `{ ok }` or `{ ok: false, reason }`
 */
export async function speak(text, voice, { onLevel = () => {} } = {}) {
  if (!text) return { ok: true };

  // Measured and handed back rather than logged here: this runs in the offscreen document, so
  // a `console` line would land in a different DevTools window from the rest of the turn —
  // which is exactly why "speaking" read as one 21-second step with nothing inside it.
  const ms = {};
  const started = performance.now();

  try {
    const cold = session === null;
    session ??= connect();
    const engine = await session;
    ms.load = Math.round(performance.now() - started);
    ms.cold = cold;

    await engine.setup({ voice, language: 'en-us', audioEncoding: 'wav' });

    // Collected rather than streamed into the speakers by HeadTTS itself, because playback has
    // to be ours: `cancel` must be able to stop mid-sentence when somebody presses the shortcut
    // to interrupt, and an engine that owns its own output gives us nothing to stop.
    const synthAt = performance.now();
    const chunks = [];
    await engine.synthesize({ input: text }, (message) => {
      if (message?.data?.audio) chunks.push(message.data.audio);
    });
    ms.synth = Math.round(performance.now() - synthAt);
    ms.chunks = chunks.length;
    ms.audio = Math.round(chunks.reduce((n, b) => n + b.duration, 0) * 1000);

    if (chunks.length === 0) return { ok: false, reason: 'kokoro-no-audio', ms };

    const playAt = performance.now();
    const result = await play(chunks, onLevel);
    ms.play = Math.round(performance.now() - playAt);
    return { ...result, ms };
  } catch (error) {
    // The session is dropped rather than latched, so one bad load does not disable neural
    // voices for the rest of the browser session. The reason is passed up: a refused network
    // request from the shim and a WASM compile failure read very differently.
    session = null;
    return { ok: false, reason: `kokoro: ${error?.message ?? error}`, ms };
  }
}

/** ~20 Hz, matching the microphone meter. The orb runs at 60 and eases between readings. */
const LEVEL_MS = 50;

/**
 * Plays the synthesised buffers in order, reporting the **real output level** as it goes.
 *
 * This is what the design asks for and `speechSynthesis` cannot give: "the TTS output level
 * while an agent speaks". The system-voice path has to make do with `boundary` events — speech
 * *rate*, not loudness — because it renders straight to the device and exposes no audio node.
 * Here the audio is ours before it is heard, so an `AnalyserNode` on the way to the speakers
 * gives the orb the same signal the microphone gives it, and for the same reason: an orb that
 * moves with the voice is an instrument, and one that moves on a timer is an animation.
 *
 * Without this, Kokoro would have driven the orb *worse* than the voices it replaces — two or
 * three pulses across ten seconds, one per sentence.
 *
 * Sequential source nodes rather than one concatenation, so `cancel` can stop mid-sentence.
 */
function play(buffers, onLevel) {
  return new Promise((resolve) => {
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.connect(ctx.destination);
    const samples = new Float32Array(analyser.fftSize);

    const meter = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / samples.length);
      // Same decibel mapping as the microphone, so the orb behaves identically whether it is
      // following you or following an agent — which is the point of it being one orb.
      const db = 20 * Math.log10(Math.max(rms, 1e-6));
      onLevel(Math.min(1, Math.max(0, (db + 55) / 45)));
    }, LEVEL_MS);

    let index = 0;
    const finish = (result) => {
      clearInterval(meter);
      onLevel(0);
      playing = null;
      ctx.close().catch(() => {});
      resolve(result);
    };

    const next = () => {
      if (index >= buffers.length) return finish({ ok: true });
      const source = ctx.createBufferSource();
      source.buffer = buffers[index];
      source.connect(analyser);
      source.onended = () => { if (playing) next(); };
      playing = { ctx, source, meter };
      index += 1;
      return source.start();
    };

    next();
  });
}

/** Stops mid-sentence. The promise from `speak` resolves as cancelled, not as an error. */
export function cancel() {
  if (!playing) return;
  const { ctx, source, meter } = playing;
  playing = null;
  clearInterval(meter);          // or the orb keeps reading a context that is closing
  try { source.stop(); } catch { /* already finished */ }
  ctx.close().catch(() => {});
}
