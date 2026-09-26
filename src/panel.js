// Putting the orb on screen, and keeping it told.
//
// The panel belongs over the tab you are **looking at**, which is usually not a vendor's tab
// and therefore not an origin we hold a permission for. So it is injected per turn rather than
// registered: pressing the shortcut grants `activeTab` for that one tab, which is exactly the
// scope and exactly the duration this needs. No new origin is requested and nothing persists.
//
// Some tabs can never host it — `chrome://` pages, the Web Store, a PDF viewer, a tab that has
// gone. That is not a failure worth reporting: the badge already carries the state, and the
// alternative is asking for host permission over every site the user visits, which is the one
// thing this extension's permission model exists to avoid.

import { loadRoster } from './storage.js';
import { channelFor, initialFor } from './channels.js';

/** Where the panel currently is, so state updates go to one tab rather than being broadcast. */
let panelTabId = null;

/**
 * The injection this turn is waiting on.
 *
 * **It has to be shared, because the two halves of a turn start at the same moment.** The
 * command handler fires `primePanel` without awaiting it — it cannot await, the whole point is
 * that nothing comes between the keypress and `executeScript` — and then starts the listening
 * path, which reaches `panel({ create })` while that injection is still in the air. Without
 * this, that call found `panelTabId` still null and dropped the state message on the floor: the
 * orb was injected, rendered, and never told to become visible.
 *
 * The symptom was "it doesn't work the first time", because the *second* attempt found the id
 * left behind by the first.
 */
let injection = null;

/**
 * Injects the panel, and **must be called before anything is awaited.**
 *
 * This is the whole reason the orb appeared on Notion and nowhere else. Notion has a standing
 * host permission, so it needs no gesture; every other tab relies on `activeTab`, which is
 * granted *by the keypress* and does not survive being spent. The first version reached
 * `executeScript` through six awaits — a storage read, a session write, a badge update, a
 * `commands.getAll()` and a `tabs.query()` — and by then the grant was gone. The symptom was a
 * panel that worked on one site, which reads as the panel being broken rather than as a
 * permission being lost.
 *
 * So the command handler calls this first, with the tab **the event itself carries**: no query,
 * no storage, nothing between the keypress and the injection.
 *
 * @param tabId the tab from `chrome.commands.onCommand`, when there is one.
 */
export function primePanel(tabId) {
  injection = place(tabId);
  return injection;
}

async function place(tabId) {
  if (tabId != null) return injectInto(tabId);
  // No tab on the event: a global shortcut fired while Chrome was in the background. Falling
  // back to a query is right for the popup's button, and for the global case it will usually
  // fail — correctly, since nobody is looking at a browser window to see a panel in.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id == null ? null : injectInto(tab.id);
}

async function injectInto(tabId) {
  const tab = { id: tabId };
  if (!tab?.id) return null;
  try {
    // Idempotent by a guard inside `orb.js`, so re-injecting after a navigation rebuilds the
    // panel and re-injecting into a live one does nothing.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['dist/orb.js'] });
    panelTabId = tab.id;
    return tab.id;
  } catch (error) {
    // **Said out loud, not swallowed.** The first version caught this silently, and the
    // symptom was "the orb appears on Notion and nowhere else" with nothing to explain it —
    // which is indistinguishable from the panel being broken. The message tells the two apart:
    // "Cannot access contents of url" means we hold no permission for that tab, anything else
    // means the injection itself failed. A URL is not page content; it is the one fact needed
    // to know which of those happened.
    console.warn('[openposse] panel could not be injected:', error?.message ?? error);
    panelTabId = null;
    return null;
  }
}

/** The roster as the panel draws it: a name, a letter and a colour. Never a recipe. */
async function rosterForPanel() {
  const { agents } = await loadRoster();
  return agents.map((agent) => ({
    name: agent.name,
    initial: initialFor(agent.name),
    channel: channelFor(agent.name),
  }));
}

/**
 * Pushes state to the panel, injecting it first if this is the start of a turn.
 *
 * Every field is optional and merged, so a caller says only what changed — an interim
 * transcript does not have to restate the roster, and a phase change does not clear the text.
 */
export async function panel(patch, { create = false } = {}) {
  if (create) {
    // Wait for the gesture path's injection rather than racing it, and start one here only for
    // the routes that have no gesture — the popup's button, a typed question.
    panelTabId = await (injection ?? primePanel());
    injection = null;             // consumed; the next turn primes its own
    const shortcut = (await chrome.commands.getAll()).find((c) => c.name === 'summon')?.shortcut;
    patch = { agents: await rosterForPanel(), shortcut: shortcut ?? '', ...patch };
  }
  if (panelTabId === null) return;

  try {
    await chrome.tabs.sendMessage(panelTabId, { kind: 'openposse.orb', state: patch });
  } catch {
    // The tab navigated, closed, or the grant lapsed. Forget it rather than retrying into
    // nothing; the next turn injects again.
    panelTabId = null;
  }
}

/**
 * The microphone level, on its own channel.
 *
 * **Deliberately not routed through `panel()`.** That merges into the panel's state and the orb
 * re-renders its DOM on every one — rebuilding avatars, status and answer twenty times a second
 * to move a sphere's radius. This is a number the renderer eases toward between frames and
 * nothing else reads, so it gets its own message and touches no state.
 */
export function panelLevel(value) {
  if (panelTabId === null) return;
  chrome.tabs.sendMessage(panelTabId, { kind: 'openposse.orb.level', level: value })
    .catch(() => { /* the tab went; the next turn re-injects */ });
}

/**
 * Whether an agent is currently talking.
 *
 * Its own message for the same reason the level is: it must not re-render, and it must not be
 * merged into the state the dismiss timer reads from. What it buys is a panel that does not
 * fade out mid-sentence.
 */
export function panelSpeaking(speaking) {
  if (panelTabId === null) return;
  chrome.tabs.sendMessage(panelTabId, { kind: 'openposse.orb.speaking', speaking })
    .catch(() => {});
}

/** Fades the panel out. The content script stays — re-showing it is then free. */
export async function hidePanel() {
  await panel({ visible: false });
}
