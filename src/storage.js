// The roster, in `chrome.storage.local`.
//
// A transposition of `Sources/OpenPosseKit/Store/AgentStore.swift`, deliberately keeping its
// decisions rather than re-deriving them – each one was made for a reason that has not changed
// just because the host has.
//
// **Agents and recipes are stored separately**, under `agents` and `recipe:<id>` keys. Same
// argument as the two files on disk: an `Agent` refers to its recipe by id, so re-recording a
// vendor whose UI drifted must not disturb the name or voice the user chose. One combined
// blob would rewrite the whole roster on every re-record.
//
// The shapes are unchanged from `OpenPosseShared`, so a recipe recorded by the Mac app imports
// as-is. That is not sentiment – it is the only reason V1 starts with a working Notion agent
// instead of an empty list.

import { assignChannels, pickChannel, CHANNELS } from './channels.js';

const AGENTS_KEY = 'agents';
const MIC_KEY = 'micGranted';
const SPEED_KEY = 'voiceSpeed';
const recipeKey = (id) => `recipe:${id}`;

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
 * **The default is 1, deliberately, even though 1 measured slow.** Kokoro's own pace came out at
 * 102–126 wpm against a natural ~150 on one roster on one machine, which is an observation about
 * those voices rather than a finding about the product. Shipping a different default on that
 * evidence would change what every user hears to match one person's ear. Move it when there are
 * numbers from more than one of them.
 */
const SPEED_DEFAULT = 1;
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

/** A v4-ish id. Only has to be unique within one browser profile. */
export function newID() {
  return crypto.randomUUID().toUpperCase();
}

// ── Reading ────────────────────────────────────────────────────────────────────────────────

/**
 * Every agent, plus which of them cannot work.
 *
 * **An agent whose recipe is missing is listed, not dropped.** It still routes – a name match
 * will happily decide an utterance was meant for it – and then fails when asked. Naming it is
 * what lets the popup offer a re-record instead of the user discovering it by being answered
 * with an error.
 */
export async function loadRoster() {
  let agents = [];
  try {
    const stored = await chrome.storage.local.get(AGENTS_KEY);
    // Every agent leaves here with a colour. Every write below starts from this list, so the
    // first write stores colours for agents that predate them – see `assignChannels`.
    agents = assignChannels(Array.isArray(stored[AGENTS_KEY]) ? stored[AGENTS_KEY] : []);
  } catch {
    // Unreadable storage must not stop the extension starting. An empty roster with an
    // explanation is recoverable; throwing on every service-worker wake is not.
    return { agents: [], broken: [], problem: "Your saved assistants couldn't be read." };
  }

  const keys = agents.map((a) => recipeKey(a.recipeID)).filter(Boolean);
  const recipes = keys.length ? await chrome.storage.local.get(keys) : {};
  const broken = agents
    .filter((a) => !recipes[recipeKey(a.recipeID)])
    .map((a) => a.id);

  return { agents, broken, problem: null };
}

export async function recipeFor(agent) {
  if (!agent?.recipeID) return null;
  const stored = await chrome.storage.local.get(recipeKey(agent.recipeID));
  return stored[recipeKey(agent.recipeID)] ?? null;
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
 * Adds an agent and the recipe it drives.
 *
 * **The recipe is written first.** If this is interrupted between the two writes, an orphan
 * recipe costs a few kilobytes; an agent whose recipe never landed is a roster entry that
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

/** Renames an agent. The recipe keeps its own copy, so both are updated. */
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

  // `agentName` is denormalised into the recipe, so leaving it would make the two disagree –
  // and the recipe's copy is what the recorder's own diagnostics read back.
  if (agent.recipeID) {
    const key = recipeKey(agent.recipeID);
    const stored = (await chrome.storage.local.get(key))[key];
    if (stored) await chrome.storage.local.set({ [key]: { ...stored, agentName: wanted } });
  }

  return { ok: true, name: wanted };
}

export async function addAgent({ name, voice, recipe }) {
  const recipeID = newID();
  const stored = { ...recipe, agentName: name };

  await chrome.storage.local.set({ [recipeKey(recipeID)]: stored });

  const { agents } = await loadRoster();
  // Chosen now and kept, so no later rename or deletion can recolour it – or anybody else.
  const channel = pickChannel(agents.map((a) => a.channel));
  const agent = { id: newID(), name, voice, recipeID, connection: 'browser', channel };
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
 * Replaces an agent's recipe, keeping its id, name and voice.
 *
 * This is what re-recording a drifted vendor does, and the reason recipes are stored apart
 * from the roster in the first place.
 */
export async function replaceRecipe(agentID, recipe) {
  const { agents } = await loadRoster();
  const agent = agents.find((a) => a.id === agentID);
  if (!agent) return false;
  await chrome.storage.local.set({
    [recipeKey(agent.recipeID)]: { ...recipe, agentName: agent.name },
  });
  return true;
}

export async function removeAgent(agentID) {
  const { agents } = await loadRoster();
  const agent = agents.find((a) => a.id === agentID);
  if (!agent) return false;

  // Roster first. A recipe deleted before a failed roster write would leave an agent pointing
  // at nothing.
  await chrome.storage.local.set({ [AGENTS_KEY]: agents.filter((a) => a.id !== agentID) });
  await chrome.storage.local.remove(recipeKey(agent.recipeID));
  return true;
}

// Importing a roster from the parked Mac app lived here until 2026-09-30. It came out with the
// setup step that was its only caller: V1 is the whole product, the Swift side never shipped, so
// there is nobody holding an `~/Library/Application Support/OpenPosse` to bring across. Recover
// it from git if V2 ever needs it – the shape it decoded is recorded in `docs/protocol.md`.
