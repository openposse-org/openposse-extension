// The roster, in `chrome.storage.local`.
//
// A transposition of `Sources/OpenPosseKit/Store/AgentStore.swift`, deliberately keeping its
// decisions rather than re-deriving them – each one was made for a reason that has not changed
// just because the host has.
//
// **Agents and lassos are stored separately**, under `agents` and `lasso:<id>` keys. Same
// argument as the two files on disk: an `Agent` refers to its lasso by id, so re-recording a
// vendor whose UI drifted must not disturb the name or voice the user chose. One combined
// blob would rewrite the whole roster on every re-record.
//
// The shapes are unchanged from `OpenPosseShared`, so a lasso recorded by the Mac app imports
// as-is. That is not sentiment – it is the only reason V1 starts with a working Notion agent
// instead of an empty list.

import { assignChannels, pickChannel, CHANNELS } from './channels.js';
import { MOCK_SIZES, mockRecordings } from './mocks.js';
import { inOrder } from './order.js';

const AGENTS_KEY = 'agents';
// How the roster is drawn, apart from `agents` – see order.js for why it cannot be that list.
const ORDER_KEY = 'rosterOrder';
const MIC_KEY = 'micGranted';
const SPEED_KEY = 'voiceSpeed';
const lassoKey = (id) => `lasso:${id}`;

// ── The microphone, remembered rather than predicted ───────────────────────────────────────
//
// **`navigator.permissions.query({name:'microphone'})` is not a source of truth here.**
// `prompt` is its default *and* its fallback, so an unsupported query, a wrapper that
// swallowed an error, and a genuine "never asked" all look identical – and from a popup it
// reports `prompt` even when the grant is live. The spec itself is ambiguous enough that it
// can say `prompt` while `getUserMedia` is actively running.
//
// So the setup page, which really calls `getUserMedia` and therefore *knows*, records what
// happened. Everywhere else reads the record. A fact beats an inference, and this is the
// difference between the popup reporting a broken microphone and a working one.
//
// `denied` remains worth reading directly: it is the one state the API is unambiguous about,
// and the one nothing in our UI can fix.

export async function setMicGranted(granted) {
  await chrome.storage.local.set({ [MIC_KEY]: Boolean(granted) });
}

export async function micGranted() {
  const stored = await chrome.storage.local.get(MIC_KEY);
  return stored[MIC_KEY] === true;
}

/**
 * How fast answers are read out, as a multiplier. 1 is each engine's own pace.
 *
 * **One number for both engines, because they are the same scale and the user is not choosing
 * an engine.** Kokoro takes `speed` and drives it through its duration predictor; a system voice
 * takes `utterance.rate`; both are 1-is-normal and both stretch time without moving pitch. Which
 * of the two is speaking depends on whether the weights downloaded, which is not a thing anybody
 * should have to think about while deciding how fast they want to be spoken to.
 *
 * **The default is 1.3, by the user's decision of 2026-10-13.** It was 1 until then, because 1
 * measured slow only on one roster on one machine: Kokoro came out at 102–126 wpm against a
 * natural ~150, and 1.3 is roughly what closes that gap. It is one number for both engines, so
 * the system voices are 1.3× too. A pace somebody has already chosen is kept.
 *
 * Supertonic is the exception, by the user's decision of 2026-10-15: it speaks faster at the same
 * number, so it runs at 1.2/1.3 of this pace (`supertonicSpeed` in tts.js). Still one setting.
 */
const SPEED_DEFAULT = 1.3;
// HeadTTS refuses anything outside this and says so; `utterance.rate` would silently clamp.
// Enforced here so one stored value cannot be valid for one engine and rejected by the other.
const SPEED_MIN = 0.25;
const SPEED_MAX = 4;

export function clampSpeed(value) {
  // **Empty is not zero, and `Number` disagrees.** `Number(null)`, `Number('')` and `Number([])`
  // are all 0, which is finite – so without this guard an unset value clamps to the *slowest*
  // pace the engines allow rather than reading as "nobody has chosen one". Caught by a test
  // rather than by a user wondering why their assistant started drawling.
  if (value === null || value === undefined || value === '') return SPEED_DEFAULT;
  const n = Number(value);
  if (!Number.isFinite(n)) return SPEED_DEFAULT;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, n));
}

export async function voiceSpeed() {
  const stored = await chrome.storage.local.get(SPEED_KEY).catch(() => ({}));
  // A missing key is the default rather than a fault: nobody has opened Settings yet.
  return stored[SPEED_KEY] === undefined ? SPEED_DEFAULT : clampSpeed(stored[SPEED_KEY]);
}

export async function setVoiceSpeed(value) {
  const speed = clampSpeed(value);
  await chrome.storage.local.set({ [SPEED_KEY]: speed });
  return speed;
}

// ── Which neural voice, and Supertonic's agreement ─────────────────────────────────────────
//
// Both are read where an answer starts and sent with it, like the pace: the offscreen document
// that speaks has only `chrome.runtime`, so it cannot read them itself. `chooseEngine` in tts.js
// is what acts on them.

const ENGINE_KEY = 'voiceEngine';
const AGREEMENT_KEY = 'supertonicAgreement';
const LANGUAGE_KEY = 'voiceLanguage';

/**
 * `auto` picks the best installed engine; `kokoro` prefers Kokoro when Supertonic is installed
 * too; `supertonic` and `system` say what they mean. Anything else, from a newer build or from
 * nowhere, reads as `auto`, which is what everyone had before the setting existed.
 */
export const ENGINES = ['auto', 'supertonic', 'kokoro', 'system'];
export const engineOf = (value) => (ENGINES.includes(value) ? value : 'auto');

export async function setVoiceEngine(value) {
  const engine = engineOf(value);
  await chrome.storage.local.set({ [ENGINE_KEY]: engine });
  return engine;
}

/**
 * Records that somebody agreed to Supertonic's licence, which and when.
 *
 * @param licence  `{ name, version }`, from `SUPERTONIC_LICENCE` in weights.js. Passed in rather
 *                 than imported, so this file does not carry the weights manifest into every page.
 */
export async function setSupertonicAgreement(licence) {
  const agreement = { licence: licence.name, version: licence.version, at: new Date().toISOString() };
  await chrome.storage.local.set({ [AGREEMENT_KEY]: agreement });
  return agreement;
}

export async function clearSupertonicAgreement() {
  await chrome.storage.local.remove(AGREEMENT_KEY);
}

/**
 * The language Supertonic reads answers in, as a two-letter code. Anything that is not one reads
 * as English; whether Supertonic has the language is `supertonicLanguage`'s question in tts.js.
 */
export const languageOf = (value) => (typeof value === 'string' && /^[a-z]{2}$/.test(value) ? value : 'en');

export async function setVoiceLanguage(value) {
  const language = languageOf(value);
  await chrome.storage.local.set({ [LANGUAGE_KEY]: language });
  return language;
}

/**
 * What speaking an answer needs from storage besides the pace: `{ preference, agreement,
 * language }`, which engine is preferred, Supertonic's agreement, and the language it reads in.
 */
export async function engineSettings() {
  try {
    const stored = await chrome.storage.local.get([ENGINE_KEY, AGREEMENT_KEY, LANGUAGE_KEY]);
    return {
      preference: engineOf(stored[ENGINE_KEY]),
      agreement: stored[AGREEMENT_KEY] ?? null,
      language: languageOf(stored[LANGUAGE_KEY]),
    };
  } catch (error) {
    // No agreement is the safe reading: Supertonic is then never chosen, and Kokoro or the
    // system voices answer instead, which is what happened before either setting existed.
    console.warn('[openposse] could not read the voice settings –', error?.message ?? error);
    return { preference: 'auto', agreement: null, language: 'en' };
  }
}

/**
 * How the panel draws its orb: the sphere, or a waveform across the panel. Both are the same
 * instrument (`sphere.js`), so this is a matter of taste and nothing else depends on it. Anything
 * unrecognised reads as the sphere, which is what everyone had before the setting existed.
 */
export const ORB_STYLE_KEY = 'orbStyle';

export const orbStyleOf = (value) => (value === 'wave' ? 'wave' : 'sphere');

export async function orbStyle() {
  const stored = await chrome.storage.local.get(ORB_STYLE_KEY);
  return orbStyleOf(stored[ORB_STYLE_KEY]);
}

export async function setOrbStyle(style) {
  await chrome.storage.local.set({ [ORB_STYLE_KEY]: orbStyleOf(style) });
}

/**
 * Whether the panel's avatars grow when there are few of them (four steps, see `sizeAvatars` in
 * sidepanel.js) or stay the 34px circle however many there are. Off unless switched on in
 * Settings, since 2026-10-13; only `true` turns it on.
 */
export const AVATAR_SIZING_KEY = 'avatarsByCount';

export const avatarsByCountOf = (value) => value === true;

export async function avatarsByCount() {
  const stored = await chrome.storage.local.get(AVATAR_SIZING_KEY);
  return avatarsByCountOf(stored[AVATAR_SIZING_KEY]);
}

export async function setAvatarsByCount(on) {
  await chrome.storage.local.set({ [AVATAR_SIZING_KEY]: avatarsByCountOf(on) });
}

/** A v4-ish id. Only has to be unique within one browser profile. */
export function newID() {
  return crypto.randomUUID().toUpperCase();
}

// ── Reading ────────────────────────────────────────────────────────────────────────────────

/**
 * Every agent, plus which of them cannot work.
 *
 * **An agent whose lasso is missing is listed, not dropped.** It still routes – a name match
 * will happily decide an utterance was meant for it – and then fails when asked. Naming it is
 * what lets the popup offer a re-record instead of the user discovering it by being answered
 * with an error.
 *
 * `arranged` is the same agents in the order arranged in Settings, for drawing the roster.
 * `agents` stays in the order they were added, because voices are handed out by position –
 * see order.js.
 */
export async function loadRoster() {
  let agents = [];
  let order = [];
  try {
    const stored = await chrome.storage.local.get([AGENTS_KEY, ORDER_KEY]);
    // Every agent leaves here with a colour. Every write below starts from this list, so the
    // first write stores colours for agents that predate them – see `assignChannels`.
    agents = assignChannels(Array.isArray(stored[AGENTS_KEY]) ? stored[AGENTS_KEY] : []);
    order = stored[ORDER_KEY];
    if (agents.some((a) => a.recipeID)) agents = await fromRecipes(agents);
  } catch {
    // Unreadable storage must not stop the extension starting. An empty roster with an
    // explanation is recoverable; throwing on every service-worker wake is not.
    return { agents: [], arranged: [], broken: [], problem: "Your saved AI assistants couldn't be read." };
  }

  const keys = agents.map((a) => lassoKey(a.lassoID)).filter(Boolean);
  const lassos = keys.length ? await chrome.storage.local.get(keys) : {};
  const broken = agents
    .filter((a) => !lassos[lassoKey(a.lassoID)])
    .map((a) => a.id);

  return { agents, arranged: inOrder(agents, order), broken, problem: null };
}

/**
 * Moves a roster saved before lassos were called lassos onto the new keys, once.
 *
 * Before the rename an agent pointed at `recipe:<id>` through `recipeID`. The content is the
 * same, so this only renames: the lassos are written first, then the roster, and the old keys go
 * last – the order `addAgent` keeps, so an interruption leaves an orphan rather than an agent
 * pointing at nothing. Running it twice writes the same thing twice.
 */
async function fromRecipes(agents) {
  const old = agents.filter((a) => a.recipeID).map((a) => `recipe:${a.recipeID}`);
  const stored = await chrome.storage.local.get(old);
  const lassos = {};
  const moved = agents.map((agent) => {
    if (!agent.recipeID) return agent;
    const { recipeID, ...rest } = agent;
    const content = stored[`recipe:${recipeID}`];
    if (content) lassos[lassoKey(recipeID)] = content;
    return { ...rest, lassoID: recipeID };
  });
  await chrome.storage.local.set(lassos);
  await chrome.storage.local.set({ [AGENTS_KEY]: moved });
  await chrome.storage.local.remove(old);
  return moved;
}

/**
 * Saves the order the roster is drawn in – a list of agent ids, from Settings.
 *
 * Only ids that exist are kept, so the list never collects the dead. Anyone missing from it is
 * drawn after everyone in it, which is where a new recording lands.
 */
export async function setRosterOrder(ids) {
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
    return { ok: false, reason: 'the new order was not a list of AI assistants' };
  }
  const { agents, problem } = await loadRoster();
  // An unreadable roster would make every id look dead, and saving that would forget the order.
  if (problem) return { ok: false, reason: problem };

  const known = new Set(agents.map((a) => a.id));
  await chrome.storage.local.set({ [ORDER_KEY]: ids.filter((id) => known.has(id)) });
  return { ok: true };
}

export async function lassoFor(agent) {
  if (!agent?.lassoID) return null;
  const stored = await chrome.storage.local.get(lassoKey(agent.lassoID));
  return stored[lassoKey(agent.lassoID)] ?? null;
}

/**
 * Finds an agent by spoken name.
 *
 * Case-insensitive, because the name arrives from a speech recogniser, which is under no
 * obligation to preserve the capitalisation anyone typed.
 */
export function findAgent(agents, name) {
  if (!name) return null;
  const wanted = name.trim().toLowerCase();
  return agents.find((a) => a.name.toLowerCase() === wanted) ?? null;
}

/**
 * Whether a name is taken.
 *
 * Case-insensitively: two agents whose names differ only in case are indistinguishable **out
 * loud**, which is the only way either is ever addressed.
 */
export function isNameTaken(agents, name, exceptID = null) {
  const wanted = name.trim().toLowerCase();
  return agents.some((a) => a.id !== exceptID && a.name.toLowerCase() === wanted);
}

// ── Writing ────────────────────────────────────────────────────────────────────────────────

/**
 * Adds an agent and the lasso it drives.
 *
 * **The lasso is written first.** If this is interrupted between the two writes, an orphan
 * lasso costs a few kilobytes; an agent whose lasso never landed is a roster entry that
 * routes and then fails – the state `broken` exists to describe, and worth not creating.
 */
/**
 * A name nothing else is using, by adding a number rather than refusing.
 *
 * Recording ends with an agent that exists, so there is nobody to ask at the moment a
 * collision happens – a second recording of Notion must not fail because the first is called
 * Notion. The number is visible and the name is editable, which between them say what happened
 * without a dialog.
 */
export function freeName(agents, wanted) {
  const base = wanted.trim() || 'Assistant';
  if (!isNameTaken(agents, base)) return base;
  for (let n = 2; n < 100; n += 1) {
    if (!isNameTaken(agents, `${base} ${n}`)) return `${base} ${n}`;
  }
  return `${base} ${Date.now()}`;
}

/**
 * Gives an agent a voice, or clears it back to being chosen for them.
 *
 * An empty `voice` is a real choice rather than a failure to choose: it puts the agent back
 * under the accent heuristic, which keeps every agent sounding different as the roster changes.
 * Somebody who picks a voice is opting out of that, and out of it being reconsidered later.
 */
export async function setAgentVoice(agentID, voice) {
  const { agents } = await loadRoster();
  if (!agents.some((a) => a.id === agentID)) return { ok: false, reason: 'no such agent' };

  await chrome.storage.local.set({
    [AGENTS_KEY]: agents.map(
      (a) => (a.id === agentID ? { ...a, voice: voice || null } : a),
    ),
  });
  return { ok: true, voice: voice || null };
}

/** Renames an agent. The lasso keeps its own copy, so both are updated. */
export async function renameAgent(agentID, name) {
  const { agents } = await loadRoster();
  const agent = agents.find((a) => a.id === agentID);
  if (!agent) return { ok: false, reason: 'no such agent' };

  const wanted = name.trim();
  if (!wanted) return { ok: false, reason: 'a name is needed' };
  if (isNameTaken(agents, wanted, agentID)) return { ok: false, reason: `${wanted} is taken` };

  await chrome.storage.local.set({
    [AGENTS_KEY]: agents.map((a) => (a.id === agentID ? { ...a, name: wanted } : a)),
  });

  // `agentName` is denormalised into the lasso, so leaving it would make the two disagree –
  // and the lasso's copy is what the recorder's own diagnostics read back.
  if (agent.lassoID) {
    const key = lassoKey(agent.lassoID);
    const stored = (await chrome.storage.local.get(key))[key];
    if (stored) await chrome.storage.local.set({ [key]: { ...stored, agentName: wanted } });
  }

  return { ok: true, name: wanted };
}

export async function addAgent({ name, voice, lasso, origin = null }) {
  const lassoID = newID();
  const stored = { ...lasso, agentName: name };

  await chrome.storage.local.set({ [lassoKey(lassoID)]: stored });

  const { agents } = await loadRoster();
  // Chosen now and kept, so no later rename or deletion can recolour it – or anybody else.
  const channel = pickChannel(agents.map((a) => a.channel));
  const agent = { id: newID(), name, voice, lassoID, connection: 'browser', channel };
  // The lineage of a lasso that came from the website (`docs/lasso-identity.md`), so a newer
  // version of it can be recognised as this agent's. The date and the hash live in the lasso.
  if (origin?.id) agent.origin = { id: origin.id };
  await chrome.storage.local.set({ [AGENTS_KEY]: [...agents, agent] });
  return agent;
}

/**
 * Gives an agent a colour from the palette, chosen in Settings.
 *
 * A colour another agent already has is allowed: it is the person's call, and the picker shows
 * who has it. A value that is not in the palette is refused rather than stored, because it would
 * be drawn as the old hash's guess and look like the choice had not been saved.
 */
export async function setAgentChannel(agentID, channel) {
  if (!CHANNELS.includes(channel)) return { ok: false, reason: `${channel} is not one of the colours` };
  const { agents } = await loadRoster();
  if (!agents.some((a) => a.id === agentID)) return { ok: false, reason: 'no such agent' };

  await chrome.storage.local.set({
    [AGENTS_KEY]: agents.map((a) => (a.id === agentID ? { ...a, channel } : a)),
  });
  return { ok: true, channel };
}

/**
 * Replaces an agent's lasso, keeping its id, name and voice.
 *
 * This is what re-recording a drifted vendor does, and the reason lassos are stored apart
 * from the roster in the first place. Importing a newer version of the agent's lasso does the
 * same, and gives the agent the file's lineage with `origin`; a re-recording passes none and the
 * agent keeps the one it has.
 */
export async function replaceLasso(agentID, lasso, { origin = null } = {}) {
  const { agents } = await loadRoster();
  const agent = agents.find((a) => a.id === agentID);
  if (!agent) return false;
  await chrome.storage.local.set({
    [lassoKey(agent.lassoID)]: { ...lasso, agentName: agent.name },
  });
  if (origin?.id && agent.origin?.id !== origin.id) {
    await chrome.storage.local.set({
      [AGENTS_KEY]: agents.map((a) => (a.id === agentID ? { ...a, origin: { id: origin.id } } : a)),
    });
  }
  return true;
}

export async function removeAgent(agentID) {
  const { agents } = await loadRoster();
  const agent = agents.find((a) => a.id === agentID);
  if (!agent) return false;

  // Roster first. A lasso deleted before a failed roster write would leave an agent pointing
  // at nothing.
  await chrome.storage.local.set({ [AGENTS_KEY]: agents.filter((a) => a.id !== agentID) });
  await chrome.storage.local.remove(lassoKey(agent.lassoID));
  return true;
}

/**
 * Fills the roster to `size` with made-up recordings, replacing any already there, or takes them
 * all out with 0. Why they live in the real roster is in `mocks.js`.
 *
 * **Real agents are carried through untouched and stay first**, so nobody real changes colour on
 * the way in, or voice on the way out – voices are assigned by position. The mocks take colours
 * the way a new recording would, after them.
 */
export async function setMockRoster(size) {
  if (size !== 0 && !MOCK_SIZES.includes(size)) return { ok: false, reason: `${size} is not one of the sizes` };
  const { agents, problem } = await loadRoster();
  // An unreadable roster loads as empty, and writing "empty plus mocks" back would delete
  // every real agent.
  if (problem) return { ok: false, reason: problem };

  const real = agents.filter((a) => !a.mock);
  const gone = agents.filter((a) => a.mock).map((a) => lassoKey(a.lassoID));
  const mocks = [];
  const lassos = {};
  for (const { name, lasso } of mockRecordings(real.length, size)) {
    const taken = [...real, ...mocks];
    const agent = {
      id: newID(), name: freeName(taken, name), voice: null, lassoID: newID(),
      connection: 'browser', channel: pickChannel(taken.map((a) => a.channel)), mock: true,
    };
    lassos[lassoKey(agent.lassoID)] = { ...lasso, agentName: agent.name };
    mocks.push(agent);
  }

  // The order `addAgent` and `removeAgent` keep: new lassos before the roster that points at
  // them, old ones only once nothing does.
  if (mocks.length) await chrome.storage.local.set(lassos);
  await chrome.storage.local.set({ [AGENTS_KEY]: [...real, ...mocks] });
  if (gone.length) await chrome.storage.local.remove(gone);
  return { ok: true, total: real.length + mocks.length, mocks: mocks.length };
}

// Importing a roster from the parked Mac app lived here until 2026-09-30. It came out with the
// setup step that was its only caller: V1 is the whole product, the Swift side never shipped, so
// there is nobody holding an `~/Library/Application Support/OpenPosse` to bring across. Recover
// it from this file's history if V2 ever needs it; the Mac app's repository documents the shape.
