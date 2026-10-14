// Which engine speaks, and in whose voice.
//
// Three engines, chosen at runtime rather than at build time:
//
// - **System** (`speechSynthesis`) – always present, free, and on macOS it is Apple's own 41
//   local voices, which is the same set the Mac app used. Elsewhere it is whatever the OS
//   ships, which on Windows is SAPI and on Linux is a lottery.
// - **Kokoro** (E6) – 82M parameters of neural TTS, Apache-2.0, run locally through ONNX. It
//   is the answer to "the voices are ugly, too robotic", and it needs WebGPU to be fast enough
//   to hold a conversation with.
// - **Supertonic 3** – neural TTS in 31 languages, about five times faster than Kokoro here,
//   also on WebGPU. Its weights are Open RAIL-M, so it is only ever chosen once somebody has
//   agreed to the licence's use restrictions, and Kokoro stays for anyone who cannot.
//
// **The selection is the interesting part and it is pure, so it is tested.** Getting it wrong
// is not a crash: it is a product that sounds worse than it should on a capable machine, or
// one that stutters unusably on a machine that cannot keep up – and both of those are
// invisible on whatever laptop the developer happened to use.

import { VOICES, langOf, SUPERTONIC, SUPERTONIC_LICENCE } from './weights.js';

/**
 * Kokoro's English voices, Apache-2.0 with the weights.
 *
 * **Derived from `weights.js` rather than listed again here.** This was a hand-written array of
 * the same 28 ids with a `lang` on each, which was defensible only while the two lists genuinely
 * differed – the published set was 28 and six were downloaded, and the gap was the whole reason
 * `assignKokoroVoices` takes an `installed` argument. All 28 now ship, so a second copy is just
 * somewhere for the two to disagree, and the way they would disagree is the worst kind: a voice
 * assigned from this list that nobody downloaded fails at the first answer, three layers from
 * anything that could explain it.
 *
 * Order is carried over unchanged, and it matters – see the note on `VOICES`.
 */
export const KOKORO_VOICES = VOICES.map(({ id }) => ({ id, lang: langOf(id) }));

/**
 * Supertonic's ten voices, from `weights.js` for the same reason. Every one speaks every
 * language, so the only thing to know about a voice besides its id is whether it is female or
 * male, and the id says that too.
 */
export const SUPERTONIC_VOICES = SUPERTONIC.voices.map(({ id }) => ({ id, gender: genderOf(id) }));

/**
 * `female`, `male`, or null, from either engine's voice id.
 *
 * Kokoro names voices `<accent><gender>_<name>` (`af_heart`), Supertonic `<gender><number>`
 * (`F1`). Anything else, a system voice's identifier among them, says nothing about gender.
 */
export function genderOf(id) {
  const text = String(id ?? '');
  const letter = /^[ab][fm]_/.test(text) ? text[1] : /^[FM][1-9]$/.test(text) ? text[0].toLowerCase() : null;
  return letter === 'f' ? 'female' : letter === 'm' ? 'male' : null;
}

/**
 * Why an engine was chosen, in words a person can act on.
 *
 * Each of these sends someone somewhere different – one is "your machine cannot do this", one
 * is "it can but the files are not here", one is "you asked for it this way". A single "using
 * system voices" would be true and useless.
 */
export const REASONS = {
  'supertonic': 'Supertonic – neural voices, running on this machine',
  'kokoro': 'Kokoro – neural voices, running on this machine',
  'no-webgpu': 'System voices – this browser has no WebGPU, and the neural voices are too slow without it to hold a conversation',
  'no-assets': 'System voices – no neural voice model is installed',
  'no-agreement': 'System voices – Supertonic is downloaded, but its use restrictions have not been agreed to',
  'not-built': 'System voices – the Kokoro model is downloaded, but the engine that reads it is not built yet',
  'preference': 'System voices – chosen in settings',
  'system': 'System voices',
};

/**
 * Whether a stored agreement covers the licence Supertonic's weights are under now.
 *
 * Matched on the licence's version as well as its presence, so if the weights ever moved to a
 * different licence, an agreement to the old one would not carry over to terms nobody was shown.
 */
export function agreedToSupertonic(agreement) {
  return agreement?.licence === SUPERTONIC_LICENCE.name
    && agreement?.version === SUPERTONIC_LICENCE.version;
}

/**
 * Whether there is anything here that can actually run the model.
 *
 * **False until HeadTTS is vendored and wired**, and it has to be checked or the product lies:
 * the weights are downloadable *now*, so a machine with WebGPU would otherwise pass both gates,
 * be told "Kokoro – neural voices, running on this machine", and then fail to speak with
 * "the model is not installed" – which would be untrue twice over.
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
 * time on WebGPU and roughly ten times slower than *that* on the WASM fallback – which is not
 * a degraded experience, it is an unusable one, and shipping it would make the product feel
 * broken on exactly the machines least able to afford it. Falling back to system voices is the
 * status quo rather than a failure, which is what makes the gate safe to enforce.
 *
 * **Between the two neural engines, Supertonic unless somebody chose Kokoro**, and only from
 * what is installed:
 *
 * | Installed | Speaks |
 * |---|---|
 * | Supertonic only | Supertonic |
 * | Kokoro only | Kokoro, so an existing install keeps exactly what it has |
 * | Both | Supertonic, or Kokoro if that is the stored preference |
 * | Neither | the system voices |
 *
 * **Supertonic is never chosen without a stored agreement to its licence**, however it came to
 * be on disk. The agreement is what binds its use restrictions to the person using it, so
 * weights without one are treated as weights that are not there.
 *
 * @param hasWebGPU            `navigator.gpu` gives an adapter
 * @param hasKokoroAssets      Kokoro's model and voices are actually on disk
 * @param hasSupertonicAssets  Supertonic's graphs and voices are actually on disk
 * @param agreement            the stored agreement to Supertonic's licence, or null
 * @param preference           `'system'` to force it, `'kokoro'` to prefer Kokoro when both are
 *                             installed, anything else for the best available
 */
export function chooseEngine({
  hasWebGPU = false, hasKokoroAssets = false, hasSupertonicAssets = false, agreement = null,
  preference = 'auto', implemented = KOKORO_IMPLEMENTED,
} = {}) {
  if (preference === 'system') return { engine: 'system', reason: 'preference' };
  if (!hasWebGPU) return { engine: 'system', reason: 'no-webgpu' };

  const supertonic = hasSupertonicAssets && agreedToSupertonic(agreement);
  const kokoro = hasKokoroAssets && implemented;
  if (kokoro && (preference === 'kokoro' || !supertonic)) return { engine: 'kokoro', reason: 'kokoro' };
  if (supertonic) return { engine: 'supertonic', reason: 'supertonic' };

  // Nothing can speak. Name the nearest obstacle, so somebody is sent to the thing that is
  // actually in the way: an agreement not given, then an engine not built, then a missing download.
  if (hasSupertonicAssets) return { engine: 'system', reason: 'no-agreement' };
  if (hasKokoroAssets) return { engine: 'system', reason: 'not-built' };
  return { engine: 'system', reason: 'no-assets' };
}

/** One sentence for the setup page, so the choice is visible rather than mysterious. */
export function describeEngine(choice) {
  return REASONS[choice?.reason] ?? REASONS.system;
}

/**
 * Whether this context can run Kokoro fast enough to be worth it.
 *
 * `navigator.gpu.requestAdapter()` rather than the mere presence of `navigator.gpu`: the object
 * exists in browsers that then refuse to give you an adapter – a blocklisted driver, a headless
 * session, a machine with no usable GPU – and treating the property as the answer would route
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
  // deliberate choice on the next roster change – the agent you gave a particular voice to
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
    // And a Supertonic voice somebody chose says which gender, so an agent moved back to Kokoro
    // keeps it. Null for everything else, which leaves the choice exactly as it always was.
    const gender = genderOf(agent?.voice);
    const free = voices.filter((v) => !taken.has(v.id));
    const pool = free.length > 0 ? free : voices;

    const voice = pool.find((v) => v.lang === wanted && (!gender || genderOf(v.id) === gender))
      ?? pool.find((v) => v.lang === wanted) ?? pool[0];
    if (!voice) continue;
    taken.add(voice.id);
    out.set(agent.id, voice.id);
  }
  return out;
}

/**
 * A Supertonic voice per agent: one somebody chose is kept, and the rest are handed out in the
 * fixed order of `SUPERTONIC_VOICES`, distinct until all ten are in use and repeating after that.
 *
 * **The gender carries over from Kokoro.** Each agent without a chosen Supertonic voice gets one
 * of the gender of the Kokoro voice it has, chosen or assigned, because Kokoro is what most
 * people heard before Supertonic and an agent changing from a woman's voice to a man's would
 * not feel like the same agent. Every agent has a Kokoro voice to read, so every agent gets a hint.
 *
 * Supertonic's voices have no accent to keep: each one speaks every language it knows the same way.
 */
export function assignSupertonicVoices(agents, voices = SUPERTONIC_VOICES) {
  const taken = new Set();
  const out = new Map();
  const known = new Set(voices.map((v) => v.id));

  // Chosen voices first, as for Kokoro, so a deliberate choice is never reassigned.
  for (const agent of agents ?? []) {
    if (known.has(agent?.voice)) {
      taken.add(agent.voice);
      out.set(agent.id, agent.voice);
    }
  }

  const kokoro = assignKokoroVoices(agents);
  for (const agent of agents ?? []) {
    if (out.has(agent.id)) continue;
    const gender = genderOf(kokoro.get(agent.id));
    const free = voices.filter((v) => !taken.has(v.id));
    const pool = free.length > 0 ? free : voices;

    const voice = pool.find((v) => v.gender === gender) ?? pool[0];
    if (!voice) continue;
    taken.add(voice.id);
    out.set(agent.id, voice.id);
  }
  return out;
}
