// One surface: everything the popup carried and everything the orb showed, in a panel that does
// not close when you look away.
//
// **What this replaces, and why both halves had to move.** The popup owned the roster, the mic
// warning, the typed fallback and the site grant; it closes on focus loss, and a turn runs ~12 s,
// so its UI disappeared mid-answer. The orb owned the six turn states; it is injected into the
// page, so on a new tab, an ungranted site, `chrome://` anything, the Web Store or a PDF there
// **is** no orb and no way to grant from nothing. Neither was complete and the seam was visible.
//
// Three things here are genuinely different from the two surfaces they came from, rather than
// transcribed:
//
// - **`permissions.request()` works from here**, proven on 2026-10-01 by Chrome's own dialog
//   rather than by reading. That is the whole load-bearing question of E14 – a content script
//   cannot do it (the API is absent there, and routing a click through `sendMessage` yields a
//   *restricted* gesture Chrome refuses), so the orb could never have owned the grant flow.
// - **The site line exists at all.** A popup that closes cannot tell you an hour later that the
//   site it is looking at is no longer granted; a panel that stays open can, and that is exactly
//   the diagnostic that was missing when a Chrome Site-access change silently killed an agent.
// - **Nothing fades out.** The orb's dismiss timer exists because it sits over somebody else's
//   application and has to get out of the way. A panel is the user's own column – it stays, and
//   the stage clears back to idle instead.
//
// The layout assumes no width and no side: Chrome does not persist the panel's width, offers no
// API to set it, reopens at roughly 360px, and lets the user put it left or right.

import { loadRoster, findAgent, micGranted } from './storage.js';
import { channelFor, initialFor } from './channels.js';
import { FLOOR_MS } from './routing.js';
import { patternForHost, matchPattern } from './domain.js';
import { MARK_SVG, MARK_CSS } from './mark.js';
import { SURFACES, setSurface } from './surface.js';
import { drawSphere, modeFor } from './sphere.js';

const el = (id) => document.getElementById(id);

// **A panel that throws while loading is indistinguishable from one that does nothing.** The
// markup renders either way – the buttons are in the HTML – but if this module dies before it
// reaches `addEventListener`, every one of them is inert and the only record is a console nobody
// has open. Registered first, before anything that can throw. Same guard the popup carries, and
// it earns its place twice over here: this surface is now the *only* one.
const fatal = (what) => {
  const strip = document.createElement('div');
  strip.className = 'card bad';
  strip.textContent = `OpenPosse failed to start – ${what}`;
  document.body.prepend(strip);
};
window.addEventListener('error', (event) => fatal(event.message ?? String(event.error)));
window.addEventListener('unhandledrejection', (e) => fatal(e.reason?.message ?? String(e.reason)));

// The mark, from the one place it is defined, so no two surfaces can show different logos.
{
  const style = document.createElement('style');
  style.textContent = MARK_CSS;
  document.head.append(style);
  el('mark').innerHTML = MARK_SVG;
}

// ── The turn ───────────────────────────────────────────────────────────────────────────────

/**
 * The turn, merged from the patches `panel()` sends.
 *
 * Deliberately a second copy of the orb's state rather than a shared model: E14's corollary says
 * not to build one state model feeding two renderers, because that is the right architecture for
 * two permanent surfaces and the wrong one for a fallback with a scheduled death. When testing
 * picks a surface, one of these two files is deleted whole.
 */
let state = {
  phase: 'idle', agentName: null, channel: null,
  transcript: '', volatile: '', answer: '', sub: '', message: '', shortcut: '',
};

/** The microphone level, and whether there is a meter at all. `null` is *no meter*, not silence. */
let level = null;
let eased = 0;

// **There is no `speaking` flag here, unlike the orb, and the absence is the point.** The orb
// tracks it to hold off a dismiss timer that would otherwise fade the panel out mid-sentence.
// Nothing fades here, so there is nothing to hold off – and a flag kept for symmetry, read by
// nothing, is the kind of thing that later reads as a feature somebody forgot to finish.

let t = 0;

function tick() {
  t += 1;
  // Eased here rather than smoothed harder at the source: the meter already carries the design's
  // 80 ms attack and 250 ms release, and this only bridges 20 Hz of messages to 60 Hz of frames.
  if (level !== null) eased += (level - eased) * 0.25;
  drawSphere(el('orb'), {
    t,
    mode: modeFor(state.phase),
    tint: state.channel ?? 'none',
    level: level === null ? null : eased,
  });
  requestAnimationFrame(tick);
}

const STATUS = {
  listening: () => ({ text: 'Listening' }),
  routing: () => ({ text: "Working out who that's for…", pulse: true }),
  thinking: (s) => ({ text: `${s.agentName} is thinking…`, pulse: true, tinted: true }),
  answering: (s) => ({ text: `${s.agentName} answered`, tinted: true }),
  'needs-attention': () => ({ text: 'Needs attention', bad: true }),
  'not-capturing': () => ({ text: 'No input', bad: true }),
  idle: () => ({ text: '' }),
};

function renderTurn() {
  // **Recording takes the whole panel**, because it is a different activity rather than a
  // different turn state: there is no transcript, no roster to re-route to, and the person is
  // standing in a vendor's page being told what to click. The desk goes too – offering "Ask" and
  // "Record this tab" in the middle of a recording is offering to start a second one.
  const recording = state.phase === 'recording';
  el('stage').hidden = recording;
  el('desk').hidden = recording;
  el('coach').hidden = !recording;
  if (recording) return renderCoach();

  // Committed white, the tail the recogniser is still revising dimmed, and a caret only while
  // actually listening.
  const tr = el('transcript');
  tr.textContent = '';
  if (state.transcript) tr.append(document.createTextNode(state.transcript));
  if (state.volatile) {
    const v = document.createElement('span');
    v.className = 'volatile';
    v.textContent = state.volatile;
    tr.append(v);
  }
  if (state.phase === 'listening') {
    const caret = document.createElement('span');
    caret.className = 'caret';
    tr.append(caret);
  }

  const look = (STATUS[state.phase] ?? STATUS.idle)(state);
  const status = el('status');
  status.className = `status${look.tinted ? ' tinted' : ''}${look.bad ? ' bad' : ''}`;
  if (state.channel) status.style.setProperty('--channel', state.channel);
  status.textContent = '';
  if (look.pulse) {
    const dot = document.createElement('div');
    dot.className = 'pulse';
    status.append(dot);
  }
  const words = state.message || look.text;
  if (words) status.append(document.createTextNode(words));

  el('deadmic').hidden = state.phase !== 'not-capturing';

  const answer = el('answer');
  answer.textContent = '';
  if (state.answer) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = state.answer;
    answer.append(bubble);
    if (state.sub) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = state.sub;
      answer.append(sub);
    }
  }
}

/**
 * The wizard, drawn from what `coaching.js` decided.
 *
 * Nothing here judges anything – the step, the sentence and the tick-list all arrive in the
 * patch. Same split as the orb and the Mac side before it, and the reason it is worth keeping is
 * that the rules are testable without a window and this is not.
 */
function renderCoach() {
  const coach = state.coach ?? {};

  el('coach-step').textContent = coach.label ?? '';

  const say = el('coach-say');
  say.textContent = coach.instruction ?? '';
  say.classList.toggle('bad', coach.bad === true);

  // **Every capture stays on screen once it is made.** Confirmation is the whole reason the list
  // exists: somebody who cannot see that their shortcut registered will press it again, and on a
  // toggle the second press closes the assistant and records the wrong thing.
  const list = el('coach-list');
  list.textContent = '';
  for (const row of coach.captures ?? []) {
    const line = document.createElement('div');
    line.className = 'row';

    const tick = document.createElement('span');
    // A dash rather than a tick for something optional that was not found: a red cross would say
    // a recording had failed when it has not, and a green tick would claim something we do not
    // have.
    tick.className = row.absent ? 'tick none' : 'tick';
    tick.textContent = row.absent ? '–' : '✓';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = row.label;

    const detail = document.createElement('span');
    detail.className = `detail${row.isKeys ? ' keys' : ''}${row.absent ? ' none' : ''}`;
    detail.textContent = row.detail;

    line.append(tick, label, detail);
    if (row.kind) {
      const kind = document.createElement('span');
      kind.className = 'kind';
      kind.textContent = row.kind;
      line.append(kind);
    }
    list.append(line);
  }
}

// ── The roster ─────────────────────────────────────────────────────────────────────────────

/** Whom the text box is currently aimed at. Survives re-renders; the roster does not own it. */
let aimedAt = null;

/**
 * Who currently holds the floor, so the panel lights the agent a follow-up would reach.
 *
 * **Expiry is checked here too, against the same constant the worker routes by.** A ring that
 * outlives the floor is not cosmetic: it says a name-less question would go to Ivan when it would
 * actually be refused.
 */
async function floorHolderName() {
  const { floorHolder, floorAt = 0 } = await chrome.storage.session.get(['floorHolder', 'floorAt']);
  if (!floorHolder || Date.now() - floorAt > FLOOR_MS) return null;
  return floorHolder;
}

async function renderRoster() {
  const { agents, broken, problem } = await loadRoster();
  // Mid-turn the patch is authoritative and arrives ahead of session storage; between turns
  // storage is the only source. Reading both in that order keeps the lit ring honest either way.
  const active = state.agentName ?? await floorHolderName();
  const target = el('agents');
  target.textContent = '';

  // **`problem` is shown, and it never has been on any surface.** `loadRoster` returns a whole
  // sentence when storage is unreadable – "Your saved assistants couldn't be read." – and both
  // the popup and the orb destructured past it, so that failure and a genuinely empty roster
  // rendered as the same screen: an invitation to record your first assistant, offered to
  // somebody who already has five. A reason that exists and is not shown is a bug.
  const empty = el('empty');
  empty.hidden = agents.length > 0;
  empty.classList.toggle('problem', Boolean(problem));
  if (agents.length === 0) {
    empty.textContent = problem
      ?? 'No assistants yet. Open a page with an AI assistant on it, then record it.';
  }

  // **Re-asking is offered only when there is something to re-ask.** The orb turns every avatar
  // into a re-route button because an answer is the only thing it ever shows. Here a row is
  // usually just a target for the text box – so the row says, in words on the row itself, which
  // of the two a click is about to do. An invisible mode switch on a click is the thing this
  // codebase keeps banning.
  const canReroute = Boolean(state.answer) && state.phase !== 'listening';

  for (const agent of agents) {
    const holdsFloor = agent.name === active;
    const row = document.createElement('div');
    // Dimming everyone but the floor holder is the design's own rule. With nobody holding it all
    // are lit – "no active agent" must not read as "every agent is broken".
    const lit = !active || holdsFloor;
    row.className = `agent${lit ? ' active' : ''}${agent.name === aimedAt ? ' aimed' : ''}`;
    row.style.setProperty('--channel', channelFor(agent.name));

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = initialFor(agent.name);

    const text = document.createElement('div');
    text.className = 'text';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = agent.name;
    const kind = document.createElement('div');
    const reroutes = canReroute && !holdsFloor;
    kind.className = broken.includes(agent.id) ? 'kind bad' : 'kind';
    kind.textContent = broken.includes(agent.id) ? 'needs re-recording'
      : reroutes ? 'ask this one instead'
        : holdsFloor ? 'has the floor'
          : 'Via browser';

    text.append(name, kind);
    row.append(avatar, text);

    row.title = reroutes ? `Put the same question to ${agent.name}` : `Ask ${agent.name}`;
    row.addEventListener('click', () => {
      if (reroutes) {
        // Straight to the worker, which re-asks the remembered prompt. The agent was *clicked*,
        // so re-deriving them from a sentence would throw away the one unambiguous signal there
        // is – which is exactly why the worker's handler skips routing too.
        chrome.runtime.sendMessage({ kind: 'openposse.orb.reroute', agentName: agent.name })
          .catch(() => {});
        return;
      }
      aim(agent.name);
      el('prompt').focus();
    });

    target.append(row);
  }

  if (agents.length > 0 && !findAgent(agents, aimedAt ?? '')) aim(active ?? agents[0].name);
}

function aim(name) {
  aimedAt = name;
  el('prompt').placeholder = `Ask ${name} to…`;
  el('prompt').dataset.agent = name;
  for (const row of el('agents').children) {
    row.classList.toggle('aimed', row.querySelector('.name')?.textContent === name);
  }
}

// ── The microphone warning ─────────────────────────────────────────────────────────────────

/**
 * Says which microphone problem this is, because they need different actions.
 *
 * **Reads what setup recorded, not what `permissions.query` predicts.** The first version asked
 * the API and showed "not granted" on a microphone that had been granted minutes earlier and
 * worked – because `prompt` is that API's default *and* its fallback. `denied` is still read
 * directly: it is the one state the API is unambiguous about, and the one nothing here can fix.
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
    ? 'Microphone blocked by Chrome – allow it in this extension’s site settings.'
    : "Microphone isn't set up yet – click to finish setup.";
}

el('mic-warning').addEventListener('click', () => chrome.runtime.openOptionsPage());

// ── Listening ──────────────────────────────────────────────────────────────────────────────

function showListening({ listening }) {
  const button = el('listen');
  button.textContent = listening ? 'Stop' : 'Listen';
  // Losing `.secondary` fills the button with the channel blue – the same "this is live now"
  // signal the badge shows on the toolbar, so the two surfaces agree.
  button.classList.toggle('secondary', !listening);
}

el('listen').addEventListener('click', () => {
  // Not awaited: the reply arrives as a broadcast state message like every other transition, so
  // waiting for this one would mean rendering the same thing twice by two different routes.
  chrome.runtime.sendMessage({ kind: 'openposse.listen.toggle' }).catch(() => {});
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
  // **No `window.close()` here, and that is the point of the milestone.** The popup closed
  // because leaving it open would have suggested the answer was coming back to it, and it was
  // not – the answer went to the orb. It comes back *here* now.
  await chrome.runtime.sendMessage({ kind: 'openposse.ask', agentName: agent.name, prompt });
}

el('send').addEventListener('click', send);
el('prompt').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') send();
});

// ── Site access, and the gesture it needs ──────────────────────────────────────────────────

/**
 * The tab in front, kept current rather than read once.
 *
 * **This is the whole reason the grant and the recorder work.** `permissions.request()` needs a
 * user gesture, a gesture does not survive an `await`, and it does **not** transfer through
 * `sendMessage` – so a `chrome.tabs.query()` inside the click handler spends the gesture before
 * the request is made and Chrome refuses with "This function must be called during a user
 * gesture". The popup dodged that by reading the tab when it opened, because it lived for
 * seconds. A panel lives for hours and the tab underneath changes, so it is re-read on every tab
 * event instead, leaving both click handlers free to call `request()` as their first statement.
 */
let site = { tabId: null, host: null, pattern: null, covered: false, why: 'reading…' };

// Whether a granted origin is a wildcard over every host.
//
// Line comments, deliberately: writing that pattern out inside a slash-star block ends the
// comment at its own star-slash and the rest parses as code – which is how this was found, via
// "Unexpected token *" three lines further down. Same shape as the backtick-in-a-template trap
// in extension/CLAUDE.md, a sequence inside a comment that terminates its container.
const isBroad = (origin) => origin === '<all_urls>' || /^(\*|https?):\/\/\*\//.test(origin);

async function paintSite() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const host = (() => {
      try { return new URL(tab?.url ?? '').hostname; } catch { return ''; }
    })();

    // Only https. A `chrome://` page, a local file, a PDF or the Web Store can never be driven by
    // any extension – and this panel is *rendering on one of them*, which is the case that is
    // structurally impossible with the orb and the reason the milestone exists.
    if (!host || !tab?.url?.startsWith('https://')) {
      site = { tabId: null, host: null, pattern: null, covered: false, why: 'This page can’t be driven or recorded.' };
    } else {
      const pattern = patternForHost(host);
      // **Coverage is the right question here**, unlike in the spike's own diagnostics: what the
      // panel is reporting is whether this tab can be driven, and a broader grant covers it. The
      // trap `contains()` sets is only for asking whether *this* origin was granted, which is a
      // question nothing on this surface needs to ask.
      const covered = await chrome.permissions.contains({ origins: [matchPattern(pattern)] });
      site = { tabId: tab.id, host, pattern, covered, why: null };
    }
  } catch (error) {
    // **Named, not swallowed.** `tabs.query` can reject and `patternForHost` runs on its result,
    // and the popup shipped this without a catch once: the Record button stayed enabled and
    // inert, pressing it did nothing, logged nothing, and was indistinguishable from a broken
    // extension. Whatever went wrong, the button must stop looking pressable and say why.
    const why = error?.message ?? String(error);
    console.warn('[openposse] could not read the tab in front –', why);
    site = { tabId: null, host: null, pattern: null, covered: false, why: `Can’t read this tab – ${why}` };
  }

  const line = el('site-state');
  const grant = el('grant');

  if (!site.pattern) {
    line.textContent = site.why;
    grant.hidden = true;
  } else if (site.covered) {
    line.textContent = `${site.pattern} — access granted`;
    grant.hidden = true;
  } else {
    line.textContent = `${site.pattern} — no access yet`;
    grant.textContent = `Grant access to ${site.pattern}`;
    grant.hidden = false;
  }

  // **Said out loud, because it was not and that cost an hour.** Chrome's own Site access menu
  // offers "On all sites" in one click, and nothing in this extension asks for it or mentions it
  // afterwards – so every site reads as granted, for a reason the product never stated. It is
  // also the exact trap that made two earlier tests of the grant flow prove nothing.
  const { origins = [] } = await chrome.permissions.getAll().catch(() => ({ origins: [] }));
  const broad = origins.filter(isBroad);
  if (broad.length) {
    line.textContent += `\n${broad.join(', ')} is granted, which covers every site. `
      + 'Chrome › Extensions › OpenPosse › Details › Site access is where that is set.';
    line.style.whiteSpace = 'pre-line';
  } else {
    line.style.whiteSpace = '';
  }

  el('record').disabled = !site.pattern;
  el('record').title = site.pattern ? `Record the assistant on ${site.host}` : site.why;
}

// **First statement, nothing awaited before it.** See `site` above.
el('grant').addEventListener('click', () => {
  if (!site.pattern) return;
  chrome.permissions.request({ origins: [matchPattern(site.pattern)] })
    .then(paintSite, (error) => {
      el('site-state').textContent = `Chrome refused the request – ${error?.message ?? error}`;
    });
});

el('record').addEventListener('click', async () => {
  if (!site.pattern) {
    el('record').textContent = site.why;
    console.warn('[openposse] record pressed with no recordable tab –', site.why);
    return;
  }
  const { tabId, pattern } = site;

  // First statement, nothing awaited before it.
  const granted = await chrome.permissions.request({ origins: [matchPattern(pattern)] });
  if (!granted) {
    // Declining is an answer, not a failure – the panel stays put and says so.
    el('record').textContent = 'Site access is needed to record';
    return;
  }

  await chrome.runtime.sendMessage({ kind: 'openposse.record', tabId, pattern });
});

el('settings').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

// ── The surface switch ─────────────────────────────────────────────────────────────────────

/**
 * E14's switch, and it is temporary by decision: when user testing picks a surface, the other is
 * deleted along with everything that exists to defend it. A fallback with no expiry becomes
 * permanent dead weight, and here it is load-bearing dead weight.
 */
async function paintSurface() {
  const { surface } = await chrome.storage.local.get('surface');
  const onPanel = SURFACES.includes(surface) ? surface === 'panel' : false;
  el('surface').textContent = onPanel
    ? 'Showing turns here · switch to the floating orb'
    : 'Showing turns on the floating orb · switch to here';
}

el('surface').addEventListener('click', async () => {
  const { surface } = await chrome.storage.local.get('surface');
  await setSurface(surface === 'panel' ? 'orb' : 'panel');
  await paintSurface();
});

// ── What arrives from the worker ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  // Its own branch, before the state merge and returning early: this arrives twenty times a
  // second, and letting it fall through to `renderTurn()` would rebuild the status line and the
  // answer bubble each time, to move a sphere's radius.
  if (message?.kind === 'openposse.orb.level') {
    level = message.level;
    return false;
  }
  if (message?.kind === 'openposse.listen.state') {
    showListening(message);
    return false;
  }
  if (message?.kind !== 'openposse.orb') return false;

  const patch = message.state ?? {};

  // **`visible` is ignored here, and that is the milestone rather than an oversight.** It means
  // "take the orb off the screen", and the orb needs it for two reasons a panel does not have:
  // it fades out after an idle beat because it sits over somebody else's application, and
  // `hidePanel()` strips it from a tab the user is about to be navigated away from. A panel is
  // the user's own column and belongs to no tab, so there is nothing to take away.
  //
  // What falls out is the thing the popup could never do: **the last answer stays on screen.**
  // Clearing it after a turn would reproduce the popup's whole failure inside a surface built to
  // fix it. The next turn's opening patch resets every field explicitly, so nothing accumulates.
  const before = { phase: state.phase, answer: state.answer, agentName: state.agentName };
  state = { ...state, ...patch };

  // A new turn starts from silence. Without this the orb opens at whatever the last one ended on,
  // which reads as it hearing something before anyone has spoken.
  if (patch.phase === 'listening') { level = null; eased = 0; }

  if (patch.shortcut !== undefined) el('shortcut').textContent = patch.shortcut || 'no shortcut set';

  renderTurn();
  // The roster's lit ring and its re-ask offer both depend on the turn, so it re-renders with it.
  // **Compared rather than triggered off the patch's own keys**, because the clearing case has
  // no key to watch: a turn that ends leaves rows still offering to re-ask a question whose
  // answer is gone. Skipping the unchanged case keeps this off the twice-a-second interim path.
  if (before.phase !== state.phase || before.answer !== state.answer
    || before.agentName !== state.agentName || patch.agents !== undefined) {
    renderRoster();
  }
  return false;
});

// ── Staying current, which a popup never had to do ─────────────────────────────────────────
//
// All three of these exist because this surface outlives the things it is describing. The popup
// read everything once, at open, and was gone before any of it could change.

chrome.tabs.onActivated.addListener(paintSite);
chrome.tabs.onUpdated.addListener((_id, change) => { if (change.url) paintSite(); });
chrome.windows?.onFocusChanged?.addListener(paintSite);

// A grant made from Settings, from the recorder, or revoked in Chrome's own Site access menu –
// which is precisely how an agent can go dead with nothing on screen to say why.
chrome.permissions.onAdded.addListener(paintSite);
chrome.permissions.onRemoved.addListener(paintSite);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.agents) renderRoster();
  if (area === 'local' && changes.surface) paintSurface();
  if (area === 'local' && changes.micGranted) checkMic();
});

// ── Start ──────────────────────────────────────────────────────────────────────────────────

// **An unbound command is a state, not an absence.** Chrome drops a user-assigned shortcut when
// an unpacked extension is removed and re-added, and `getAll` then returns the command with an
// empty `shortcut`. Rendering that as blank space meant the one surface that knows the binding
// showed nothing, and "⌥V stopped working" had no visible cause anywhere in the product.
chrome.commands.getAll().then((commands) => {
  const summon = commands.find((c) => c.name === 'summon');
  el('shortcut').textContent = summon?.shortcut || 'no shortcut set';
  if (!summon?.shortcut) {
    el('shortcut').title = 'Set one in Settings, or at chrome://extensions/shortcuts';
    console.warn('[openposse] no shortcut is bound to the summon command');
  }
}).catch((error) => {
  console.warn('[openposse] could not read the shortcut –', error?.message ?? error);
});

// The panel is opened *by* the shortcut that starts a turn, so it is always catching up on a
// turn already in flight rather than starting from idle.
chrome.runtime
  .sendMessage({ kind: 'openposse.listen.query' })
  .then((answer) => {
    showListening(answer ?? { listening: false });
    if (answer?.listening) state = { ...state, phase: 'listening' };
    // What was heard before this document existed. `turn` is the last result the recogniser
    // committed or is still revising; without it the panel opens blank halfway through a
    // sentence somebody is in the middle of saying.
    if (answer?.turn?.text) {
      state = answer.turn.isFinal
        ? { ...state, transcript: answer.turn.text, volatile: '' }
        : { ...state, transcript: '', volatile: answer.turn.text };
    }
    if (answer?.failure?.message) {
      state = { ...state, phase: 'needs-attention', message: answer.failure.message };
    }
    renderTurn();
  })
  .catch(() => showListening({ listening: false }));

renderTurn();
renderRoster();
checkMic();
paintSite();
paintSurface();
requestAnimationFrame(tick);
