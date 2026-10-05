// One surface: everything the popup carried and everything the orb showed, in a panel that does
// not close when you look away.
//
// **What this replaces, and why both halves had to move.** The popup owned the roster, the mic
// warning, the typed fallback and the site grant; it closes on focus loss, and a turn runs ~12 s,
// so its UI disappeared mid-answer. The orb owned the six turn states; it is injected into the
// page, so on a new tab, an ungranted site, `chrome://` anything, the Web Store or a PDF there
// **is** no orb and no way to grant from nothing. Neither was complete and the seam was visible.
//
// Three things here are genuinely different from the two surfaces they came from:
//
// - **`permissions.request()` works from here**, proven on 2026-10-01 by Chrome's own dialog
//   rather than by reading. A content script cannot do it (the API is absent there, and routing
//   a click through `sendMessage` yields a *restricted* gesture Chrome refuses), so the orb could
//   never have owned the grant flow.
// - **The site line exists at all.** A popup that closes cannot tell you an hour later that the
//   site it is looking at is no longer granted; a panel that stays open can, and that is exactly
//   the diagnostic that was missing when a Chrome Site-access change silently killed an agent.
// - **Nothing fades out.** The orb's dismiss timer exists because it sits over somebody else's
//   application and has to get out of the way. A panel is the user's own column – it stays, and
//   the last answer stays with it until the next turn.
//
// The layout is the orb's own, rebuilt to the mockup of 2026-10-01: avatars rather than rows, a
// status line naming who the turn is with in their own colour, an answer in a bubble carrying its
// source. It assumes no width and no side – Chrome does not persist the panel's width, offers no
// API to set it, reopens at roughly 360px, and lets the user put it left or right.

import { loadRoster, findAgent, micGranted, recipeFor } from './storage.js';
import { channelOf, initialFor } from './channels.js';
import { FLOOR_MS, FLOOR_OVERRIDE_KEY, FLOOR_RANGE, floorWindow, productLabel } from './routing.js';
import { patternForHost, matchPattern } from './domain.js';
import { SURFACES, setSurface } from './surface.js';
import { drawSphere, modeFor } from './sphere.js';
import { ANSWER_GRACE_MS, GRACE_OVERRIDE_KEY, GRACE_RANGE, graceWindow } from './grace.js';
import { icon } from './icons.js';

const el = (id) => document.getElementById(id);

/** Puts one icon in a button, replacing whatever it held. */
const setIcon = (button, name, size = 16) => button.replaceChildren(icon(name, { size }));

/**
 * A control's name. **Also its hover label**: the stylesheet draws `attr(aria-label)`, so the
 * words a screen reader says and the words that appear on hover are one string, set in one place.
 */
const label = (button, text) => button.setAttribute('aria-label', text);

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

// **No mark and no title here.** Chrome draws `OpenPosse` with the extension's own icon directly
// above this document, and the first version repeated both twenty pixels below it. The shortcut
// is the one thing in that header Chrome does not show, so it is the only thing kept.

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
  transcript: '', volatile: '', answer: '', sub: '', message: '',
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

/**
 * What the status line says, and it is three different kinds of thing.
 *
 * **While something is happening it is a verb; once it has settled it is an address.** `Ivan is
 * thinking…` then `Ivan is speaking` then `Ivan · Notion`, in their channel colour throughout –
 * the landing hero's own sequence, and it is better than either half alone. The port used the
 * address for all three, so thinking, answering and the minute afterwards rendered identically
 * and the only thing that moved was the orb. The verb says a turn is still in flight; the vendor
 * is what a person checks when an answer looks wrong, and it is wanted once it is over.
 *
 * Plain words are for where there is no agent to name, or where something needs saying.
 */
/**
 * The phases where an answer is on its way, so the panel holds a space open for it.
 *
 * **Not simply "a turn is running".** `listening` is deliberately out: nothing is about to land
 * while somebody is still talking, and on a panel that has never answered the reserve would be a
 * gap between the roster and the controls rather than space at the end of anything. Holding it
 * from `routing` means the one move the layout makes is at the moment the person stopped speaking
 * – not at the moment the bubble appears, which is when a hand is most likely on its way to Stop.
 */
const AWAITING = new Set(['routing', 'thinking', 'answering']);

const STATUS = {
  listening: () => ({ text: 'Listening' }),
  routing: () => ({ text: "Working out who that's for…", pulse: true }),
  thinking: (s) => ({ who: s.agentName, verb: 'is thinking…', pulse: true, tinted: true }),
  answering: (s) => ({ who: s.agentName, verb: 'is speaking', tinted: true }),
  'needs-attention': () => ({ text: 'Needs attention', bad: true }),
  'not-capturing': () => ({ text: 'No input', bad: true }),
  idle: (s) => (s.agentName ? { who: s.agentName, tinted: true } : { text: '' }),
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
  const who = el('who');
  who.className = `who${look.tinted ? ' tinted' : ''}${look.bad ? ' bad' : ''}`;
  if (state.channel) who.style.setProperty('--channel', state.channel);
  who.textContent = '';
  if (look.pulse) {
    const dot = document.createElement('div');
    dot.className = 'pulse';
    who.append(dot);
  }
  // A message always wins: it is the only thing here written for this exact moment, and the
  // phases that carry one are the ones where something went wrong.
  //
  // The verb needs a name to attach to, so a phase that has one falls back to the address rather
  // than printing `null is thinking…` – which is the same thing the port did with no agent, so
  // nothing regresses in the case where routing has not decided yet.
  const vendor = look.who ? roster.products[idFor(look.who)] : null;
  const named = look.verb ? `${look.who} ${look.verb}` : [look.who, vendor].filter(Boolean).join(' · ');
  const words = state.message || (look.who ? named : look.text);
  if (words) who.append(document.createTextNode(words));

  el('deadmic').hidden = state.phase !== 'not-capturing';

  // See `AWAITING` above, and the `.awaiting` rule in the stylesheet.
  el('stage').classList.toggle('awaiting', AWAITING.has(state.phase));

  const answer = el('answer');
  answer.textContent = '';
  if (state.answer) {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.append(document.createTextNode(state.answer));
    if (state.sub) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = state.sub;
      bubble.append(sub);
    }
    answer.append(bubble);
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

/**
 * The roster, read once and drawn many times.
 *
 * **Split in two because the vendor names cost a storage read each.** The status line says
 * `Ivan · Notion`, and that product name comes from the agent's recipe – so a render that fetched
 * it would hit storage per agent on every phase change, six times a turn, to draw the same four
 * strings. `load()` fetches; `draw()` is synchronous and cheap and runs whenever the turn moves.
 */
let roster = { agents: [], broken: [], problem: null, products: {} };

/** Whom the text box is currently aimed at. Survives re-renders; the roster does not own it. */
let aimedAt = null;

const idFor = (name) => roster.agents.find((a) => a.name === name)?.id ?? null;

/**
 * Who currently holds the floor, so the panel lights the agent a follow-up would reach.
 *
 * **Expiry is checked here too, against the same window the worker routes by** – including a
 * debug override of it. A ring that outlives the floor is not cosmetic: it says a name-less
 * question would go to Ivan when it would actually be refused.
 */
async function floorHolderName() {
  const { floorHolder, floorAt = 0, [FLOOR_OVERRIDE_KEY]: override } = await chrome.storage
    .session.get(['floorHolder', 'floorAt', FLOOR_OVERRIDE_KEY]);
  if (!floorHolder || Date.now() - floorAt > floorWindow(override)) return null;
  return floorHolder;
}

async function loadRosterData() {
  const { agents, broken, problem } = await loadRoster();
  const products = {};
  await Promise.all(agents.map(async (agent) => {
    // `productLabel` turns `*.notion.so` into "Notion" – the same derivation E3b's navigation
    // matches against, so "take me to Notion" and the label here cannot drift apart. The label
    // rather than `productName`, which is lowercase because it is for matching, not for reading.
    products[agent.id] = productLabel((await recipeFor(agent))?.domainPattern) || null;
  }));
  roster = { agents, broken, problem, products };
  drawRoster();
}

async function drawRoster() {
  const { agents, broken, problem } = roster;
  // Mid-turn the patch is authoritative and arrives ahead of session storage; between turns
  // storage is the only source. Reading both in that order keeps the lit ring honest either way.
  const active = state.agentName ?? await floorHolderName();

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

  const target = el('avatars');
  target.textContent = '';

  // **Re-asking is offered only when there is something to re-ask.** The orb turns every avatar
  // into a re-route button because an answer is the only thing it ever shows. Here an avatar is
  // usually just a target for the text box, so the title says which of the two a click will do –
  // an invisible mode switch on a click is the thing this codebase keeps banning.
  const canReroute = Boolean(state.answer) && state.phase !== 'listening';

  for (const agent of agents) {
    const holdsFloor = agent.name === active;
    const reroutes = canReroute && !holdsFloor;
    const vendor = roster.products[agent.id];

    // **A button, holding the circle.** It was a clickable div, which the keyboard could not
    // reach and which cannot carry an `aria-label`. The circle is the `.face` inside: `avatar` is
    // ui.css's, so this and Settings cannot disagree about the shape, and the dim and the ring are
    // drawn on the face so the button's hover label does not fade with them. `av` carries only
    // the panel's states.
    //
    // **`lit` is the ring, and only the floor holder gets it.** Giving all four the ring and the
    // glow produced four things competing to look selected; the ring means one thing, which is
    // that this is who the turn is with.
    //
    // **`dim` is applied, never undone.** Full opacity is the resting state and the others fade
    // only while somebody holds the floor – the landing hero's rule, and the inverse of the
    // port's, which dimmed by default and needed an `on` class to put the roster back to normal.
    // That made the ordinary appearance of the roster the special case.
    const av = document.createElement('button');
    av.type = 'button';
    av.className = `av${holdsFloor ? ' lit' : ''}${active && !holdsFloor ? ' dim' : ''}`
      + `${agent.name === aimedAt ? ' aimed' : ''}`
      + `${broken.includes(agent.id) ? ' broken' : ''}`;
    // The name, for `aim()` to match on. **Not the label**: "Ivan" is a substring of "Ivan 2", so
    // matching on text aimed at one and highlighted both – which is exactly the roster this
    // project has, since `freeName` produces "Ivan 2" on a second import.
    av.dataset.name = agent.name;
    // The roster starts at the panel's left edge, where a centred label would run off it.
    av.dataset.tipAt = 'start';
    av.style.setProperty('--channel', channelOf(agent));

    const face = document.createElement('span');
    face.className = 'avatar face';
    face.textContent = initialFor(agent.name);
    av.append(face);

    // The name is no longer on screen beside the letter, so it has to be reachable: the label is
    // the only thing carrying it for an agent who is not currently the subject of the status line.
    label(av, broken.includes(agent.id) ? `${agent.name} needs re-recording`
      : reroutes ? `Put the same question to ${agent.name}`
        : [`Ask ${agent.name}`, vendor].filter(Boolean).join(' · '));

    av.addEventListener('click', () => {
      if (reroutes) {
        // Straight to the worker, which re-asks the remembered prompt. The agent was *clicked*,
        // so re-deriving them from a sentence would throw away the one unambiguous signal there
        // is – which is exactly why the worker's handler skips routing too.
        chrome.runtime.sendMessage({ kind: 'openposse.orb.reroute', agentName: agent.name })
          .catch(() => {});
        return;
      }
      // Aiming is for the text box, so it opens it: aiming at a field that is hidden would be a
      // click that changed nothing anybody can see.
      aim(agent.name);
      setAsk(true);
    });

    target.append(av);
  }

  if (agents.length > 0 && !findAgent(agents, aimedAt ?? '')) aim(active ?? agents[0].name);
}

function aim(name) {
  aimedAt = name;
  el('prompt').placeholder = `Ask ${name} to…`;
  el('prompt').dataset.agent = name;
  label(el('send'), `Ask ${name}`);
  for (const av of el('avatars').children) {
    av.classList.toggle('aimed', av.dataset.name === name);
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
  // A filled square is Stop, the same reading it has on every media control. The two sizes are
  // what makes them weigh the same: a square fills far more of its box than a microphone does.
  setIcon(button, listening ? 'square' : 'mic', listening ? 15 : 21);
  label(button, listening ? 'Stop listening' : 'Listen');
  // **Listen is the filled control and everything else is an outline**, the way round the first
  // version had backwards: voice is the product and typing is the fallback, and the weight on
  // screen has to say the same thing the order does. Losing the fill while listening turns it
  // into Stop, which is a different act.
  button.classList.toggle('listening', listening);
}

el('listen').addEventListener('click', () => {
  // Not awaited: the reply arrives as a broadcast state message like every other transition, so
  // waiting for this one would mean rendering the same thing twice by two different routes.
  chrome.runtime.sendMessage({ kind: 'openposse.listen.toggle' }).catch(() => {});
});

// ── Asking without speaking ────────────────────────────────────────────────────────────────

/**
 * Shows or hides the text box. Opening it focuses the field, because the only reason to open
 * it is to type.
 *
 * Not remembered between panels: it starts shut every time, so the first thing under the orb is
 * always the microphone.
 */
function setAsk(open) {
  el('ask').hidden = !open;
  el('type').setAttribute('aria-expanded', String(open));
  label(el('type'), open ? 'Hide the text box' : 'Type a question instead');
  if (open) el('prompt').focus();
}

el('type').addEventListener('click', () => setAsk(el('ask').hidden));

async function send() {
  const input = el('prompt');
  const prompt = input.value.trim();
  if (!prompt) return;

  const agent = findAgent(roster.agents, input.dataset.agent ?? '') ?? roster.agents[0];
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
  const note = el('site-note');
  const grant = el('grant');

  if (!site.pattern) {
    line.textContent = site.why;
    grant.hidden = true;
  } else if (site.covered) {
    line.textContent = `${site.pattern} – access granted`;
    grant.hidden = true;
  } else {
    line.textContent = `${site.pattern} – no access yet`;
    label(grant, `Grant access to ${site.pattern}`);
    grant.hidden = false;
  }

  // **Said out loud, because it was not and that cost an hour.** Chrome's own Site access menu
  // offers "On all sites" in one click, and nothing in this extension asks for it or mentions it
  // afterwards – so every site reads as granted, for a reason the product never stated. It is
  // also the exact trap that made two earlier tests of the grant flow prove nothing.
  //
  // Its own line under the site, fainter: it is about the browser's settings rather than this
  // page, and it is the same note on every tab.
  const { origins = [] } = await chrome.permissions.getAll().catch(() => ({ origins: [] }));
  const broad = origins.filter(isBroad);
  note.classList.remove('bad');
  note.textContent = broad.length
    ? `${broad.join(', ')} is granted, which covers every site. `
      + 'Chrome › Extensions › OpenPosse › Details › Site access is where that is set.'
    : '';
  note.hidden = !broad.length;

  el('record').disabled = !site.pattern;
  label(el('record'), site.pattern ? `Record the assistant on ${site.host}` : site.why);
}

/**
 * Something just went wrong with site access, in the bar that is about site access.
 *
 * These used to replace the button's own text. An icon has no text, and a hover label is gone
 * the moment the pointer moves, so they land under the site line – where they stay until the
 * next repaint, which is the next time the tab or the grants change.
 */
function say(text) {
  const note = el('site-note');
  note.textContent = text;
  note.classList.add('bad');
  note.hidden = false;
}

// **First statement, nothing awaited before it.** See `site` above.
el('grant').addEventListener('click', () => {
  if (!site.pattern) return;
  chrome.permissions.request({ origins: [matchPattern(site.pattern)] })
    .then(paintSite, (error) => say(`Chrome refused the request – ${error?.message ?? error}`));
});

el('record').addEventListener('click', async () => {
  if (!site.pattern) {
    say(site.why);
    console.warn('[openposse] record pressed with no recordable tab –', site.why);
    return;
  }
  const { tabId, pattern } = site;

  // First statement, nothing awaited before it.
  const granted = await chrome.permissions.request({ origins: [matchPattern(pattern)] });
  if (!granted) {
    // Declining is an answer, not a failure – the panel stays put and says so.
    say('Site access is needed to record');
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
  // The icon is where a click takes you, not where you are – the same reading as the label.
  setIcon(el('surface'), onPanel ? 'orbit' : 'panel-right', 16);
  label(el('surface'), onPanel
    ? 'Use the orb – show turns over the page instead'
    : 'Use this panel – it also works on pages the orb cannot reach');
}

el('surface').addEventListener('click', async () => {
  const { surface } = await chrome.storage.local.get('surface');
  await setSurface(surface === 'panel' ? 'orb' : 'panel');
  await paintSurface();
});

// ── The scripted turn ──────────────────────────────────────────────────────────────────────

/**
 * Replays a turn with no vendor in it, so this surface and the orb can be judged without
 * spending a real question. The script lives in the worker – see `demo.js` – because it drives
 * the same `panel()` channel a real turn does, and a copy of it here would be a second renderer
 * able to disagree with the one being evaluated.
 *
 * **The button reports that it is running, and this is not polish.** It runs for about a minute
 * and its first visible act is nine hundred milliseconds away, so a button that did nothing
 * visible for a second would be pressed twice – and the second press restarts the script,
 * which looks exactly like the first press having failed.
 */
const DEMO = 'Play a scripted turn – no vendor, no question spent';

function showDemo(playing) {
  const button = el('demo');
  button.disabled = playing;
  button.classList.toggle('busy', playing);
  setIcon(button, playing ? 'loader-circle' : 'play', playing ? 15 : 12);
  label(button, playing ? 'Playing the scripted turn…' : DEMO);
}

el('demo').addEventListener('click', () => {
  if (el('demo').disabled) return;
  showDemo(true);
  chrome.runtime.sendMessage({ kind: 'openposse.demo' })
    .catch((error) => console.warn('[openposse] the demo could not start –', error?.message ?? error))
    .finally(() => showDemo(false));
});

// ── Debug tools ────────────────────────────────────────────────────────────────────────────

/**
 * Behind one switch, as the Mac app had them – and holding less than its menu did, deliberately.
 *
 * Of what that menu and the summon panel's sliders carried, only the follow-up window is still a
 * guess this extension makes. The silence threshold has nothing left to tune, because Chrome's
 * recogniser ends a turn by itself; the agent timeout is measured per vendor when a recipe is
 * recorded; and the rest – key focus, audio format, VAD counts, the native bridge, transcriber
 * fixtures – described a Mac app that is parked. What is here instead is this extension's own
 * scaffolding: the demo, E14's surface switch, and the voice diagnostics page nothing else links
 * to. The answer grace was never a Mac slider; it is here because it is the other clock a turn
 * still waits on.
 *
 * Not remembered between panels, unlike the overrides inside it – which is why the toggle carries
 * a dot whenever one is in force.
 */

/**
 * The sliders, one row each. `resolve` is the function every reader of that value already goes
 * through, so the panel shows exactly what the worker and the page will use – including falling
 * back to the default for anything out of range – rather than a second opinion about it.
 */
const KNOBS = [
  {
    id: 'floor', name: 'follow-up window', key: FLOOR_OVERRIDE_KEY,
    range: FLOOR_RANGE, fallback: FLOOR_MS, resolve: floorWindow,
  },
  {
    id: 'grace', name: 'answer settle wait', key: GRACE_OVERRIDE_KEY,
    range: GRACE_RANGE, fallback: ANSWER_GRACE_MS, resolve: graceWindow,
  },
];

/** Overrides in force, in ms, by knob id. Absent means the shipped value. */
const overrides = {};

function paintDebugToggle() {
  const open = !el('debug-tools').hidden;
  const toggle = el('debug');
  const set = KNOBS.filter((k) => k.id in overrides).map((k) => `${k.name} ${overrides[k.id] / 1000} s`);
  toggle.setAttribute('aria-expanded', String(open));
  toggle.classList.toggle('overridden', set.length > 0);
  label(toggle, [open ? 'Hide debug tools' : 'Debug tools', set.join(', ')].filter(Boolean).join(' – '));
}

el('debug').addEventListener('click', () => {
  el('debug-tools').hidden = !el('debug-tools').hidden;
  paintDebugToggle();
});

// Kokoro's layer-by-layer check, `spike.js`. A tab rather than the panel, because it runs each
// layer inside the real extension origin and reports one row per layer.
el('diagnostics').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('spike.html') }).catch((error) => {
    console.warn('[openposse] could not open the voice diagnostics –', error?.message ?? error);
  });
});

/** Seconds on the slider, milliseconds everywhere else. Rounded: 0.75 × 1000 is not always 750. */
const msOf = (input) => Math.round(Number(input.value) * 1000);

function showKnob(knob, ms) {
  el(`${knob.id}-value`).textContent = ms === knob.fallback ? `${ms / 1000} s (default)` : `${ms / 1000} s`;
}

async function paintKnobs() {
  const stored = await chrome.storage.session.get(KNOBS.map((k) => k.key));
  for (const knob of KNOBS) {
    const ms = knob.resolve(stored[knob.key]);
    if (ms === knob.fallback) delete overrides[knob.id];
    else overrides[knob.id] = ms;
    el(knob.id).value = String(ms / 1000);
    showKnob(knob, ms);
  }
  paintDebugToggle();
}

for (const knob of KNOBS) {
  const input = el(knob.id);
  // The range comes from the module that enforces it, so the panel cannot offer what the worker
  // or the page would refuse.
  Object.assign(input, {
    min: String(knob.range.min / 1000),
    max: String(knob.range.max / 1000),
    step: String(knob.range.step / 1000),
  });
  input.addEventListener('input', () => showKnob(knob, msOf(input)));
  input.addEventListener('change', () => {
    const ms = msOf(input);
    // **The default is stored as nothing at all**, so "the default" means no override rather
    // than an override that happens to equal it – and the dot goes out when somebody slides it
    // back.
    const write = ms === knob.fallback
      ? chrome.storage.session.remove(knob.key)
      : chrome.storage.session.set({ [knob.key]: ms });
    write.catch((error) => {
      console.warn(`[openposse] could not store the ${knob.name} –`, error?.message ?? error);
      paintKnobs();
    });
  });
}

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

  if (patch.shortcut !== undefined) el('shortcut').textContent = patch.shortcut || '';

  renderTurn();
  // The lit avatar and the re-ask offer both depend on the turn, so they redraw with it.
  // **Compared rather than triggered off the patch's own keys**, because the clearing case has
  // no key to watch: a turn that ends leaves avatars still offering to re-ask a question whose
  // answer is gone. Skipping the unchanged case keeps this off the twice-a-second interim path.
  if (before.phase !== state.phase || before.answer !== state.answer
    || before.agentName !== state.agentName || patch.agents !== undefined) {
    drawRoster();
  }
  return false;
});

// ── Staying current, which a popup never had to do ─────────────────────────────────────────
//
// All of these exist because this surface outlives the things it is describing. The popup read
// everything once, at open, and was gone before any of it could change.

chrome.tabs.onActivated.addListener(paintSite);
chrome.tabs.onUpdated.addListener((_id, change) => { if (change.url) paintSite(); });
chrome.windows?.onFocusChanged?.addListener(paintSite);

// A grant made from Settings, from the recorder, or revoked in Chrome's own Site access menu –
// which is precisely how an agent can go dead with nothing on screen to say why.
chrome.permissions.onAdded.addListener(paintSite);
chrome.permissions.onRemoved.addListener(paintSite);

chrome.storage.onChanged.addListener((changes, area) => {
  // A debug slider moved, here or in another window's panel. The follow-up window also decides
  // whether the lit ring is still true, so that one redraws the roster too.
  if (area === 'session' && KNOBS.some((k) => changes[k.key])) {
    paintKnobs();
    if (changes[FLOOR_OVERRIDE_KEY]) drawRoster();
    return;
  }
  if (area !== 'local') return;
  // The whole roster, not just the names: a re-record replaces a recipe, and the vendor label in
  // the status line comes from it.
  if (changes.agents || Object.keys(changes).some((k) => k.startsWith('recipe:'))) loadRosterData();
  if (changes.surface) paintSurface();
  if (changes.micGranted) checkMic();
});

// ── Start ──────────────────────────────────────────────────────────────────────────────────

// **An unbound command is a state, not an absence.** Chrome drops a user-assigned shortcut when
// an unpacked extension is removed and re-added, and `getAll` then returns the command with an
// empty `shortcut`. Rendering that as blank space meant the one surface that knows the binding
// showed nothing, and "⌥V stopped working" had no visible cause anywhere in the product.
chrome.commands.getAll().then((commands) => {
  const summon = commands.find((c) => c.name === 'summon');
  el('shortcut').textContent = summon?.shortcut || 'no shortcut';
  el('shortcut').title = summon?.shortcut
    ? 'Press this anywhere to start a turn'
    : 'Set one in Settings, or at chrome://extensions/shortcuts';
  if (!summon?.shortcut) console.warn('[openposse] no shortcut is bound to the summon command');
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

// The controls whose icon never changes get it once, here. The rest – Listen, the toggles, the
// demo while it plays, the surface switch – set theirs wherever their state changes, starting
// with the calls below.
setIcon(el('type'), 'keyboard', 17);
setIcon(el('record'), 'circle', 11);
setIcon(el('settings'), 'settings', 17);
setIcon(el('debug'), 'bug', 16);
setIcon(el('send'), 'send-horizontal', 16);
setIcon(el('grant'), 'key-round', 16);
setIcon(el('diagnostics'), 'stethoscope', 16);
showListening({ listening: false });
setAsk(false);
showDemo(false);
paintDebugToggle();

renderTurn();
loadRosterData();
checkMic();
paintSite();
paintSurface();
paintKnobs();
requestAnimationFrame(tick);
