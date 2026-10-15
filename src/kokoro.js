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
import { play, peak, SILENT_PEAK } from './player.js';

/** The warm engine, or a promise for one. Null before first use and after a failure. */
let session = null;

/** What `speak` is currently playing, so it can be stopped. */
let playing = null;

/**
 * Whether the voice is held. A flag rather than only a call on `playing`, because a pause can
 * arrive during the model load, before there is any player to hold – and the player made after
 * it has to start held, not speak the first sentence and then stop.
 */
let paused = false;

/**
 * Bumped by every `cancel`. A cancel during the model load also has no player to stop, so `speak`
 * compares this before it makes one; without that, an answer cancelled while the voice warmed up
 * starts speaking seconds after the Stop or the new turn that cancelled it.
 */
let cancels = 0;

/** So the backend report goes out once rather than on every answer. */
let reportedBackend = false;

/**
 * Builds and connects the engine.
 *
 * Every remote default HeadTTS ships is replaced here, and the shim then makes that
 * belt-and-braces: `transformersModule` would otherwise load from jsDelivr, which is remotely
 * hosted *code* and both a CSP violation and a documented Web Store rejection.
 *
 * `endpoints: ['webgpu']` with no `wasm` fallback is deliberate. `chooseEngine` has already
 * established WebGPU is present, and the WASM path is roughly ten times slower than real
 * time – falling back to it silently would produce something far worse than the system voices
 * this was meant to improve on.
 */
async function connect() {
  const { HeadTTS } = await import(
    /* webpackIgnore: true */ chrome.runtime.getURL('vendor/headtts/headtts.mjs')
  );

  const engine = new HeadTTS({
    endpoints: ['webgpu'],
    // **`transformers.min.js`, not `transformers.web.min.js`.** The `.web.` build carries bare
    // import specifiers – `onnxruntime-web/webgpu`, `onnxruntime-common` – which a bundler is
    // expected to resolve and a browser cannot: `import()` of it dies with "Failed to resolve
    // module specifier". This is the file HeadTTS loads from a CDN by default, and it is
    // self-contained for exactly that reason.
    transformersModule: chrome.runtime.getURL('vendor/transformers/transformers.min.js'),
    // **`workerModule` is deliberately not set**, and setting it was the first thing that
    // broke. Given one, HeadTTS wraps it in `import "<url>"` inside a Blob and starts a worker
    // from a `blob:` URL – which MV3's CSP refuses, because `script-src 'self'` does not cover
    // `blob:` and an extension may not widen it. The failure reads "Failed to start Module Web
    // Worker" and says nothing about why.
    //
    // Left null, it falls back to `new URL("./worker-tts.mjs", import.meta.url)` – a direct
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
    // instead – surfacing three layers away as a refused network request.
    dtypeWebgpu: DTYPE,
    languages: ['en-us'],
  });

  await engine.connect();

  // What the adapter actually is, alongside what the session actually bound. Together these
  // answer "is it running on WebGPU" with facts rather than with the setting we passed in.
  let adapter = null;
  try {
    const gpu = await globalThis.navigator?.gpu?.requestAdapter();
    const info = await gpu?.requestAdapterInfo?.();
    adapter = info
      ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' ')
      : (gpu ? 'adapter (no info exposed)' : null);
  } catch { /* diagnostics only */ }

  engine.openposseAdapter = adapter;
  return engine;
}

/**
 * Loads the model before anything needs it.
 *
 * Measured at ~1.7 s to reach ready – the model onto the GPU, the tokenizer, the dictionary.
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
 * @param onLevel  called with an amplitude as each chunk plays, for the orb
 * @param onStart  called once, as the first chunk starts playing – the first sound, which a
 *                 cold load and the first sentence's synthesis can put seconds after the call
 * @param speed    pace multiplier, 1 being this voice's own. Kokoro drives it through the
 *                 duration predictor, so the speech is stretched rather than resampled and the
 *                 pitch does not move. HeadTTS refuses anything outside 0.25–4 – `clampSpeed`
 *                 in `storage.js` is what guarantees this never arrives out of range.
 * @returns `{ ok }` or `{ ok: false, reason }`
 */
export async function speak(text, voice, { onLevel = () => {}, onStart = () => {}, speed = 1 } = {}) {
  if (!text) return { ok: true };

  // Measured and handed back rather than logged here: this runs in the offscreen document, so
  // a `console` line would land in a different DevTools window from the rest of the turn –
  // which is exactly why "speaking" read as one 21-second step with nothing inside it.
  const ms = {};
  const started = performance.now();
  const mine = cancels;
  let player = null;

  try {
    const cold = session === null;
    session ??= connect();
    const engine = await session;
    ms.load = Math.round(performance.now() - started);
    ms.cold = cold;

    // Reported once per engine, on the first thing it says. Repeating it every turn would be
    // noise; never reporting it is how 1.6× real time went undiagnosed.
    if (!reportedBackend) {
      reportedBackend = true;
      ms.backend = {
        adapter: engine.openposseAdapter,
        ...(engine.openposseBackend ?? {}),
      };
    }

    // `setup` runs per utterance rather than once per session, which is what makes the speed a
    // per-answer value rather than something fixed when the engine warmed up. Changing it in
    // Settings therefore takes effect on the next thing spoken, with nothing to restart.
    await engine.setup({
      voice, language: 'en-us', audioEncoding: 'wav', speed,
    });
    ms.speed = speed;
    if (cancels !== mine) return { ok: false, reason: 'cancelled', ms };

    // Playback is ours rather than HeadTTS's, because `cancel` must be able to stop
    // mid-sentence when somebody interrupts, and an engine that owns its own output gives us
    // nothing to stop.
    //
    // **Each chunk is spoken as it arrives, not after the last one.** Collecting them all first
    // meant the wait before the first word was the time to synthesise the *whole* answer:
    // measured at 5.1 s before a 3.3 s reply began. A sentence is playable the moment it exists,
    // and every later sentence is then synthesised against time that is already being spent
    // speaking. The engine only has to keep ahead of the speakers, not finish before them.
    const synthAt = performance.now();
    player = play(onLevel, {
      held: paused,
      onEnd: (ended) => { if (playing === ended) playing = null; },
    });
    playing = player;
    const chunks = [];
    let silent = false;

    await engine.synthesize({ input: text }, (message) => {
      const audio = message?.data?.audio;
      if (!audio) return;
      chunks.push(audio);

      // **"Nothing was heard" and "nothing was produced" are different faults**, and until this
      // existed they were the same event: buffers of the right duration played for the right
      // number of milliseconds and resolved successfully while the room stayed quiet.
      //
      // Judged on the first chunk, because that is the one that can still be acted on. A dtype
      // that computes NaN does it on every chunk, so the first is representative; waiting for
      // the last would mean the fallback voice could only start after the silence had already
      // been "spoken". `ms.peak` below still reports across all of them.
      if (chunks.length === 1 && peak([audio]) < SILENT_PEAK) { silent = true; return; }
      if (silent) return;

      if (chunks.length === 1) {
        ms.firstWord = Math.round(performance.now() - started);
        onStart();
      }
      player.push(audio);
    });

    ms.synth = Math.round(performance.now() - synthAt);
    ms.chunks = chunks.length;
    ms.audio = Math.round(chunks.reduce((n, b) => n + b.duration, 0) * 1000);
    ms.peak = peak(chunks);
    ms.rate = chunks[0]?.sampleRate ?? 0;

    if (chunks.length === 0 || silent) {
      player.stop();
      // A model producing silence is a failed answer, not a spoken one, so the caller falls
      // back to a system voice. Speech that cannot be heard is worse than a plainer voice.
      return {
        ok: false,
        reason: chunks.length === 0 ? 'kokoro-no-audio' : 'kokoro-silent-audio',
        ms,
      };
    }

    const result = await player.finish();
    ms.play = Math.round(performance.now() - synthAt);
    return { ...result, ms };
  } catch (error) {
    // The session is dropped rather than latched, so one bad load does not disable neural
    // voices for the rest of the browser session. The reason is passed up: a refused network
    // request from the shim and a WASM compile failure read very differently.
    //
    // A failure partway through an answer leaves a player behind, so it is stopped here.
    // Otherwise its level meter keeps reporting to the orb until the next answer cancels it.
    player?.stop();
    session = null;
    return { ok: false, reason: `kokoro: ${error?.message ?? error}`, ms };
  }
}

/** Stops mid-sentence. The promise from `speak` resolves as cancelled, not as an error. */
export function cancel() {
  cancels += 1;
  // Every answer starts with a cancel, so a pause never outlives what it paused: the next thing
  // spoken, a real answer included, is never born held.
  paused = false;
  if (!playing) return;
  const player = playing;
  playing = null;
  player.stop();
}

/** Holds the voice where it is. Safe during the model load: the player starts held. */
export function pause() {
  paused = true;
  playing?.pause();
}

export function resume() {
  paused = false;
  playing?.resume();
}
