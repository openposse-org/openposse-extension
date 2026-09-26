// The one icon's surface: who exists, who is speaking, and a way in without a microphone.
//
// **It also owns the site-access grant**, which used to live on `chrome.action.onClicked`.
// Adding a `default_popup` stops that event firing at all — so the gesture Chrome requires for
// `permissions.request()` now comes from a button in here. That is a better place for it
// anyway: clicking the toolbar icon and having something invisible happen was never legible.

import { loadRoster, findAgent, micGranted } from './storage.js';
import { channelFor, initialFor } from './channels.js';

const el = (id) => document.getElementById(id);

/** Who currently holds the floor, so the popup lights the same agent the panel does. */
async function activeAgentName() {
  const { floorHolder } = await chrome.storage.session.get('floorHolder');
  return floorHolder ?? null;
}

// ── Roster ─────────────────────────────────────────────────────────────────────────────────

async function render() {
  const { agents, broken } = await loadRoster();
  const active = await activeAgentName();
  const target = el('agents');
  target.textContent = '';

  el('empty').hidden = agents.length > 0;

  for (const agent of agents) {
    const row = document.createElement('div');
    // Dimming everyone but the floor holder is the design's own rule. With nobody holding it,
    // all are lit — "no active agent" must not read as "every agent is broken".
    const isActive = !active || agent.name === active;
    row.className = `agent${isActive ? ' active' : ''}`;
    row.style.setProperty('--channel', channelFor(agent.name));

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = initialFor(agent.name);

    const text = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = agent.name;
    const kind = document.createElement('div');
    kind.className = 'kind';
    kind.textContent = broken.includes(agent.id)
      ? 'needs re-recording'
      : (agent.name === active ? 'has the floor' : 'Via browser');

    text.append(name, kind);
    row.append(avatar, text);

    // Clicking an agent addresses it, so the text box does not have to carry the name.
    row.addEventListener('click', () => {
      el('prompt').placeholder = `Ask ${agent.name} to…`;
      el('prompt').dataset.agent = agent.name;
      el('prompt').focus();
    });

    target.append(row);
  }

  if (agents.length > 0) {
    const first = active ?? agents[0].name;
    el('prompt').placeholder = `Ask ${first} to…`;
    el('prompt').dataset.agent = first;
  }
}

// ── The microphone warning ─────────────────────────────────────────────────────────────────

/**
 * Says which microphone problem this is, because they need different actions.
 *
 * **Reads what setup recorded, not what `permissions.query` predicts.** The first version
 * asked the API and showed "not granted" on a microphone that had been granted minutes
 * earlier and worked — because `prompt` is that API's default *and* its fallback, and it
 * answers `prompt` from a popup even when the grant is live. See `storage.js`.
 *
 * `denied` is still read directly: it is the one state the API is unambiguous about, and the
 * one nothing here can fix.
 *
 * Deliberately not the design's `NOT HEARING ANYTHING — CHECK INPUT`. That badge is for a
 * microphone that is connected and silent, and belongs in the panel's not-capturing state at
 * E4 — telling someone to check their input device when they simply have not finished setup
 * sends them looking for a fault that is not there.
 */
async function checkMic() {
  const warning = el('mic-warning');
  if (await micGranted()) {
    warning.hidden = true;
    return;
  }

  let denied = false;
  try {
    denied = (await navigator.permissions.query({ name: 'microphone' })).state === 'denied';
  } catch { /* cannot tell; the setup message below is the safe thing to say either way */ }

  warning.hidden = false;
  warning.textContent = denied
    ? 'Microphone blocked by Chrome — allow it in this extension’s site settings.'
    : "Microphone isn't set up yet — click to finish setup.";
}

// ── Listening ──────────────────────────────────────────────────────────────────────────────
//
// Two sources, deliberately. Interim results come **straight from the offscreen document**,
// because `runtime.sendMessage` reaches every extension context at once and routing them
// through the worker would add a round trip to text that updates several times a second. State
// — are we listening, and what went wrong — comes from the worker, which is the only thing that
// knows it across a popup that opens and closes mid-turn.

/** Renders the turn. Interim text is dimmed and final text is not, so finality is visible. */
function showHeard(text, isFinal) {
  const out = el('heard');
  out.className = `heard${isFinal ? ' final' : ''}`;
  out.textContent = text;
}

function showState({ listening, turn, failure }) {
  const button = el('listen');
  button.textContent = listening ? 'Stop' : 'Listen';
  // Losing `.secondary` fills the button with the channel blue — the same "this is live now"
  // signal the badge shows on the toolbar, so the two surfaces agree.
  button.classList.toggle('secondary', !listening);

  if (failure) {
    el('heard').className = 'heard bad';
    el('heard').textContent = failure.message;
    return;
  }
  if (turn?.text) {
    showHeard(turn.text, turn.isFinal);
    return;
  }
  showHeard(listening ? 'Listening…' : '', false);
}

el('listen').addEventListener('click', () => {
  // Not awaited: the reply arrives as a broadcast state message like every other transition, so
  // waiting for this one would mean rendering the same thing twice by two different routes.
  chrome.runtime.sendMessage({ kind: 'openposse.listen.toggle' }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.kind === 'openposse.heard') showHeard(message.text, message.isFinal);
  else if (message?.kind === 'openposse.listen.state') showState(message);
  return false;
});

// ── Asking without speaking ────────────────────────────────────────────────────────────────

async function send() {
  const input = el('prompt');
  const prompt = input.value.trim();
  if (!prompt) return;

  const { agents } = await loadRoster();
  const agent = findAgent(agents, input.dataset.agent ?? '') ?? agents[0];
  if (!agent) return;

  input.value = '';
  await chrome.runtime.sendMessage({
    kind: 'openposse.ask', agentName: agent.name, prompt,
  });
  // Closing is the honest signal that it has been handed off. Leaving the popup open would
  // suggest the answer is coming back *here*, and it is not — it appears in the vendor's tab.
  window.close();
}

el('send').addEventListener('click', send);
el('prompt').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') send();
});

// ── Recording, and the gesture it needs ────────────────────────────────────────────────────

el('record').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  // Sent, not awaited-then-acted-on: the permission request must run while this click is
  // still the browser's idea of a user gesture, and a round trip would spend it.
  await chrome.runtime.sendMessage({ kind: 'openposse.record', tabId: tab.id });
  window.close();
});

el('settings').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

// The warning is the only route to the fix, so it has to be the button that gets you there.
el('mic-warning').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

// ── Start ──────────────────────────────────────────────────────────────────────────────────

chrome.commands.getAll().then((commands) => {
  const summon = commands.find((c) => c.name === 'summon');
  if (summon?.shortcut) el('shortcut').textContent = summon.shortcut;
});

// The turn may already be running — ⇧⌘9 works with nothing on screen, so a popup opened
// afterwards has to catch up rather than assume it is starting from idle.
const catchUp = chrome.runtime
  .sendMessage({ kind: 'openposse.listen.query' })
  .then((state) => showState(state ?? { listening: false }))
  .catch(() => showState({ listening: false }));

await Promise.all([render(), checkMic(), catchUp]);
