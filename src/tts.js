// Which engine speaks, and in whose voice.
//
// Two engines, chosen at runtime rather than at build time:
//
// - **System** (`speechSynthesis`) — always present, free, and on macOS it is Apple's own 41
//   local voices, which is the same set the Mac app used. Elsewhere it is whatever the OS
//   ships, which on Windows is SAPI and on Linux is a lottery.
// - **Kokoro** (E6) — 82M parameters of neural TTS, Apache-2.0, run locally through ONNX. It
//   is the answer to "the voices are ugly, too robotic", and it needs WebGPU to be fast enough
//   to hold a conversation with.
//
// **The selection is the interesting part and it is pure, so it is tested.** Getting it wrong
// is not a crash: it is a product that sounds worse than it should on a capable machine, or
// one that stutters unusably on a machine that cannot keep up — and both of those are
// invisible on whatever laptop the developer happened to use.

/**
 * Kokoro's English voices, Apache-2.0 with the weights.
 *
 * Named `<accent><gender>_<name>`: `af_` American female, `am_` American male, `bf_`/`bm_`
 * British. Kept here rather than fetched so the roster can be assigned voices, and the engine
 * described in setup, on a machine that has never downloaded a model.
 */
export const KOKORO_VOICES = [
  { id: 'af_heart', lang: 'en-US' }, { id: 'af_bella', lang: 'en-US' },
  { id: 'af_nicole', lang: 'en-US' }, { id: 'af_aoede', lang: 'en-US' },
  { id: 'af_kore', lang: 'en-US' }, { id: 'af_sarah', lang: 'en-US' },
  { id: 'af_nova', lang: 'en-US' }, { id: 'af_sky', lang: 'en-US' },
  { id: 'af_alloy', lang: 'en-US' }, { id: 'af_jessica', lang: 'en-US' },
  { id: 'af_river', lang: 'en-US' },
  { id: 'am_michael', lang: 'en-US' }, { id: 'am_fenrir', lang: 'en-US' },
  { id: 'am_puck', lang: 'en-US' }, { id: 'am_echo', lang: 'en-US' },
  { id: 'am_eric', lang: 'en-US' }, { id: 'am_liam', lang: 'en-US' },
  { id: 'am_onyx', lang: 'en-US' }, { id: 'am_santa', lang: 'en-US' },
  { id: 'am_adam', lang: 'en-US' },
  { id: 'bf_emma', lang: 'en-GB' }, { id: 'bf_isabella', lang: 'en-GB' },
  { id: 'bf_alice', lang: 'en-GB' }, { id: 'bf_lily', lang: 'en-GB' },
  { id: 'bm_george', lang: 'en-GB' }, { id: 'bm_fable', lang: 'en-GB' },
  { id: 'bm_daniel', lang: 'en-GB' }, { id: 'bm_lewis', lang: 'en-GB' },
];

/**
 * Why an engine was chosen, in words a person can act on.
 *
 * Each of these sends someone somewhere different — one is "your machine cannot do this", one
 * is "it can but the files are not here", one is "you asked for it this way". A single "using
 * system voices" would be true and useless.
 */
export const REASONS = {
  'kokoro': 'Kokoro — neural voices, running on this machine',
  'no-webgpu': 'System voices — this browser has no WebGPU, and Kokoro without it is too slow to hold a conversation',
  'no-assets': 'System voices — the Kokoro voice model is not installed',
  'not-built': 'System voices — the Kokoro model is downloaded, but the engine that reads it is not built yet',
  'preference': 'System voices — chosen in settings',
  'system': 'System voices',
};

/**
 * Whether there is anything here that can actually run the model.
 *
 * **False until HeadTTS is vendored and wired**, and it has to be checked or the product lies:
 * the weights are downloadable *now*, so a machine with WebGPU would otherwise pass both gates,
 * be told "Kokoro — neural voices, running on this machine", and then fail to speak with
 * "the model is not installed" — which would be untrue twice over.
 *
 * A constant rather than a probe, unlike the asset check, because there is no file to look for
 * until the code exists. It flips in one place on the day it does, and the test below makes
 * sure the copy stays honest either way.
 */
export const KOKORO_IMPLEMENTED = true;

/**
 * Picks an engine from what is actually available.
 *
 * **WebGPU is a hard gate, not a preference.** Kokoro runs about three times faster than real
 * time on WebGPU and roughly ten times slower than *that* on the WASM fallback — which is not
 * a degraded experience, it is an unusable one, and shipping it would make the product feel
 * broken on exactly the machines least able to afford it. Falling back to system voices is the
 * status quo rather than a failure, which is what makes the gate safe to enforce.
 *
 * @param hasWebGPU        `navigator.gpu` is present
 * @param hasKokoroAssets  the model and voices are actually on disk
 * @param preference       `'system'` to force it, anything else to allow the best available
 */
export function chooseEngine({
  hasWebGPU = false, hasKokoroAssets = false, preference = 'auto',
  implemented = KOKORO_IMPLEMENTED,
} = {}) {
  if (preference === 'system') return { engine: 'system', reason: 'preference' };
  if (!hasWebGPU) return { engine: 'system', reason: 'no-webgpu' };
  if (!hasKokoroAssets) return { engine: 'system', reason: 'no-assets' };
  // Checked last, so the reason names the *nearest* obstacle: somebody without WebGPU should be
  // told that, not told we have not finished building something they could not have run anyway.
  if (!implemented) return { engine: 'system', reason: 'not-built' };
  return { engine: 'kokoro', reason: 'kokoro' };
}

/** One sentence for the setup page, so the choice is visible rather than mysterious. */
export function describeEngine(choice) {
  return REASONS[choice?.reason] ?? REASONS.system;
}

/**
 * Whether this context can run Kokoro fast enough to be worth it.
 *
 * `navigator.gpu.requestAdapter()` rather than the mere presence of `navigator.gpu`: the object
 * exists in browsers that then refuse to give you an adapter — a blocklisted driver, a headless
 * session, a machine with no usable GPU — and treating the property as the answer would route
 * those to an engine that cannot run.
 */
export async function hasWebGPU() {
  try {
    const gpu = globalThis.navigator?.gpu;
    if (!gpu?.requestAdapter) return false;
    return Boolean(await gpu.requestAdapter());
  } catch {
    return false;
  }
}

/**
 * A Kokoro voice per agent, matching accent to whatever they were set up with.
 *
 * Stable and distinct, by the same argument as the system voices: agents are told apart by name
 * and by voice, and two that sound alike have lost the half that works when nobody is looking
 * at the screen. A stored `en-GB` hint gets a British voice while there are British voices
 * left, because keeping an agent's accent across an engine change is most of what makes it feel
 * like the same agent.
 */
export function assignKokoroVoices(agents, voices = KOKORO_VOICES) {
  const taken = new Set();
  const out = new Map();
  const known = new Set(voices.map((v) => v.id));

  // **A voice somebody chose is not a hint to be improved on.** The loop below hands out
  // distinct voices so no two agents sound alike, and left to itself it would reassign a
  // deliberate choice on the next roster change — the agent you gave a particular voice to
  // would quietly acquire a different one because somebody else was recorded.
  //
  // So explicit choices are settled first and their voices marked taken. The heuristic then
  // fills in around them, which is what it is for: nobody has said anything about those.
  for (const agent of agents ?? []) {
    if (known.has(agent?.voice)) {
      taken.add(agent.voice);
      out.set(agent.id, agent.voice);
    }
  }

  for (const agent of agents ?? []) {
    if (out.has(agent.id)) continue;
    // A stored *system* voice identifier is not a Kokoro id, but it does say which accent was
    // wanted, so it is still worth reading rather than discarding.
    const wanted = /en-GB/i.test(String(agent?.voice ?? '')) ? 'en-GB' : 'en-US';
    const free = voices.filter((v) => !taken.has(v.id));
    const pool = free.length > 0 ? free : voices;

    const voice = pool.find((v) => v.lang === wanted) ?? pool[0];
    if (!voice) continue;
    taken.add(voice.id);
    out.set(agent.id, voice.id);
  }
  return out;
}
