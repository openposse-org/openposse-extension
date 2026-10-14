// Speaking with Supertonic 3, entirely on this machine.
//
// The second neural engine, beside `kokoro.js` and shaped like it: `warm`, `speak`, `cancel`,
// `pause` and `resume`, so the offscreen page can treat the two alike. `chooseEngine` decides
// whether this runs; this is what runs.
//
// **Nothing fetches.** The four graphs, the two JSON files and the voices are read from the cache
// `weights.js` filled and verified, and the sessions are built from those bytes. The only other
// files it loads are ONNX Runtime's, from inside the extension. A file that is not in the cache is
// a failed answer with a reason, never a request.
//
// **Unlike Kokoro there is no worker.** ONNX Runtime runs here, in the offscreen document, on
// WebGPU. The GPU does the arithmetic; what stays on this thread is the helper's array reshaping,
// a few milliseconds a sentence at the real-time factor of 0.03–0.04 measured on 2026-10-15.
//
// **WebGPU or nothing**, as for Kokoro. The best WebAssembly run measured 0.73× real time, so a
// seven-second answer would take five seconds to arrive, which is worse than the system voices
// this exists to improve on. `chooseEngine` only routes here when WebGPU is present.

import * as ort from 'onnxruntime-web/webgpu';
import {
  Style, TextToSpeech, UnicodeProcessor, chunkText, isValidLang,
} from './supertonic/helper.js';
import { SUPERTONIC } from './weights.js';
import { play, peak, SILENT_PEAK } from './player.js';
import { supertonicSpeed } from './tts.js';

// ONNX Runtime's own files are the ones transformers.js already ships, byte for byte, so they are
// loaded from there. One thread: an extension page is not cross-origin isolated, so there is no
// SharedArrayBuffer to share between threads.
ort.env.wasm.wasmPaths = chrome.runtime.getURL('vendor/transformers/');
ort.env.wasm.numThreads = 1;

/** In the order `TextToSpeech` takes them. */
const GRAPHS = ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder'];

/**
 * The longest chunk upstream speaks at once: 120 characters for Korean and Japanese, 300 for the
 * rest, as upstream's own `call` chooses.
 */
const chunkLimit = (lang) => (lang === 'ko' || lang === 'ja' ? 120 : 300);

/** Denoising steps. Upstream's default, and what the spike measured at 0.03–0.04× real time. */
const STEPS = 8;

/** Silence between chunks, in seconds: upstream's own gap when it joins chunks itself. */
const GAP_S = 0.3;

/** The warm engine, or a promise for one. Null before first use, after a failure and after `unload`. */
let session = null;

/** Voice styles already read, by voice id. Small, and reused on every answer in that voice. */
const styles = new Map();

/** What `speak` is currently playing, so it can be stopped. */
let playing = null;

/**
 * Whether the voice is held. A flag as well as a call on `playing`, because a pause can arrive
 * while the graphs load, before there is a player to hold, and the player made after it has to
 * start held.
 */
let paused = false;

/**
 * Bumped by every `cancel`. A cancel during the load has no player to stop, so `speak` compares
 * this before it makes one and after every chunk; without that, an answer cancelled while the
 * voice warmed up would start speaking after the Stop or the new turn that cancelled it.
 */
let cancels = 0;

/** So the backend report goes out once rather than on every answer. */
let reportedBackend = false;

/**
 * The last inference queued. A session runs one call at a time, and a cancelled answer can still
 * be finishing its chunk when the next answer starts, so every call waits for the one before.
 */
let inference = Promise.resolve();

function exclusive(run) {
  const result = inference.then(run);
  // This chain only keeps the order. The error, if any, reaches the caller through `result`.
  inference = result.then(() => {}, () => {});
  return result;
}

async function json(id) {
  const response = await SUPERTONIC.stored(id);
  if (!response) throw new Error(`${id} is not downloaded`);
  return response.json();
}

/** Which GPU this is, for the one-off backend report. Diagnostics only. */
async function adapterName() {
  try {
    const adapter = await globalThis.navigator?.gpu?.requestAdapter();
    const info = adapter?.info;
    if (info) return [info.vendor, info.architecture, info.description].filter(Boolean).join(' ');
    return adapter ? 'adapter (no info exposed)' : null;
  } catch (error) {
    console.warn('[openposse] could not name the GPU adapter –', error?.message ?? error);
    return null;
  }
}

async function release(sessions) {
  await Promise.all(sessions.map((s) => s.release().catch((error) => {
    console.warn('[openposse] a Supertonic graph could not be released –', error?.message ?? error);
  })));
}

/**
 * Builds the four sessions from the cached graphs, one at a time so only one graph's bytes are
 * held at once. On failure, whatever did load is released rather than left on the GPU.
 */
async function connect() {
  const sessions = [];
  try {
    for (const id of GRAPHS) {
      const bytes = await SUPERTONIC.read(id);
      if (!bytes) throw new Error(`${id} is not downloaded`);
      try {
        sessions.push(await ort.InferenceSession.create(new Uint8Array(bytes), {
          executionProviders: ['webgpu'],
        }));
      } catch (error) {
        throw new Error(`${id} would not load on WebGPU: ${error?.message ?? error}`);
      }
    }
    const [cfgs, indexer] = await Promise.all([json('tts.json'), json('unicode_indexer.json')]);
    const tts = new TextToSpeech(cfgs, new UnicodeProcessor(indexer), ...sessions);
    tts.openposseAdapter = await adapterName();
    return tts;
  } catch (error) {
    await release(sessions);
    throw error;
  }
}

/**
 * Frees the graphs. The next answer loads them again.
 *
 * Called after a failed answer, so a lost GPU device or a bad load is not latched for the rest of
 * the session, and available for when Supertonic stops being the voice that answers.
 */
export async function unload() {
  const loading = session;
  session = null;
  styles.clear();
  if (!loading) return;
  const tts = await loading.catch((error) => {
    console.warn('[openposse] Supertonic had not loaded, so there is nothing to free –', error?.message ?? error);
    return null;
  });
  if (tts) await release([tts.dpOrt, tts.textEncOrt, tts.vectorEstOrt, tts.vocoderOrt]);
}

/**
 * Loads the graphs before anything needs them. Called when a turn starts, as Kokoro's is, so the
 * load hides inside the time somebody spends speaking and the assistant spends thinking.
 */
export async function warm() {
  const loading = (session ??= connect());
  try {
    await loading;
    return true;
  } catch (error) {
    if (session === loading) session = null;
    console.warn('[openposse] Supertonic could not warm up –', error?.message ?? error);
    return false;
  }
}

async function styleFor(voice) {
  if (!styles.has(voice)) {
    const data = await json(voice);
    const tensor = (part) => new ort.Tensor(
      'float32', Float32Array.from(data[part].data.flat(Infinity)), data[part].dims,
    );
    styles.set(voice, new Style(tensor('style_ttl'), tensor('style_dp')));
  }
  return styles.get(voice);
}

/** One chunk as an `AudioBuffer`, with silence in front of every chunk after the first. */
function toBuffer(wav, sampleRate, leadingSilence) {
  const offset = Math.floor(leadingSilence * sampleRate);
  const buffer = new AudioBuffer({ length: offset + wav.length, numberOfChannels: 1, sampleRate });
  buffer.copyToChannel(Float32Array.from(wav), 0, offset);
  return buffer;
}

/**
 * Says something, in one of Supertonic's voices.
 *
 * @param text     what to say
 * @param voice    a Supertonic voice id, `F1`–`F5` or `M1`–`M5`
 * @param onLevel  called with an amplitude as the audio plays, for the orb
 * @param onStart  called once, as the first chunk starts playing
 * @param speed    the Settings pace, converted by `supertonicSpeed` so Supertonic keeps the pace
 *                 that was set by ear against Kokoro's
 * @param lang     the language to read the text in, a code from `SUPERTONIC_LANGUAGES`. Chosen
 *                 in Settings; the extension still listens only in English.
 * @returns `{ ok, ms }` or `{ ok: false, reason, ms }`, with `ms` shaped like Kokoro's
 */
export async function speak(text, voice, {
  onLevel = () => {}, onStart = () => {}, speed = 1, lang = 'en',
} = {}) {
  if (!text) return { ok: true };

  // Measured and handed back rather than logged here, as Kokoro's are: a `console` line in the
  // offscreen document lands in a different DevTools window from the rest of the turn.
  const ms = {};
  const started = performance.now();
  const mine = cancels;
  let player = null;

  if (!SUPERTONIC.voices.some((v) => v.id === voice)) {
    return { ok: false, reason: `supertonic: there is no voice named ${voice}`, ms };
  }
  if (!isValidLang(lang) || lang === 'na') {
    return { ok: false, reason: `supertonic: it does not speak a language called ${lang}`, ms };
  }

  try {
    const cold = session === null;
    session ??= connect();
    const tts = await session;
    ms.load = Math.round(performance.now() - started);
    ms.cold = cold;

    if (!reportedBackend) {
      reportedBackend = true;
      ms.backend = { adapter: tts.openposseAdapter, executionProvider: 'webgpu' };
    }

    const style = await styleFor(voice);
    ms.speed = speed;
    if (cancels !== mine) return { ok: false, reason: 'cancelled', ms };

    // **Each chunk is spoken as soon as it exists**, as Kokoro's are: the wait before the first
    // word is then one chunk's synthesis, not the whole answer's, and every later chunk is made
    // while the earlier ones are being heard.
    const synthAt = performance.now();
    player = play(onLevel, {
      held: paused,
      onEnd: (ended) => { if (playing === ended) playing = null; },
    });
    playing = player;
    const chunks = [];
    let silent = false;

    ms.lang = lang;
    for (const chunk of chunkText(text, chunkLimit(lang))) {
      const { wav } = await exclusive(() => tts.call(chunk, lang, style, STEPS, supertonicSpeed(speed), 0));
      // A cancel has already stopped the player; what is left is to stop making audio.
      if (cancels !== mine) break;
      if (wav.length === 0) continue;

      const buffer = toBuffer(wav, tts.sampleRate, chunks.length === 0 ? 0 : GAP_S);
      chunks.push(buffer);

      // **"Nothing was heard" and "nothing was produced" are different faults**, as with Kokoro:
      // NaN reaches the samples as silence of exactly the right length. Judged on the first
      // chunk, because that is the one that can still be acted on, and synthesis stops there
      // rather than making more of it.
      if (chunks.length === 1 && peak([buffer]) < SILENT_PEAK) { silent = true; break; }

      if (chunks.length === 1) {
        ms.firstWord = Math.round(performance.now() - started);
        onStart();
      }
      player.push(buffer);
    }

    ms.synth = Math.round(performance.now() - synthAt);
    ms.chunks = chunks.length;
    ms.audio = Math.round(chunks.reduce((n, b) => n + b.duration, 0) * 1000);
    ms.peak = peak(chunks);
    ms.rate = tts.sampleRate;

    if (cancels === mine && (chunks.length === 0 || silent)) {
      player.stop();
      // A model producing silence is a failed answer, not a spoken one, so the caller falls
      // back to a system voice.
      return {
        ok: false,
        reason: chunks.length === 0 ? 'supertonic-no-audio' : 'supertonic-silent-audio',
        ms,
      };
    }

    const result = await player.finish();
    ms.play = Math.round(performance.now() - synthAt);
    return { ...result, ms };
  } catch (error) {
    // The player is stopped, or its meter would go on ticking, and the graphs are freed rather
    // than kept: a lost GPU device fails every later answer the same way, and reloading is
    // ~1.5 s against a fallback voice for the rest of the session.
    player?.stop();
    await unload();
    return { ok: false, reason: `supertonic: ${error?.message ?? error}`, ms };
  }
}

/** Stops mid-sentence. The promise from `speak` resolves as cancelled, not as an error. */
export function cancel() {
  cancels += 1;
  // Every answer starts with a cancel, so a pause never outlives what it paused.
  paused = false;
  if (!playing) return;
  const player = playing;
  playing = null;
  player.stop();
}

/** Holds the voice where it is. Safe during the load: the player starts held. */
export function pause() {
  paused = true;
  playing?.pause();
}

export function resume() {
  paused = false;
  playing?.resume();
}
