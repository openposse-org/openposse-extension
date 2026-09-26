// The worker's half of the microphone: lifecycle, roster biasing, and the live turn.
//
// Split out of `service-worker.js` because the worker is already long and this is a coherent
// piece with one job. It owns *when* we listen; `offscreen.js` owns *how*.
//
// **The turn lives in memory and nowhere else.** Not `chrome.storage.session`, which survives
// this worker's death and would make a transcript outlive the utterance that produced it. If
// MV3 terminates the worker mid-sentence the words are simply gone, which is the right failure
// for something that was never meant to be kept. Only the listening *flag* is persisted, because
// a badge that says we are listening after the worker has died is a lie a user would act on.

import { loadRoster, micGranted } from './storage.js';

const OFFSCREEN_PATH = 'offscreen.html';

/**
 * How hard to lean on roster names, on the spec's 0.0–10.0 scale.
 *
 * **That scale is logarithmic**, which is the whole story. `boost` is roughly the natural log
 * of how many times more likely the page thinks the phrase is than the model does — so the 8
 * this started with, taken from E0 and from the plan's "~8–10", asserted that "Ivan" is about
 * **3,000×** more likely than English says. The recogniser believed it: interim hypotheses came
 * back as "Ivan Ivan Ivan…" thirty-three times over, for an utterance that contained the word
 * once.
 *
 * E0 did not catch it because E0 only read finals, and the final rescoring pass repairs it —
 * "Ivan tell me a joke" arrived perfectly while the interim text was nonsense. Interim results
 * are what the orb will show at E4, so the artefact was always going to surface; it surfaced
 * the first time anything displayed them.
 *
 * 3.0 is ~20×, and is what the spec's own explainer uses for a proper noun. MDN warns that 9
 * and 10 make the engine hear the phrase where it is not, which is exactly what was observed.
 * Biasing is meant to win close calls — "Ivan" over "even" — not to overrule the audio.
 */
const NAME_BOOST = 3;

/** Session keys. Flags only — never text. */
const LISTENING = 'listening';
const BIAS = 'bias';

/**
 * The utterance in progress: `{ text, isFinal, at }`, or null.
 *
 * Module state, so it dies with the worker. Deliberate — see the file header.
 */
let turn = null;

/** The last thing that went wrong, so a popup opened afterwards can say what happened. */
let failure = null;

export function currentTurn() {
  return { turn, failure };
}

// ── The offscreen document ────────────────────────────────────────────────────────────────

/**
 * Guarantees the offscreen document exists, and keeps it.
 *
 * Kept rather than created per turn: `SR.available()` and acquiring the microphone are both
 * on the critical path between pressing the shortcut and being able to speak, and re-paying
 * them every time is latency the user experiences as the product being slow to listen.
 *
 * **Nothing may be sequenced on `createDocument()` resolving.** E0 measured the document
 * reporting for duty *before* that promise settled, so it is not a readiness signal in either
 * direction — hence `tell()` below retries rather than trusting it.
 */
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_PATH),
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'on-device speech recognition for voice input',
    });
  } catch (error) {
    // Two documents cannot coexist, and two calls can race here — a shortcut press while a
    // previous one is still creating. Losing that race means the document exists, which is
    // what we wanted, so it is not a failure.
    if (!String(error?.message ?? error).includes('Only a single offscreen')) throw error;
  }
}

/**
 * Sends one instruction to the offscreen document, retrying once.
 *
 * The retry is for the gap between `createDocument()` resolving and the document's listener
 * being registered — a gap E0's observation says may exist in either direction, and which
 * presents as "Receiving end does not exist" on a document that is about to be perfectly fine.
 */
async function tell(kind, body = {}) {
  await ensureOffscreen();
  try {
    return await chrome.runtime.sendMessage({ kind, ...body });
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return chrome.runtime.sendMessage({ kind, ...body }).catch(() => null);
  }
}

// ── Starting and stopping ─────────────────────────────────────────────────────────────────

/**
 * Names for the recogniser to favour, at a boost that E0 showed biting on three in a row.
 *
 * Built here rather than in the offscreen document because the roster is the worker's
 * business, and reading it there would put a second copy of it in a second context to drift
 * from this one.
 */
async function phrasesForRoster() {
  const stored = (await chrome.storage.session.get(BIAS))[BIAS];
  // Anything that is not a number is the default — including the boolean this key used to
  // hold, which can still be sitting in session storage from before the sweep existed.
  const boost = typeof stored === 'number' ? stored : NAME_BOOST;
  if (boost <= 0) return [];
  const { agents } = await loadRoster();
  return agents.map((agent) => ({ phrase: agent.name, boost }));
}

export async function startListening() {
  // Asked before the recogniser is, because the recogniser's answer to an ungranted microphone
  // is `not-allowed` — a code that also covers a device in use and a policy block. Checking
  // what setup recorded lets the failure name setup, which is the actual fix.
  if (!(await micGranted())) {
    failure = {
      code: 'mic-not-granted',
      message: "The microphone isn't set up yet — finish setup first.",
    };
    await broadcastState();
    return failure;
  }

  turn = null;
  failure = null;
  await chrome.storage.session.set({ [LISTENING]: true });
  await setBadge(true);

  const phrases = await phrasesForRoster();
  // How many names and at what weight — a count and a number, not the names. Paired with the
  // tail measurement below it, this is what makes a boost sweep readable: each turn says what
  // it was listening with before it says how it ended.
  console.info('[openposse] listening —', phrases.length, 'phrases at boost', phrases[0]?.boost ?? 0);
  await tell('openposse.listen.start', { options: { phrases } });
  await broadcastState();
  return null;
}

export async function stopListening() {
  await tell('openposse.listen.stop');
  await settle();
}

export async function toggleListening() {
  return (await isListening()) ? stopListening() : startListening();
}

export async function isListening() {
  return (await chrome.storage.session.get(LISTENING))[LISTENING] === true;
}

/**
 * Sweeps the boost, or turns biasing off entirely.
 *
 * A development handle, not a setting. The plan asks E2 to show `phrases` *demonstrably*
 * helping on "Ivan", and the only way to demonstrate that is to say the same word under
 * different weights and compare what comes back — which is also how 8 was caught being far too
 * high. Session-scoped, so it cannot be left somewhere strange by accident; a browser restart
 * puts it back to `NAME_BOOST`.
 *
 * `false` or `0` → no phrases at all. A number → that boost. Anything else → the default.
 */
export async function setBias(on) {
  const boost = on === false ? 0 : (typeof on === 'number' ? on : NAME_BOOST);
  await chrome.storage.session.set({ [BIAS]: boost });
  return { boost, meaning: boost > 0 ? `~${Math.round(Math.exp(boost))}× more likely` : 'off' };
}

/** Back to not-listening, however we got here. */
async function settle() {
  await chrome.storage.session.set({ [LISTENING]: false });
  await setBadge(false);
  await broadcastState();
}

// ── The badge ─────────────────────────────────────────────────────────────────────────────
//
// The only thing visible while the popup is closed, which is the normal case for a global
// shortcut. It carries *state*, never content — a dot means the microphone is open, and that
// is the one fact someone needs to know without opening anything. The agent initial and the
// error states belong to E9; this is the half that cannot wait, because a microphone you
// cannot tell is open is the kind of thing that ends up in a review.

async function setBadge(listening) {
  try {
    await chrome.action.setBadgeText({ text: listening ? '●' : '' });
    if (listening) await chrome.action.setBadgeBackgroundColor({ color: '#0A84FF' });
  } catch { /* no action on this platform, or the extension is unloading */ }
}

// ── Talking to whoever is watching ────────────────────────────────────────────────────────

/**
 * Tells open surfaces what the loop is doing.
 *
 * Broadcast rather than answered, because the popup opens and closes independently of the turn
 * and there is nobody to answer when the shortcut is what started this.
 */
async function broadcastState() {
  chrome.runtime.sendMessage({
    kind: 'openposse.listen.state',
    listening: await isListening(),
    turn,
    failure,
  }).catch(() => { /* nothing open */ });
}

/**
 * Handles one message from the offscreen document.
 *
 * Returns true if it was ours, so the worker's own router can stop looking.
 */
export function handleOffscreenMessage(message) {
  switch (message?.kind) {
    case 'openposse.heard':
      // Recorded, not relayed. `runtime.sendMessage` from the offscreen document already
      // reaches every extension context, so an open popup has this message before we do —
      // forwarding it would be a second copy of the same words arriving a round trip later, and
      // the surface would render each interim result twice. What is kept here is for a popup
      // opened *after* the turn, which saw none of them.
      turn = { text: message.text, isFinal: message.isFinal, at: Date.now() };
      return true;

    case 'openposse.listen.ended':
      // The numbers E2 exists to produce, so they have to be readable somewhere.
      //
      // Durations are not transcripts, page content or vendor responses — they are diagnostics
      // of exactly the kind the rule carves out. `info` rather than `debug` because `debug` is
      // Verbose level and Chrome DevTools hides that by default: a measurement nobody can find
      // is not a measurement. Both lines come out of this file once the question is settled.
      console.info(
        '[openposse] turn ended — commit', message.commitMs ?? '—',
        'ms after the last interim,', message.tailMs ?? '—', 'ms to end',
      );
      settle();
      return true;

    case 'openposse.listen.failed':
      failure = { code: message.code, message: message.message };
      settle();
      return true;

    case 'openposse.listen.note':
      // `no-speech` is the common one and is not a failure — but it does mean the turn produced
      // nothing, and a surface showing the last thing heard would otherwise keep showing a
      // previous utterance as though it had just been said.
      if (message.note === 'no-speech') { turn = null; failure = { code: 'no-speech', message: "Didn't hear anything." }; }
      return true;

    case 'openposse.listen.started':
    case 'openposse.offscreen.ready':
      return true;

    default:
      return false;
  }
}
