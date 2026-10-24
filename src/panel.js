// Keeping the side panel told.
//
// The side panel is the only surface. Until 2026-10-24 this file also injected a floating orb
// into the page in front, per turn, on the `activeTab` grant a keypress made; that surface was
// retired and this is what is left of the file: one state channel and one level channel.

import { loadRoster } from './storage.js';
import { channelOf, initialFor } from './channels.js';

/**
 * Sends state to the side panel.
 *
 * **The panel cannot be summoned from here, and that is a real limit rather than an omission.**
 * `chrome.sidePanel.open()` needs a live user gesture, and by the time a turn is producing state
 * every gesture is long spent – so the panel is opened by the shortcut handler or by the toolbar
 * icon, and this only ever talks to one that is already open. When it is not, the state is
 * dropped: the next press has a gesture and will open it.
 */
async function toSidePanel(patch) {
  try {
    await chrome.runtime.sendMessage({ kind: 'openposse.orb', state: patch });
  } catch (error) {
    console.warn('[openposse] side panel not open –', error?.message ?? error);
  }
}

/** The roster as the panel draws it: a name, a letter and a colour. Never a lasso. */
async function rosterForPanel() {
  const { agents } = await loadRoster();
  return agents.map((agent) => ({
    name: agent.name,
    initial: initialFor(agent.name),
    channel: channelOf(agent),
  }));
}

/**
 * Pushes state to the panel, with the roster and the shortcut if this is the start of a turn.
 *
 * Every field is optional and merged, so a caller says only what changed – an interim
 * transcript does not have to restate the roster, and a phase change does not clear the text.
 */
export async function panel(patch, { create = false } = {}) {
  if (create) {
    const shortcut = (await chrome.commands.getAll()).find((c) => c.name === 'summon')?.shortcut;
    patch = { agents: await rosterForPanel(), shortcut: shortcut ?? '', ...patch };
  }
  return toSidePanel(patch);
}

/**
 * The microphone level, on its own channel.
 *
 * **Deliberately not routed through `panel()`.** That merges into the panel's state and
 * re-renders the status line and the answer on every one – twenty times a second, to move a
 * sphere's radius. This is a number the renderer eases toward between frames and nothing else
 * reads, so it gets its own message and touches no state. Broadcast rather than targeted,
 * because a side panel has no tab id.
 */
export function panelLevel(value) {
  chrome.runtime.sendMessage({ kind: 'openposse.orb.level', level: value }).catch(() => {});
}
