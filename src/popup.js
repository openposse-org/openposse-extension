// The one icon's surface: who exists, who is speaking, and a way in without a microphone.
//
// **It also owns the site-access grant**, which used to live on `chrome.action.onClicked`.
// Adding a `default_popup` stops that event firing at all — so the gesture Chrome requires for
// `permissions.request()` now comes from a button in here. That is a better place for it
// anyway: clicking the toolbar icon and having something invisible happen was never legible.

import { loadRoster, findAgent } from './storage.js';
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
 * `prompt` means it was never asked for, and the fix is one click on the setup page.
 * `denied` means Chrome is refusing, and no amount of clicking here will change that — only
 * the site settings will. Telling someone to "check input" in either case, which is what the
 * design's dead-mic badge says, sends them to look for a fault in hardware that is fine.
 *
 * That badge is still right for its own case — a microphone that is connected and producing
 * silence — and belongs in the panel's not-capturing state at E4, not here.
 */
async function checkMic() {
  const warning = el('mic-warning');
  let state;
  try {
    state = (await navigator.permissions.query({ name: 'microphone' })).state;
  } catch {
    // Cannot tell. Say nothing rather than cry wolf — an older Chrome without the query is
    // not a broken microphone. (This is what the previous version claimed to do and did not:
    // it left `state` at its default and showed the warning anyway.)
    warning.hidden = true;
    return;
  }

  warning.hidden = state === 'granted';
  warning.textContent = state === 'denied'
    ? 'Microphone blocked by Chrome — allow it in site settings, then reopen this.'
    : "Microphone isn't set up yet — click to finish setup.";
}

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

await Promise.all([render(), checkMic()]);
