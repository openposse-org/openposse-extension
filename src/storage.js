// The roster, in `chrome.storage.local`.
//
// A transposition of `Sources/OpenPosseKit/Store/AgentStore.swift`, deliberately keeping its
// decisions rather than re-deriving them — each one was made for a reason that has not changed
// just because the host has.
//
// **Agents and recipes are stored separately**, under `agents` and `recipe:<id>` keys. Same
// argument as the two files on disk: an `Agent` refers to its recipe by id, so re-recording a
// vendor whose UI drifted must not disturb the name or voice the user chose. One combined
// blob would rewrite the whole roster on every re-record.
//
// The shapes are unchanged from `OpenPosseShared`, so a recipe recorded by the Mac app imports
// as-is. That is not sentiment — it is the only reason V1 starts with a working Notion agent
// instead of an empty list.

const AGENTS_KEY = 'agents';
const recipeKey = (id) => `recipe:${id}`;

/** A v4-ish id. Only has to be unique within one browser profile. */
export function newID() {
  return crypto.randomUUID().toUpperCase();
}

// ── Reading ────────────────────────────────────────────────────────────────────────────────

/**
 * Every agent, plus which of them cannot work.
 *
 * **An agent whose recipe is missing is listed, not dropped.** It still routes — a name match
 * will happily decide an utterance was meant for it — and then fails when asked. Naming it is
 * what lets the popup offer a re-record instead of the user discovering it by being answered
 * with an error.
 */
export async function loadRoster() {
  let agents = [];
  try {
    const stored = await chrome.storage.local.get(AGENTS_KEY);
    agents = Array.isArray(stored[AGENTS_KEY]) ? stored[AGENTS_KEY] : [];
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
 * routes and then fails — the state `broken` exists to describe, and worth not creating.
 */
export async function addAgent({ name, voice, recipe }) {
  const recipeID = newID();
  const stored = { ...recipe, agentName: name };

  await chrome.storage.local.set({ [recipeKey(recipeID)]: stored });

  const { agents } = await loadRoster();
  const agent = { id: newID(), name, voice, recipeID, connection: 'browser' };
  await chrome.storage.local.set({ [AGENTS_KEY]: [...agents, agent] });
  return agent;
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

// ── Importing from the Mac app ─────────────────────────────────────────────────────────────

/**
 * Takes the contents of `~/Library/Application Support/OpenPosse/` and makes a roster of it.
 *
 * The Swift `Agent` nests its connection as `{"browser": {"recipeID": "…"}}` and its voice as
 * `{"system": {"identifier": "…"}}`; both flatten here. The voice identifier is kept but must
 * be treated as a *hint* — `com.apple.eloquence.en-GB.Eddy` does not exist on Windows, so
 * resolution happens against the runtime voice list, not against this string.
 *
 * @param files {File[]} everything from a directory picker; anything unrecognised is ignored.
 */
export async function importFromMacApp(files) {
  const read = async (file) => JSON.parse(await file.text());
  const result = { imported: [], skipped: [], problem: null };

  const agentsFile = files.find((f) => f.name === 'agents.json');
  if (!agentsFile) {
    result.problem = "No agents.json in that folder — pick the OpenPosse folder itself.";
    return result;
  }

  let macAgents;
  try {
    macAgents = await read(agentsFile);
  } catch {
    result.problem = "agents.json couldn't be read.";
    return result;
  }

  // Recipes arrive as `recipes/<uuid>.json`, so index by the id in the filename.
  const recipeFiles = new Map();
  for (const file of files) {
    const match = file.name.match(/^([0-9A-Fa-f-]{36})\.json$/);
    if (match) recipeFiles.set(match[1].toUpperCase(), file);
  }

  const { agents: existing } = await loadRoster();

  for (const macAgent of macAgents) {
    const recipeID = macAgent?.connection?.browser?.recipeID?.toUpperCase();
    const file = recipeID && recipeFiles.get(recipeID);
    if (!file) {
      result.skipped.push({ name: macAgent?.name ?? 'unnamed', why: 'its recipe was missing' });
      continue;
    }
    if (isNameTaken(existing, macAgent.name)) {
      result.skipped.push({ name: macAgent.name, why: 'a name already in use' });
      continue;
    }

    try {
      await addAgent({
        name: macAgent.name,
        voice: macAgent?.voice?.system?.identifier ?? null,
        recipe: await read(file),
      });
      existing.push({ id: 'pending', name: macAgent.name });
      result.imported.push(macAgent.name);
    } catch {
      result.skipped.push({ name: macAgent.name, why: 'its recipe could not be read' });
    }
  }

  return result;
}
