// The one icon's surface: who exists, who is speaking, and a way in without a microphone.
//
// **It also owns the site-access grant**, which used to live on `chrome.action.onClicked`.
// Adding a `default_popup` stops that event firing at all — so the gesture Chrome requires for
// `permissions.request()` now comes from a button in here. That is a better place for it
// anyway: clicking the toolbar icon and having something invisible happen was never legible.

import { loadRoster, findAgent, micGranted } from './storage.js';
import { channelFor, initialFor } from './channels.js';
import { FLOOR_MS } from './routing.js';
import { patternForHost, matchPattern } from './domain.js';
import { MARK_SVG, MARK_CSS } from './mark.js';

const el = (id) => document.getElementById(id);

// The mark, from the one place it is defined. It is injected rather than written into
// `popup.html` so the popup and the orb cannot end up showing different logos — which is
// exactly what happened when each carried its own copy of the gradient tile.
//
// The style element carries the sizing that ships with the artwork; the placeholder in the HTML
// only reserves the space, so the header does not shift when this lands.
{
  const style = document.createElement('style');
  style.textContent = MARK_CSS;
  document.head.append(style);
  el('mark').innerHTML = MARK_SVG;
}

/**
 * Who currently holds the floor, so the popup lights the agent a follow-up would reach.
 *
 * **Expiry is checked here too, against the same constant the worker routes by.** A ring that
 * outlives the floor is not a cosmetic problem: it says a name-less question would go to Ivan
 * when it would actually be refused.
 */
async function activeAgentName() {
  const { floorHolder, floorAt = 0 } = await chrome.storage.session.get(['floorHolder', 'floorAt']);
  if (!floorHolder || Date.now() - floorAt > FLOOR_MS) return null;
  return floorHolder;
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
// **The popup does not show the turn — the orb does.** It used to, because E2 built the
// microphone before there was anywhere to put what it heard, and a readout here was the
// difference between that milestone being demonstrable and being a claim about the console.
// E4 made it a duplicate: two answer surfaces for one product, one of them a 320px panel that
// closes the moment you look away.
//
// So what is left here is the *control* — start a turn, stop a turn — and the one piece of
// state a button has to carry, which is whether it is currently a Stop.

function showState({ listening }) {
  const button = el('listen');
  button.textContent = listening ? 'Stop' : 'Listen';
  // Losing `.secondary` fills the button with the channel blue — the same "this is live now"
  // signal the badge shows on the toolbar, so the two surfaces agree.
  button.classList.toggle('secondary', !listening);
}

el('listen').addEventListener('click', () => {
  // Not awaited: the reply arrives as a broadcast state message like every other transition, so
  // waiting for this one would mean rendering the same thing twice by two different routes.
  chrome.runtime.sendMessage({ kind: 'openposse.listen.toggle' }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.kind === 'openposse.listen.state') showState(message);
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
  // suggest the answer is coming back *here*, and it is not — typing now goes through the same
  // door as speaking, so it lands on the orb over the page.
  window.close();
}

el('send').addEventListener('click', send);
el('prompt').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') send();
});

// ── Recording, and the gesture it needs ────────────────────────────────────────────────────

/**
 * The tab to record, read **when the popup opens** rather than when the button is clicked.
 *
 * This is the whole reason recording works. `permissions.request()` needs a user gesture, and a
 * gesture does not survive an `await` — so `chrome.tabs.query()` inside the click handler
 * spends it before the request is made, and Chrome refuses with "This function must be called
 * during a user gesture". It also does **not** transfer through `sendMessage`, so the service
 * worker cannot make the request on the popup's behalf either; that is why this lives here at
 * all, and why `chrome.action.onClicked` used to own it before `default_popup` silenced that
 * event.
 *
 * Reading the tab up front leaves the click handler free to call `permissions.request()` as its
 * very first statement, with nothing awaited in front of it.
 */
let recordable = null;

chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  const host = (() => {
    try { return new URL(tab?.url ?? '').hostname; } catch { return ''; }
  })();
  // Only https. A `chrome://` page, a local file or the Web Store can never be driven, and a
  // button that starts a flow which cannot finish is worse than one that is plainly disabled.
  if (!host || !tab?.url?.startsWith('https://')) {
    el('record').disabled = true;
    el('record').title = 'This page can’t be recorded';
    return;
  }
  recordable = { tabId: tab.id, pattern: patternForHost(host) };
});

el('record').addEventListener('click', async () => {
  if (!recordable) return;
  const { tabId, pattern } = recordable;

  // **First statement, nothing awaited before it.** See `recordable` above.
  const granted = await chrome.permissions.request({ origins: [matchPattern(pattern)] });
  if (!granted) {
    // Declining is an answer, not a failure — the popup simply stays put and says so.
    el('record').textContent = 'Site access is needed to record';
    return;
  }

  await chrome.runtime.sendMessage({ kind: 'openposse.record', tabId, pattern });
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

// The turn may already be running — the shortcut works with nothing on screen, so a popup opened
// afterwards has to catch up rather than assume it is starting from idle.
const catchUp = chrome.runtime
  .sendMessage({ kind: 'openposse.listen.query' })
  .then((state) => showState(state ?? { listening: false }))
  .catch(() => showState({ listening: false }));

await Promise.all([render(), checkMic(), catchUp]);
