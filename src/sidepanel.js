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
// - **It can show that a site is not granted.** A popup that closes cannot tell you an hour later
//   that the site it is looking at is no longer granted; a panel that stays open can – the key
//   joins the controls – and that is exactly the diagnostic that was missing when a Chrome
//   Site-access change silently killed an agent.
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
import { FLOOR_OVERRIDE_KEY, floorWindow, productLabel } from './routing.js';
import { patternForHost, matchPattern } from './domain.js';
import { drawSphere, modeFor } from './sphere.js';
import { icon } from './icons.js';
import { ICONS, iconPages, putIcon } from './favicons.js';

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
  transcript: '', volatile: '', answer: '', sub: '', message: '', warming: false,
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
 * Plain words are for where there is no agent to name, or where something needs saying – such as
 * the seconds between an answer landing and the voice making its first sound.
 */
const STATUS = {
  listening: () => ({ text: 'Listening' }),
  routing: () => ({ text: "Working out who that's for…", pulse: true }),
  thinking: (s) => ({ who: s.agentName, verb: 'is thinking…', pulse: true, tinted: true }),
  answering: (s) => (s.warming
    ? { text: 'Warming up speech engine…', pulse: true }
    : { who: s.agentName, verb: 'is speaking', tinted: true }),
  'needs-attention': () => ({ text: 'Needs attention', bad: true }),
  'not-capturing': () => ({ text: 'No input', bad: true }),
  idle: (s) => (s.agentName ? { who: s.agentName, tinted: true } : { text: '' }),
};

/** What the box holds before the first turn: where an answer will go, and how to get one. */
const ANSWER_PLACEHOLDER = "Say an assistant's name, then your question – the answer shows here.";

// ── Fitting the question and the answer ────────────────────────────────────────────────────

/**
 * Sizes for what was said, largest first. Two lines fit at the first two and three at the last,
 * in the height `.transcript` fixes in the stylesheet.
 */
const QUESTION_SIZES = [21, 18, 16];

/**
 * Fits what was said into its slot, stepping the type down before cutting anything.
 *
 * Measured rather than predicted from a character count, because both the width and the words
 * are the user's: the panel can be dragged wider, and nobody's question is a fixed length.
 */
function fitQuestion() {
  const box = el('transcript');
  box.classList.remove('tail', 'clamped');
  for (const size of QUESTION_SIZES) {
    box.style.fontSize = `${size}px`;
    if (box.scrollHeight <= box.clientHeight) {
      box.scrollTop = 0;
      return;
    }
  }
  // Too long even at the smallest size. While somebody is talking, the newest words are the ones
  // they are checking, so the cut comes off the front; once it has settled, the start reads best.
  const live = state.phase === 'listening';
  box.classList.add(live ? 'tail' : 'clamped');
  box.scrollTop = live ? box.scrollHeight : 0;
}

/**
 * Sizes for the answer, with the leading that goes with each. Three lines fit in the box at the
 * first two and four at the last.
 */
const ANSWER_SIZES = [[15.5, 1.47], [14, 1.4], [13, 1.3]];

/** The answer's version: the type steps down to fit, and whatever still does not fit scrolls. */
function fitAnswer() {
  const text = el('answer-text');
  for (const [size, leading] of ANSWER_SIZES) {
    text.style.fontSize = `${size}px`;
    text.style.lineHeight = String(leading);
    if (text.scrollHeight <= text.clientHeight) return;
  }
}

// Both depend on the panel's width, which the user can drag.
window.addEventListener('resize', () => {
  fitQuestion();
  fitAnswer();
});

function renderTurn() {
  // **Recording takes the whole panel**, because it is a different activity rather than a
  // different turn state: there is no transcript, no roster to re-route to, and the person is
  // standing in a vendor's page being told what to click. The controls go too – offering "Ask" and
  // "Record this tab" in the middle of a recording is offering to start a second one.
  const recording = state.phase === 'recording';
  el('top').hidden = recording;
  el('avatars').hidden = recording;
  el('desk').hidden = recording;
  el('dock').hidden = recording;
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
  fitQuestion();

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
  // Before the first turn there is no status at all, and a blank line in a box reads as broken.
  who.classList.toggle('placeholder', !words);
  who.append(document.createTextNode(words || 'No question yet'));

  el('deadmic').hidden = state.phase !== 'not-capturing';

  // **Filled in place, never rebuilt.** The box is in the markup and always shown, so rebuilding
  // it per patch would replay its entrance with every word somebody says. See `.bubble` in the
  // stylesheet for why it is one height throughout.
  //
  // The placeholder only while nothing is under way: mid-turn the status line says what is
  // happening, and an invitation to ask would be asking twice.
  const text = el('answer-text');
  const shown = state.answer || (state.phase === 'idle' ? ANSWER_PLACEHOLDER : '');
  text.hidden = !shown;
  text.classList.toggle('placeholder', !state.answer);
  if (text.textContent !== shown) {
    text.textContent = shown;
    // A new answer starts at its first line, wherever the last one was scrolled to.
    text.scrollTop = 0;
  }
  const sub = el('answer-sub');
  sub.hidden = !state.answer || !state.sub;
  sub.textContent = state.sub ?? '';
  fitAnswer();
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
let roster = { agents: [], broken: [], problem: null, products: {}, patterns: {}, icons: {} };

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
  // In the order arranged in Settings – so the first one is also the typed box's default.
  const { arranged: agents, broken, problem } = await loadRoster();
  const products = {};
  const patterns = {};
  await Promise.all(agents.map(async (agent) => {
    patterns[agent.id] = (await recipeFor(agent))?.domainPattern;
    // `productLabel` turns `*.notion.so` into "Notion" – the same derivation E3b's navigation
    // matches against, so "take me to Notion" and the label here cannot drift apart. The label
    // rather than `productName`, which is lowercase because it is for matching, not for reading.
    products[agent.id] = productLabel(patterns[agent.id]) || null;
  }));
  // Empty unless site icons are switched on in Settings – see favicons.js.
  roster = { agents, broken, problem, products, patterns, icons: await iconPages(patterns) };
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
    av.style.setProperty('--channel', channelOf(agent));

    const face = document.createElement('span');
    face.className = 'avatar face';
    face.textContent = initialFor(agent.name);
    putIcon(face, roster.icons[agent.id]);
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
  sizeAvatars();
  alignTips();

  if (agents.length > 0 && !findAgent(agents, aimedAt ?? '')) aim(active ?? agents[0].name);
}

/**
 * How big the avatars are, in four steps by how many there are. Up to 4 sit four to a row, up to
 * 10 five, up to 20 six, and beyond that eight – the 34px a long roster has always been. Each step
 * is the size that fills a row with that many, so in a 360px panel they are 77, 60, 48 and 34px.
 * Steps by request, 2026-10-06: a size for every count reached the smallest by eight assistants.
 *
 * **No bigger than they are in a 360px panel**, the width Chrome opens one at – like the orb. A
 * wider panel leaves them that size rather than filling it; a narrower one still shrinks them.
 * Only the sizing is capped: a long roster of 34px avatars still wraps at the panel's full width.
 *
 * Set on the middle rather than on the row, because the middle's `min-height` – a row of avatars
 * and most of the next – has to grow with them.
 */
const AVATAR_MIN = 34; // ui.css's circle
const AVATAR_GAP = 8; // #avatars' gap
const AVATAR_ROW = 332; // the row in a 360px panel, inside the middle's 14px sides
/** Up to `upTo` assistants sit `perRow` to a row. */
const AVATAR_STEPS = [
  { upTo: 4, perRow: 4 },
  { upTo: 10, perRow: 5 },
  { upTo: 20, perRow: 6 },
  { upTo: Infinity, perRow: 8 },
];

function sizeAvatars() {
  const row = el('avatars');
  const count = row.children.length;
  const { perRow } = AVATAR_STEPS.find((step) => count <= step.upTo);
  const width = Math.min(row.clientWidth, AVATAR_ROW);
  const fill = count ? (width - (perRow - 1) * AVATAR_GAP) / perRow : AVATAR_MIN;
  const size = Math.floor(Math.max(AVATAR_MIN, fill));
  el('middle').style.setProperty('--av', `${size}px`);
}

/**
 * Which edge each avatar's label hangs from, now that the row wraps and avatars reach the right
 * side of the panel.
 *
 * **An invisible label still widens the page.** It is an absolutely placed box at opacity 0, so
 * one hanging off the right edge makes the panel scroll sideways – the bug the wrap fixed, back
 * through the labels. By thirds of the panel: hung from the left edge on the left, centred in the
 * middle, from the right edge on the right. A 220px label clears both edges from any of them.
 */
function alignTips() {
  const width = document.documentElement.clientWidth;
  for (const av of el('avatars').children) {
    const { left, width: size } = av.getBoundingClientRect();
    const at = (left + size / 2) / width;
    if (at < 1 / 3) av.dataset.tipAt = 'start';
    else if (at > 2 / 3) av.dataset.tipAt = 'end';
    else delete av.dataset.tipAt;
  }
}

// The panel's width is the user's, and dragging it re-wraps the row.
window.addEventListener('resize', () => { sizeAvatars(); alignTips(); });

/**
 * Whether a label in the scrolling middle hangs below its control instead of above.
 *
 * **The middle clips what it holds**, so a label above a control near its top edge is cut off –
 * and the roster's first row now sits right against that edge, under the fixed top. Decided as the
 * label is about to show rather than once, like `alignTips`, because scrolling moves the controls.
 * The room asked for is a two-line label, its 8px gap and the 10px fade.
 */
const TIP_ROOM = 60;

function placeTip(event) {
  const button = event.target.closest?.('button:is(.icon, .av)[aria-label]');
  if (!button) return;
  const room = button.getBoundingClientRect().top - el('middle').getBoundingClientRect().top;
  button.toggleAttribute('data-tip-below', room < TIP_ROOM);
}

el('middle').addEventListener('pointerover', placeTip);
el('middle').addEventListener('focusin', placeTip);

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

  // The key, only while this tab is one we may not drive yet. The line that said which site this
  // was and whether it was granted went on 2026-10-06 with the debug drawer; the all-sites note
  // under it is in Settings › Debug tools now, since it is about the browser rather than a tab.
  const grant = el('grant');
  grant.hidden = !site.pattern || site.covered;
  if (!grant.hidden) label(grant, `Grant access to ${site.pattern}`);

  // A repaint is also what retires the last Grant or Record error – see `say`.
  el('dock-note').hidden = true;

  el('record').disabled = !site.pattern;
  label(el('record'), site.pattern ? `Record the assistant on ${site.host}` : site.why);
}

/**
 * Something just went wrong with site access, said beside the controls that were pressed.
 *
 * These used to replace the button's own text. An icon has no text, and a hover label is gone
 * the moment the pointer moves, so they get a line above the controls – where they stay until the
 * next repaint, which is the next time the tab or the grants change. **Not in the debug drawer
 * with the site line**: an error that shows only while a drawer is open is not shown.
 */
function say(text) {
  const note = el('dock-note');
  note.textContent = text;
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

  // A new turn also brings the roster back into view, wherever the middle was scrolled to. A spoken
  // turn opens on `listening`; a typed or re-asked one opens straight on `thinking` – which a spoken
  // turn reaches too, but always by way of `routing`.
  if (state.phase !== before.phase && (state.phase === 'listening'
    || (state.phase === 'thinking' && before.phase !== 'routing'))) {
    el('middle').scrollTop = 0;
  }

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

// Site icons on the avatars: the setting is the `favicon` permission itself, switched in Settings.
const iconsSwitched = ({ permissions = [] }) => {
  if (permissions.includes('favicon')) loadRosterData();
};
chrome.permissions.onAdded.addListener(iconsSwitched);
chrome.permissions.onRemoved.addListener(iconsSwitched);

// A site seen for the first time while the panel is open: its assistant's letter becomes the icon
// as soon as the tab has one, not at the next panel open. Only https pages count, as in the tab
// query in favicons.js, and only for an assistant still showing its letter – which, with the
// setting off, is every one of them, hence the permission check.
chrome.tabs.onUpdated.addListener(async (_id, change, tab) => {
  if (!change.favIconUrl || !tab.url?.startsWith('https://')) return;
  const pattern = patternForHost(new URL(tab.url).hostname);
  const lettered = roster.agents.some((agent) =>
    !roster.icons[agent.id] && roster.patterns[agent.id] === pattern);
  if (lettered && await chrome.permissions.contains(ICONS)) loadRosterData();
});

chrome.storage.onChanged.addListener((changes, area) => {
  // The follow-up window moved in Settings' debug tools. It decides whether the lit ring is
  // still true, so the roster redraws.
  if (area === 'session') {
    if (changes[FLOOR_OVERRIDE_KEY]) drawRoster();
    return;
  }
  if (area !== 'local') return;
  // The whole roster, not just the names: a re-record replaces a recipe, and the vendor label in
  // the status line comes from it.
  if (changes.agents || changes.rosterOrder || Object.keys(changes).some((k) => k.startsWith('recipe:'))) {
    loadRosterData();
  }
  if (changes.micGranted) checkMic();
});

// ── The demo ───────────────────────────────────────────────────────────────────────────────

/**
 * Replays a turn with no vendor in it, so this surface and the voice can be judged without
 * spending a real question. Back here from Settings on 2026-10-06, top right over the orb,
 * because this is where it plays.
 *
 * The script lives in the worker – see `demo.js` – because it drives the same `panel()` channel a
 * real turn does, and a copy of it here would be a second renderer able to disagree with the one
 * being evaluated.
 *
 * **A second press pauses, and Stop sits under it while anything is playing.** The button used to
 * spin and refuse presses, because a second press restarted the script and looked exactly like the
 * first one having failed. Pause gives that press something useful to do, so the spinner is gone.
 * Pause holds the voice mid-word; Stop silences it and leaves the panel empty and at rest.
 */
const DEMO_LABELS = {
  idle: 'Play a scripted turn – no vendor, no question spent',
  playing: 'Pause the scripted turn',
  paused: 'Resume the scripted turn',
};

/** `idle`, `playing` or `paused` – what the button shows, which the worker's run can outlive. */
let demo = 'idle';

/**
 * Counts presses of Play and Stop, so a run that has been stopped cannot reset the button when it
 * finally returns. A stopped run can take seconds to unwind – a voice that was still loading has
 * to finish loading first – and by then somebody may have pressed Play again.
 */
let runs = 0;

function showDemo(next) {
  demo = next;
  const button = el('demo');
  setIcon(button, demo === 'playing' ? 'pause' : 'play', 12);
  label(button, DEMO_LABELS[demo]);
  el('demostop').hidden = demo === 'idle';
}

/** Pause and Resume, which differ only in the message and the state they lead to. */
function holdDemo(kind, next, what) {
  chrome.runtime.sendMessage({ kind })
    .then((answer) => {
      if (answer?.ok) showDemo(next);
      else console.warn(`[openposse] the demo could not be ${what} –`, answer?.reason ?? 'no reason given');
    })
    .catch((error) => console.warn(`[openposse] the demo could not be ${what} –`, error?.message ?? error));
}

el('demo').addEventListener('click', () => {
  if (demo === 'playing') { holdDemo('openposse.demo.pause', 'paused', 'paused'); return; }
  if (demo === 'paused') { holdDemo('openposse.demo.resume', 'playing', 'resumed'); return; }
  runs += 1;
  const run = runs;
  showDemo('playing');
  chrome.runtime.sendMessage({ kind: 'openposse.demo' })
    .catch((error) => console.warn('[openposse] the demo could not start –', error?.message ?? error))
    .finally(() => { if (run === runs) showDemo('idle'); });
});

el('demostop').addEventListener('click', () => {
  // Idle at once, rather than when the stopped run returns: see `runs`.
  runs += 1;
  showDemo('idle');
  chrome.runtime.sendMessage({ kind: 'openposse.demo.stop' })
    .then((answer) => {
      if (!answer?.ok) console.warn('[openposse] the demo could not be stopped –', answer?.reason ?? 'no reason given');
    })
    .catch((error) => console.warn('[openposse] the demo could not be stopped –', error?.message ?? error));
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

// The controls whose icon never changes get it once, here. The rest – Listen, the toggles and the
// demo's play/pause – set theirs wherever their state changes, starting with the calls below.
setIcon(el('type'), 'keyboard', 17);
setIcon(el('record'), 'circle', 11);
setIcon(el('settings'), 'settings', 17);
setIcon(el('send'), 'send-horizontal', 16);
setIcon(el('grant'), 'key-round', 16);
setIcon(el('demostop'), 'square', 11);
label(el('demostop'), 'Stop the scripted turn');
showListening({ listening: false });
setAsk(false);
showDemo('idle');

renderTurn();
loadRosterData();
checkMic();
paintSite();
requestAnimationFrame(tick);
