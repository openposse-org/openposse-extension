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

async function inject() {
  // `lastFocusedWindow`, not `currentWindow`: the shortcut is global, so Chrome is often not
  // the focused application at all and `currentWindow` would be undefined.
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return null;
  try {
    // Idempotent by a guard inside `orb.js`, so re-injecting after a navigation rebuilds the
    // panel and re-injecting into a live one does nothing.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['dist/orb.js'] });
    panelTabId = tab.id;
    return tab.id;
  } catch {
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
    const shortcut = (await chrome.commands.getAll()).find((c) => c.name === 'summon')?.shortcut;
    await inject();
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

/** Fades the panel out. The content script stays — re-showing it is then free. */
export async function hidePanel() {
  await panel({ visible: false });
}
