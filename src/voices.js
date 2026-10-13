// Which voice an agent actually gets on *this* machine.
//
// A stored voice is a **hint, never an address.** Ivan's voice arrived from the Mac app as
// `com.apple.eloquence.en-GB.Eddy`, which exists on macOS and on nothing else – so the same
// roster opened on Windows or Linux would otherwise give every agent the browser default, and
// they would all sound identical. Agents are told apart by name and by voice; losing the voice
// halves that.
//
// **Everything here filters on `localService`.** Chrome on macOS lists Apple's 41 local English
// voices *and* three remote Google ones in the same array, and the remote ones send text to a
// server to be spoken. Taking `voices[0]`, or matching a name without checking, is one of the
// easiest ways to break this product's founding promise, that nothing leaves the device.
//
// Pure functions over plain objects, so the whole of this runs under `node --test` with no
// browser and no speech engine. `SpeechSynthesisVoice` is read-only and shaped like its own
// literal, which makes it unusually easy to test honestly.

/**
 * Only the voices that speak without a network.
 *
 * The filter is `=== true`, not truthiness: a browser that does not implement the property at
 * all leaves it `undefined`, and treating "unknown" as "local" is the exact mistake this guards
 * against. Better to have no voice than a voice that posts what an agent said.
 */
export function localVoices(voices) {
  return (voices ?? []).filter((v) => v?.localService === true);
}

/** `com.apple.eloquence.en-GB.Eddy` → `eddy`. The only portable part of an Apple identifier. */
export function leafName(identifier) {
  const parts = String(identifier ?? '').split('.');
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

/** `en-GB` → `en`. Matching the full tag first keeps an accent when the machine has one. */
function language(tag) {
  return String(tag ?? '').split(/[-_]/)[0].toLowerCase();
}

/**
 * The system voices offered on a Mac, by name – the user's choice of 2026-10-13.
 *
 * macOS lists forty-odd local English voices, many of them variants of one another or novelty
 * voices. Four distinct ones, two American, one British and one Irish, are enough to tell a
 * roster apart, and a short list is one somebody can actually compare. Matched by name, because
 * an enhanced download of a voice carries a different identifier from the compact one.
 *
 * Windows and Linux have none of these names, so there every local English voice is offered
 * until they have a list of their own.
 */
export const PREFERRED_SYSTEM_VOICES = ['Samantha', 'Fred', 'Daniel', 'Moira'];

/** `Eddy (English (UK))` → `Eddy`, `Samantha (Enhanced)` → `Samantha`. */
export function baseName(name) {
  return String(name ?? '').replace(/\s*\(.*\)\s*$/, '').trim();
}

/**
 * The system voices an assistant may be given and Settings lists: local, English, and only the
 * preferred ones where this machine has any of them. A machine with no local English voice at
 * all keeps every local voice it has, so its assistants still speak.
 */
export function offeredVoices(voices) {
  const local = localVoices(voices);
  const english = local.filter((v) => language(v.lang) === 'en');
  const preferred = english.filter((v) => PREFERRED_SYSTEM_VOICES.includes(baseName(v.name)));
  if (preferred.length > 0) return preferred;
  return english.length > 0 ? english : local;
}

/**
 * The best available voice for one stored identifier.
 *
 * Five steps, narrowing from "the very voice that was chosen" to "any voice at all that is not
 * already somebody else's". Each is a weaker claim than the last, and the order is what keeps
 * a roster sounding the way it was set up wherever that is possible.
 *
 * @param stored     what the roster recorded – a URI, an Apple identifier, or nothing
 * @param available  this machine's voices, already filtered to local
 * @param taken      voice URIs other agents have been given, so two agents never collide
 * @param prefer     a language tag to fall back toward, default `en`
 */
export function resolveVoice(stored, available, { taken = new Set(), prefer = 'en-GB' } = {}) {
  const pool = available.filter((v) => !taken.has(v.voiceURI));
  // With everything taken, collide rather than fall silent: two agents sounding alike is worse
  // than one that cannot speak, but only slightly, and it only happens with more agents than
  // the machine has voices.
  const choose = (list) => list[0] ?? null;
  const from = pool.length > 0 ? pool : available;
  if (from.length === 0) return null;

  const leaf = leafName(stored);

  // 1. The exact voice, by URI. The only match that is not an inference.
  const byURI = from.find((v) => stored && v.voiceURI === stored);
  if (byURI) return byURI;

  // 2. The same voice by name. `com.apple.eloquence.en-GB.Eddy` and a voice called "Eddy" are
  //    the same voice wearing two identifiers, and this is what survives a Mac-app import.
  const byName = from.find((v) => leaf && leafName(v.voiceURI) === leaf);
  if (byName) return byName;
  const byLabel = from.find((v) => leaf && String(v.name ?? '').toLowerCase().includes(leaf));
  if (byLabel) return byLabel;

  // 3. Same language *and region* – keeps a British agent British where the machine can.
  const sameTag = from.find((v) => String(v.lang ?? '').toLowerCase() === prefer.toLowerCase());
  if (sameTag) return sameTag;

  // 4. Same language, any region.
  const sameLang = from.find((v) => language(v.lang) === language(prefer));
  if (sameLang) return sameLang;

  // 5. Anything that speaks locally.
  return choose(from);
}

/**
 * A voice for every agent, all different where the machine allows it.
 *
 * Resolved in roster order and greedily, which matters: the first agent gets the closest match
 * to what was chosen, and later ones take what is left. The alternative – everyone getting
 * their own best match independently – hands the same voice to two agents whenever both were
 * set up with it, and two agents that sound alike cannot be told apart by ear, which is the
 * only way anyone hears them.
 *
 * @returns Map of agent id → voice, omitting agents for which nothing local exists.
 */
export function assignVoices(agents, voices) {
  const available = localVoices(voices);
  const taken = new Set();
  const out = new Map();

  for (const agent of agents ?? []) {
    const voice = resolveVoice(agent.voice, available, { taken });
    if (!voice) continue;
    taken.add(voice.voiceURI);
    out.set(agent.id, voice);
  }
  return out;
}
