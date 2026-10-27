// Speaking with Phonon 31M, entirely on this machine.
//
// The third neural engine, shaped like `supertonic.js`: `warm`, `speak`, `cancel`, `pause`,
// `resume` and `unload`, so the offscreen page treats all three alike. `chooseEngine` decides
// whether this runs; this is what runs.
//
// **The runtime is phonon-tts 0.4.2, vendored unchanged in `vendor/phonon/`** (MIT OR Apache-2.0):
// Phonon compiled to WebAssembly, in a worker of its own, on WebGPU where the browser hands out an
// adapter and on the CPU otherwise. It was chosen over the ONNX build of the same model because it
// normalises text itself – currency, emails, numbers – which the browser tokenizer does not.
//
// **Nothing fetches.** phonon-tts would download from Hugging Face if it were let, so it is never
// given a repository name: it is given a model whose every file is a `blob:` URL made here from
// the bytes `weights.js` downloaded and verified, with its own cache switched off. Its Hub lookup
// is only reached for a model named as a string, and this file never names one.
//
// **One CPU thread.** More need the page to be cross-origin isolated (COOP and COEP in the
// manifest), which would also stop extension pages loading any cross-origin image without a CORP
// header. One thread measured 0.15× real time, fast enough; the threaded build is not shipped.

import { PHONON } from './weights.js';
import { play, peak, SILENT_PEAK } from './player.js';

const vendor = (path) => chrome.runtime.getURL(`vendor/phonon/${path}`);

/** The words of an answer are normalised as English; the model speaks nothing else. */
const LANG = 'en';

/**
 * How much audio is judged before any of it plays. Phonon streams in 80 ms chunks and starts each
 * answer with up to 0.2 s of quiet, so a first chunk below the silence threshold is ordinary; half
 * a second of it is not. Costs a few tens of milliseconds of synthesis before the first word.
 */
const JUDGE_S = 0.5;

/** The warm engine, or a promise for one. Null before first use, after a failure and after `unload`. */
let session = null;

/** What `speak` is currently playing, so it can be stopped. */
let playing = null;

/** The stream being generated, so a cancel stops the model as well as the speakers. */
let speech = null;

/** Whether the voice is held; see the same flag in `supertonic.js`. */
let paused = false;

/** Bumped by every `cancel`, so an answer cancelled while the model loads never starts. */
let cancels = 0;

/** So the backend report goes out once rather than on every answer. */
let reportedBackend = false;

/**
 * The model as phonon-tts wants it described, with every file a `blob:` URL over verified bytes.
 * Returns the spec and the URLs, which are revoked once the worker has read them.
 */
async function localModel() {
  const urls = new Map();
  for (const file of PHONON.files) {
    const bytes = await PHONON.read(file.id);
    if (!bytes) throw new Error(`${file.id} is not downloaded`);
    urls.set(file.id, URL.createObjectURL(new Blob([bytes])));
  }
  const spec = {
    weights: { q8: urls.get('weights') },
    tokenizer: urls.get('tokenizer'),
    config: urls.get('config'),
    voices: Object.fromEntries(PHONON.voices.map((v) => [v.id, urls.get(v.id)])),
    defaultVoice: PHONON.voices[0].id,
  };
  return { spec, urls: [...urls.values()] };
}

async function connect() {
  const { PhononTTS } = await import(/* webpackIgnore: true */ vendor('index.js'));
  const { spec, urls } = await localModel();
  try {
    return await PhononTTS.load({
      lang: LANG,
      model: spec,
      quant: 'q8',
      // Every voice now, while the URLs exist: a voice phonon-tts fetched on first use would
      // need its URL to outlive the load.
      voices: Object.keys(spec.voices),
      cache: false,
      // The GPU when there is a hardware adapter, the CPU otherwise or if WebGPU fails to start.
      device: 'auto',
      threads: 1,
      workerUrl: vendor('worker.js'),
      wasmUrl: vendor('wasm/phonon_tts_bg.wasm'),
      simdWasmUrl: vendor('wasm/phonon_tts_simd_bg.wasm'),
    });
  } finally {
    for (const url of urls) URL.revokeObjectURL(url);
  }
}

/**
 * Frees the model. The next answer loads it again. Called after a failed answer, so a lost GPU
 * device is not latched for the session, and when Phonon stops being the voice that answers.
 */
export async function unload() {
  const loading = session;
  session = null;
  if (!loading) return;
  const tts = await loading.catch((error) => {
    console.warn('[openposse] Phonon had not loaded, so there is nothing to free –', error?.message ?? error);
    return null;
  });
  tts?.dispose();
}

/** Loads the model before anything needs it, as the other engines do when a turn starts. */
export async function warm() {
  const loading = (session ??= connect());
  try {
    await loading;
    return true;
  } catch (error) {
    if (session === loading) session = null;
    console.warn('[openposse] Phonon could not warm up –', error?.message ?? error);
    return false;
  }
}

function toBuffer(pcm, sampleRate) {
  const buffer = new AudioBuffer({ length: pcm.length, numberOfChannels: 1, sampleRate });
  buffer.copyToChannel(pcm, 0);
  return buffer;
}

/**
 * Says something, in one of Phonon's voices.
 *
 * @param text     what to say
 * @param voice    a Phonon voice id from `PHONON_VOICES`
 * @param onLevel  called with an amplitude as the audio plays, for the orb
 * @param onStart  called once, as the first audio starts playing
 * @returns `{ ok, ms }` or `{ ok: false, reason, ms }`, with `ms` shaped like the other engines'
 */
export async function speak(text, voice, { onLevel = () => {}, onStart = () => {} } = {}) {
  if (!text) return { ok: true };

  const ms = {};
  const started = performance.now();
  const mine = cancels;
  let player = null;

  if (!PHONON.voices.some((v) => v.id === voice)) {
    return { ok: false, reason: `phonon: there is no voice named ${voice}`, ms };
  }

  try {
    const cold = session === null;
    session ??= connect();
    const tts = await session;
    ms.load = Math.round(performance.now() - started);
    ms.cold = cold;

    if (!reportedBackend) {
      reportedBackend = true;
      ms.backend = { device: tts.device, deviceReason: tts.deviceReason, threads: tts.threads };
    }
    if (cancels !== mine) return { ok: false, reason: 'cancelled', ms };

    const synthAt = performance.now();
    player = play(onLevel, {
      held: paused,
      onEnd: (ended) => { if (playing === ended) playing = null; },
    });
    playing = player;

    // **Spoken as it is generated**: each chunk goes to the player as it arrives, once the first
    // half second has been judged. Until then the chunks wait here, because "nothing was heard"
    // and "nothing was produced" are different faults: NaN reaches the samples as silence of
    // exactly the right length, and that has to be caught before it plays rather than after.
    const stream = tts.stream(text, { voice });
    speech = stream;
    const chunks = [];
    const waiting = [];
    let judged = false;
    let silent = false;
    let audio = 0;

    for await (const pcm of stream) {
      if (cancels !== mine) break;
      if (pcm.length === 0) continue;
      const buffer = toBuffer(pcm, tts.sampleRate);
      chunks.push(buffer);
      audio += buffer.duration;
      if (judged) {
        player.push(buffer);
        continue;
      }
      waiting.push(buffer);
      if (audio < JUDGE_S) continue;
      if (peak(waiting) < SILENT_PEAK) { silent = true; stream.cancel(); break; }
      judged = true;
      ms.firstWord = Math.round(performance.now() - started);
      onStart();
      for (const b of waiting.splice(0)) player.push(b);
    }

    // An answer shorter than the judging window ends before it was judged.
    if (!judged && !silent && cancels === mine && waiting.length > 0) {
      if (peak(waiting) < SILENT_PEAK) silent = true;
      else {
        ms.firstWord = Math.round(performance.now() - started);
        onStart();
        for (const b of waiting.splice(0)) player.push(b);
      }
    }
    if (speech === stream) speech = null;

    ms.synth = Math.round(performance.now() - synthAt);
    ms.chunks = chunks.length;
    ms.audio = Math.round(audio * 1000);
    ms.peak = peak(chunks);
    ms.rate = tts.sampleRate;

    if (cancels === mine && (chunks.length === 0 || silent)) {
      player.stop();
      return { ok: false, reason: chunks.length === 0 ? 'phonon-no-audio' : 'phonon-silent-audio', ms };
    }

    const result = await player.finish();
    ms.play = Math.round(performance.now() - synthAt);
    return { ...result, ms };
  } catch (error) {
    // As Supertonic's: stop the meter, and free the model rather than keep a broken one.
    player?.stop();
    speech = null;
    await unload();
    return { ok: false, reason: `phonon: ${error?.message ?? error}`, ms };
  }
}

/** Stops mid-sentence. The promise from `speak` resolves as cancelled, not as an error. */
export function cancel() {
  cancels += 1;
  paused = false;
  speech?.cancel();
  speech = null;
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
