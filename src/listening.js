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

/** Boost for roster names, on the spec's 0.0–10.0 scale. E0 used 8 and three names survived. */
const NAME_BOOST = 8;

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
  const biasOn = (await chrome.storage.session.get(BIAS))[BIAS] !== false;
  if (!biasOn) return [];
  const { agents } = await loadRoster();
  return agents.map((agent) => ({ phrase: agent.name, boost: NAME_BOOST }));
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
  await tell('openposse.listen.start', { options: { phrases: await phrasesForRoster() } });
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
 * Turns roster biasing off, to see what it was doing.
 *
 * A development handle, not a setting. The plan asks E2 to show `phrases` *demonstrably*
 * helping on "Ivan", and the only way to demonstrate that is to say the same word twice with
 * the bias on and off and compare what comes back. Session-scoped, so it cannot be left off by
 * accident — a browser restart puts it back.
 */
export async function setBias(on) {
  await chrome.storage.session.set({ [BIAS]: on !== false });
  return { bias: on !== false };
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
      // The one number E2 exists to produce, so it has to be readable somewhere.
      //
      // A duration is not a transcript, page content or a vendor response — it is diagnostics
      // of exactly the kind the rule carves out, and it says whether Chrome's recogniser closes
      // a turn by itself or whether `SilenceTimeoutEndpointer` has to be ported. Logged once
      // per turn at debug level, and it comes out of this file when the question is settled.
      if (message.tailMs != null) {
        console.debug('[openposse] turn ended', message.tailMs, 'ms after the last result');
      }
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
