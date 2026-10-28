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

import { loadRoster, micGranted, setMicGranted, voiceSpeed, engineSettings } from './storage.js';
import { channelOf, initialFor } from './channels.js';
import { panel, panelLevel } from './panel.js';
import { beginTurn, trace } from './trace.js';

/**
 * How much of an interim result to show as still-being-revised.
 *
 * The design dims "the last ~9 characters while the user is still speaking", which is a
 * presentational stand-in for confidence rather than a measurement – Web Speech gives one
 * transcript per result and does not say which part it is least sure of.
 */
// Exported so `demo.js` splits committed text from the revising tail with this number rather
// than its own copy of it. A second 9 would look like agreement and drift the first time this
// one is tuned.
export const VOLATILE_TAIL = 9;

const OFFSCREEN_PATH = 'offscreen.html';

/**
 * How hard to lean on roster names, on the spec's 0.0–10.0 scale.
 *
 * **That scale is logarithmic**, which is the whole story. `boost` is roughly the natural log
 * of how many times more likely the page thinks the phrase is than the model does – so the 8
 * this started with, taken from E0 and from the plan's "~8–10", asserted that "Ivan" is about
 * **3,000×** more likely than English says. The recogniser believed it: interim hypotheses came
 * back as "Ivan Ivan Ivan…" thirty-three times over, for an utterance that contained the word
 * once.
 *
 * E0 did not catch it because E0 only read finals, and the final rescoring pass repairs it –
 * "Ivan tell me a joke" arrived perfectly while the interim text was nonsense. Interim results
 * are what the orb will show at E4, so the artefact was always going to surface; it surfaced
 * the first time anything displayed them.
 *
 * 3.0 is ~20×, and is what the spec's own explainer uses for a proper noun. MDN warns that 9
 * and 10 make the engine hear the phrase where it is not, which is exactly what was observed.
 * Biasing is meant to win close calls – "Ivan" over "even" – not to overrule the audio.
 */
const NAME_BOOST = 3;

/** Session keys. Flags only – never text. */
const LISTENING = 'listening';
const BIAS = 'bias';

/**
 * The utterance in progress: `{ text, isFinal, at }`, or null.
 *
 * Module state, so it dies with the worker. Deliberate – see the file header.
 */
let turn = null;

/** The last thing that went wrong, so a popup opened afterwards can say what happened. */
let failure = null;

/**
 * Who gets the finished utterance.
 *
 * A registered callback rather than a direct import, because the thing that acts on a
 * transcript lives in `service-worker.js` and importing it here would make a cycle. This file
 * knows how to listen; it deliberately knows nothing about what listening is *for*.
 */
let turnHandler = null;
export function setTurnHandler(handler) { turnHandler = handler; }

/** True from the moment an utterance is handed on until whatever it started finishes. */
let thinking = null;

/**
 * Set while an answer that ends by asking "would you like to see it?" is being read out.
 *
 * The microphone opens for the reply when the voice has *finished*, never during: there is no
 * echo cancellation, so a microphone open mid-sentence would hear
 * the agent asking and take that as the reply.
 */
let awaitingReply = false;

/** True while the microphone is open for that reply rather than for a turn of its own. */
let replying = false;

/** What was asked, kept while the reply clears it from the panel, so silence can put it back. */
let asked = null;

/** Opens the microphone once for a reply, as soon as what is being said has been said. */
export function listenAfterSpeaking() {
  awaitingReply = true;
}

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
 * direction – hence `tell()` below retries rather than trusting it.
 */
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_PATH),
      // Both, because this document now does both. `AUDIO_PLAYBACK` is what keeps it alive
      // while an answer is being read out – an offscreen document whose stated reason has
      // finished is a candidate for closing, and losing it mid-sentence would cut the agent off.
      reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: 'on-device speech recognition and speaking answers aloud',
    });
  } catch (error) {
    // Two documents cannot coexist, and two calls can race here – a shortcut press while a
    // previous one is still creating. Losing that race means the document exists, which is
    // what we wanted, so it is not a failure.
    if (!String(error?.message ?? error).includes('Only a single offscreen')) throw error;
  }
}

/**
 * Sends one instruction to the offscreen document, retrying once.
 *
 * The retry is for the gap between `createDocument()` resolving and the document's listener
 * being registered – a gap E0's observation says may exist in either direction, and which
 * presents as "Receiving end does not exist" on a document that is about to be perfectly fine.
 */
async function tell(kind, body = {}) {
  await ensureOffscreen();
  try {
    return await chrome.runtime.sendMessage({ kind, ...body });
  } catch {
    // The first failure is expected – that is what the retry is for – so it says nothing.
    // The second is not: the offscreen document never received the instruction, which means no
    // listening, or no speech, with nothing anywhere to say so.
    await new Promise((resolve) => setTimeout(resolve, 60));
    return chrome.runtime.sendMessage({ kind, ...body }).catch((error) => {
      console.warn(`[openposse] offscreen did not receive ${kind} –`, error?.message ?? error);
      return null;
    });
  }
}

// ── Starting and stopping ─────────────────────────────────────────────────────────────────

/**
 * Clears setup's record of the microphone, once Chrome has refused it in the offscreen
 * document. The record is all the panel and onboarding go on, so without this they keep
 * saying "granted" over a microphone that no longer is, and nothing offers to ask again.
 */
function forgetMic() {
  setMicGranted(false).catch((error) =>
    console.warn('[openposse] could not clear the microphone record –', error?.message ?? error));
}

/**
 * Names for the recogniser to favour, at a boost that E0 showed biting on three in a row.
 *
 * Built here rather than in the offscreen document because the roster is the worker's
 * business, and reading it there would put a second copy of it in a second context to drift
 * from this one.
 */
async function phrasesForRoster() {
  const stored = (await chrome.storage.session.get(BIAS))[BIAS];
  // Anything that is not a number is the default – including the boolean this key used to
  // hold, which can still be sitting in session storage from before the sweep existed.
  const boost = typeof stored === 'number' ? stored : NAME_BOOST;
  if (boost <= 0) return [];
  const { agents } = await loadRoster();
  return agents.map((agent) => ({ phrase: agent.name, boost }));
}

/**
 * Opens the microphone for a turn, or with `reply` for the answer to an offer.
 *
 * **A reply keeps the answer on screen**, because the answer is what the question was about.
 * Only the line for what is being said is cleared, so the caret is not drawn after the question
 * that was just answered.
 */
export async function startListening({ reply = false } = {}) {
  // Any turn settles a pending offer: one started by hand supersedes it, and the reply is this.
  awaitingReply = false;
  replying = reply;
  asked = reply ? (turn?.isFinal ? turn.text : null) : null;

  // Asked before the recogniser is, because the recogniser's answer to an ungranted microphone
  // is `not-allowed` – a code that also covers a device in use and a policy block. Checking
  // what setup recorded lets the failure name setup, which is the actual fix.
  if (!(await micGranted())) {
    failure = {
      code: 'mic-not-granted',
      message: "The microphone isn't set up yet – finish setup first.",
    };
    // The design's dead-mic state, driven by a real signal rather than a synthetic one: an
    // ungranted microphone shows as dead, never as a healthy idle orb.
    await panel({
      phase: 'not-capturing', transcript: '', volatile: '', answer: '',
      message: '', agentName: null, channel: null,
    }, { create: true });
    await broadcastState();
    return failure;
  }

  turn = null;
  failure = null;
  // Starting a turn stops whatever is being read out. Barge-in's cheap half: the microphone is
  // about to open, and an agent still talking would be heard by it – and speaking over someone
  // who has just pressed the key to interrupt is the rudest thing this could do.
  await tell('openposse.hush');
  await chrome.storage.session.set({ [LISTENING]: true });
  await setBadge('listening');
  // Before the panel's state, not after, so the listening state and the turn never disagree,
  // one saying "Didn't hear anything" while the other says "Listening".
  await broadcastState();
  // `create` gives the panel the roster and the shortcut. Everything after this is a merge onto
  // that state, so a turn never has to restate them.
  await panel(reply
    ? { phase: 'listening', transcript: '', volatile: '', message: '' }
    : {
      phase: 'listening',
      transcript: '', volatile: '', answer: '', sub: '', message: '',
      agentName: null, channel: null,
    }, { create: !reply });

  const phrases = await phrasesForRoster();
  // How many names and at what weight – a count and a number, not the names. Paired with the
  // tail measurement below it, this is what makes a boost sweep readable: each turn says what
  // it was listening with before it says how it ended.
  beginTurn(reply ? 'reply to the offer' : 'turn');
  trace('listening', `${phrases.length} phrases at boost ${phrases[0]?.boost ?? 0}`);
  // The engine settings travel with it because listening is when the offscreen document warms
  // the voice, and it cannot read storage to find out which voice that is.
  await tell('openposse.listen.start', { options: { phrases }, engine: await engineSettings() });
  await broadcastState();
  return null;
}

/**
 * Says an answer out loud, in that agent's voice.
 *
 * The whole roster's voice hints travel with it, because distinctness is a property of the
 * *set* – `assignVoices` has to see everyone to guarantee two agents never sound alike, and
 * the offscreen document is where the voice list lives.
 */
export async function say(text, agentID) {
  const { agents } = await loadRoster();
  await tell('openposse.speak', {
    text,
    agentID,
    roster: agents.map((a) => ({ id: a.id, voice: a.voice })),
    // Read per answer rather than cached, so a change in Settings takes on the next thing
    // spoken. An MV3 worker is torn down every 30 s anyway, which makes a cache here a thing
    // that is sometimes stale and sometimes not – the worst of both.
    speed: await voiceSpeed(),
    // Which engine is preferred and whether Supertonic's licence is agreed to, for the same
    // reason and read the same way.
    engine: await engineSettings(),
  });
}

/**
 * Loads the voice while a turn that never opens the microphone is still being answered – a typed
 * question, or the demo. A spoken turn needs no call: the offscreen document warms as it starts
 * listening. Fire and forget; an answer that lands first just waits out the load, as before.
 */
export function warmVoice() {
  engineSettings().then((engine) => tell('openposse.voice.warm', { engine })).catch((error) => {
    console.warn('[openposse] the voice could not be warmed –', error?.message ?? error);
  });
}

/** Holds whatever is being read out, mid-word. The demo's Pause; a real turn has none. */
export function pauseVoice() {
  tell('openposse.voice.pause').catch((error) => {
    console.warn('[openposse] the voice could not be paused –', error?.message ?? error);
  });
}

export function resumeVoice() {
  tell('openposse.voice.resume').catch((error) => {
    console.warn('[openposse] the voice could not be resumed –', error?.message ?? error);
  });
}

/**
 * Speaks a sample for Settings, down the same path an answer takes.
 *
 * **Settings used to speak for itself, and that is what this replaces.** It called Kokoro
 * directly, which is the only engine a page can address a specific voice on – so the pace
 * preview worked on the machines that had downloaded 340 MB and was a dead button on every
 * other, which is to say on exactly the machines whose owner was deciding whether to.
 *
 * Going through here fixes more than the dead button. A preview is a claim about what answers
 * will sound like, and the only way to make that claim true is to let the same code choose:
 * `chooseEngine` picks the engine, the roster picks the voice, `voiceSpeed` is read from storage
 * rather than passed in from a slider that may not have been saved yet. A preview that picked
 * any of those for itself would be demonstrating something else.
 *
 * `voice` overrides the roster's choice, for the per-voice list where the question really is
 * about one voice. `agents[0]` is the selector otherwise: "what Ivan will sound like" is the
 * question somebody adjusting the pace is asking, and with no agents at all the offscreen
 * document falls back to the first voice it has.
 */
export async function previewVoice(text, voice = null) {
  if (!String(text ?? '').trim()) return { ok: false, reason: 'nothing to say' };
  const { agents } = await loadRoster();
  await tell('openposse.speak', {
    text,
    agentID: agents[0]?.id ?? null,
    roster: agents.map((a) => ({ id: a.id, voice: a.voice })),
    speed: await voiceSpeed(),
    engine: await engineSettings(),
    wanted: voice,
    // Says this is not a turn. The outcome goes back to the page that asked, which is listening
    // for it; nothing here holds a floor or a panel open on its behalf.
    preview: true,
  });
  return { ok: true };
}

/**
 * Says why an answer was not read out.
 *
 * **An answer that silently fails to be spoken is indistinguishable from one that was never
 * meant to be**, and from a muted laptop. The turn still worked – the text is on screen – so
 * there is nothing loud to notice and nothing to search for, which is the worst shape a bug
 * can have.
 *
 * Split in two on purpose. A person only needs telling when there is something they could do
 * about it, and only on the panel they are already looking at; everything else is a code in a
 * console for whoever is debugging. `cancelled` is neither – it is what happens every time
 * somebody interrupts, which is a feature.
 */
const UNSPOKEN_COPY = {
  'no-local-voice': 'No on-device voice is available – the answer is above.',
  'kokoro-not-implemented': 'The neural voice is selected but not installed.',
  'audio-busy': 'Something else is using the audio output.',
  'synthesis-unavailable': 'This browser could not speak the answer.',
  'kokoro-silent-audio': 'The neural voice produced no sound – the answer is above.',
  'phonon-silent-audio': 'The neural voice produced no sound – the answer is above.',
};

function reportUnspoken(reason) {
  if (reason === 'cancelled') return;
  // A reason code, never the text that failed to be spoken.
  console.warn('[openposse] answer was not spoken:', reason ?? 'unknown');
  const copy = UNSPOKEN_COPY[reason];
  if (copy) panel({ sub: copy });
}

/** Stops mid-sentence. Starting a new turn while one is being read out is a cancel. */
export async function hush() {
  await tell('openposse.hush');
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
 * different weights and compare what comes back – which is also how 8 was caught being far too
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
  // Not blindly cleared: the utterance may already have been handed on, and the agent working
  // on it owns the badge now. See `markThinking`.
  await setBadge(thinking ?? 'idle');
  await broadcastState();
}

// ── The badge ─────────────────────────────────────────────────────────────────────────────
//
// The only thing visible while the popup is closed, which is the normal case for a global
// shortcut. It carries *state*, never content – a dot means the microphone is open, an initial
// means that agent is working on something. Those are the two facts someone needs without
// opening anything, and a microphone you cannot tell is open is the kind of thing that ends up
// in a review.
//
// The initial in the agent's own channel colour is the plan's E9 design, arriving early because
// E3 already knows which agent it is and inventing a second placeholder would be work.

/** `'●'` blue while listening, the agent's initial in their colour while asking, else nothing. */
async function setBadge(state) {
  const look = state === 'listening' ? { text: '●', color: '#0A84FF' }
    // The colour the caller passed, which is the one the agent keeps. Re-derived from the name
    // only if a caller did not, because the name alone no longer decides it.
    : state?.agentName ? {
      text: initialFor(state.agentName),
      color: state.channel ?? channelOf({ name: state.agentName }),
    }
      : state === 'problem' ? { text: '!', color: '#FF453A' }
        : { text: '', color: '#0A84FF' };
  try {
    await chrome.action.setBadgeText({ text: look.text });
    if (look.text) await chrome.action.setBadgeBackgroundColor({ color: look.color });
  } catch { /* no action on this platform, or the extension is unloading */ }
}

/**
 * Claims the badge for an agent that is working, or hands it back.
 *
 * **It must be claimed synchronously from the turn handler**, because `end` follows the final
 * result within a millisecond and `settle()` would otherwise clear a badge the ask had just
 * set. `settle` checks this flag rather than blindly clearing, which is why the flag exists at
 * all rather than the ask simply calling `setBadge` itself.
 */
export function markThinking(agentName, channel = null) {
  thinking = agentName ? { agentName, channel } : null;
  setBadge(thinking ?? 'idle');
}

export function markDone(problem) {
  thinking = null;
  setBadge(problem ? 'problem' : 'idle');
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
      // reaches every extension context, so an open popup has this message before we do –
      // forwarding it would be a second copy of the same words arriving a round trip later, and
      // the surface would render each interim result twice. What is kept here is for a popup
      // opened *after* the turn, which saw none of them.
      turn = { text: message.text, isFinal: message.isFinal, at: Date.now() };
      // Committed white, the tail dimmed, and the phase moves to routing the moment it commits
      // – the panel should never show a caret next to text the recogniser has finished with.
      panel(message.isFinal
        ? { phase: 'routing', transcript: message.text, volatile: '' }
        : {
          transcript: message.text.slice(0, -VOLATILE_TAIL),
          volatile: message.text.slice(-VOLATILE_TAIL),
        });
      // Handed on as soon as it is final. The handler reads the roster before it claims the
      // badge, so `end` – a millisecond behind – can still win the race and clear it; the
      // agent's initial then appears a moment later. A flicker, not a wrong state, and worth
      // saying out loud rather than leaving `settle`'s check looking like it guarantees more
      // than it does.
      if (message.isFinal) {
        // Length, not the words. It is the one number that tells a mis-heard fragment from a
        // full sentence when routing then refuses it.
        trace('heard (final)', `${message.text.length} chars`);
        turnHandler?.(message.text, { reply: replying });
      }
      return true;

    case 'openposse.listen.ended':
      // The numbers E2 exists to produce, so they have to be readable somewhere.
      //
      // Durations are not transcripts, page content or vendor responses – they are diagnostics
      // of exactly the kind the rule carves out. `info` rather than `debug` because `debug` is
      // Verbose level and Chrome DevTools hides that by default: a measurement nobody can find
      // is not a measurement. Both lines come out of this file once the question is settled.
      // **"speechend never fired" is only a finding if something was said.** With no results
      // at all there was nothing to end, and blaming the API for a silent room sends the next
      // reader looking for a browser bug – the same shape as the measurements that came back
      // 0 ms and meant nothing.
      trace('recogniser closed',
        message.tailMs == null ? 'nothing was said'
          : message.waitMs != null
            ? `${message.waitMs}ms you-stopped→final, ${message.tailMs}ms final→end`
            // `speechend` fired, but *after* the final result rather than before it – so there
            // is no interval to report and "null ms" is not a measurement. Worth naming rather
            // than papering over: the ordering is not guaranteed, and it means the recogniser
            // sometimes commits before it decides you stopped.
            : message.speechEndFired
              ? `speechend after the final, ${message.tailMs}ms final→end`
              : `speechend never fired, ${message.tailMs}ms final→end`);
      // A reply nobody gave is not a failure. The offer lapses and the panel goes back to how it
      // was before the microphone opened, question and all. A reply that *was* given has already
      // been handed on, and what it started owns the panel now.
      if (replying) {
        replying = false;
        if (!turn?.isFinal) panel({ phase: 'idle', transcript: asked ?? '', volatile: '' });
        asked = null;
      }
      settle();
      return true;

    case 'openposse.listen.failed':
      failure = { code: message.code, message: message.message };
      // The recogniser refused the microphone, so the grant setup recorded is not there any more.
      if (message.code === 'not-allowed') forgetMic();
      settle();
      return true;

    case 'openposse.mic.lost':
      forgetMic();
      return true;

    case 'openposse.listen.note':
      // `no-speech` is the common one and is not a failure – but it does mean the turn produced
      // nothing, and a surface showing the last thing heard would otherwise keep showing a
      // previous utterance as though it had just been said.
      // Not for a reply, though: saying nothing to "would you like to see it?" is an answer.
      if (message.note === 'no-speech') {
        turn = null;
        failure = replying ? null : { code: 'no-speech', message: "Didn't hear anything." };
      }
      return true;

    case 'openposse.speaking':
      // **A Settings preview is not a turn, and must not move anything that belongs to one.**
      // No agent holds the floor, no panel is waiting on it, and `trace`'s clock is measuring
      // from whatever turn last ran – so an orb springing to life while somebody drags a slider
      // would be reporting an answer that nobody asked for. The page that asked is listening
      // for its own result.
      if (message.preview) return true;
      // Renamed, because it was a lie that cost a round trip: this fires *before* the model
      // loads and before a sample is synthesised, so "speaking started … speaking ended
      // +21057ms" looked like twenty-one seconds of audio for twenty words. It is the moment
      // the speaking *path* begins.
      if (message.started) trace('handing to the voice');
      // `audible` is the moment `started` is not: the first sound. Until it arrives the side panel
      // says the voice is warming up, rather than that an agent is speaking over silence.
      if (message.audible) panel({ warming: false });
      // Two engines, two grades of signal, one channel.
      //
      // Kokoro sends a real `level` measured off the audio on its way to the speakers, so the
      // orb follows an answering agent exactly as it follows you. `speechSynthesis` cannot:
      // it renders straight to the device and exposes no audio node, so all it can offer is a
      // word boundary – speech *rate* – which the orb eases between into something that at
      // least moves with the words.
      if (typeof message.level === 'number') panelLevel(message.level);
      else panelLevel(message.pulse ? 0.85 : 0.4);
      return true;

    case 'openposse.spoke':
      if (message.preview) return true;           // see `openposse.speaking` above
      // Drops the orb back to rest.
      // The breakdown the previous version could not show, because it happens in the offscreen
      // document and its console is a different window. Load, synthesis and playback answer
      // three different questions: a cold model, a slow engine, or simply a long answer.
      // Once per engine, and the line that settles the question. `requested` is what we asked
      // for; `providers` is what ONNX Runtime actually bound. The two disagreeing – or a
      // `wasm` in that list – is the whole answer to why synthesis is slow.
      if (message.ms?.backend) {
        const b = message.ms.backend;
        trace('BACKEND',
          `requested ${b.requested ?? '?'} · bound [${(b.providers ?? []).join(', ') || 'not exposed'}] `
          + `· dtype ${b.dtype ?? '?'} · ${b.sessions ?? '?'} sessions · gpu: ${b.adapter ?? 'none'}`);
        // Only when the providers could not be read: says where to look rather than repeating
        // that they were not found.
        if (b.error) trace('BACKEND probe failed', b.error);
        else if (!b.providers?.length && b.shape) trace('BACKEND shape', b.shape);
      }
      // **`first word` leads, because it is what is actually waited through.** Synthesis and
      // playback now overlap, so `synth` and `spoke` no longer add up to anything and reading
      // them as two consecutive stages would misstate the turn: `spoke` is the whole speaking
      // period, `synth` a part of it that mostly happens during the rest.
      //
      // `peak` is here because "played for the right number of milliseconds" and "was audible"
      // turned out to be different claims, and only the first was ever measured.
      // **The voice leads, because it is the only identifying fact on the line.** Everything
      // after it describes how the speaking went; this says who did it. Voices are handed out
      // by position, so an agent's voice moves when the roster does – and without this, "it
      // sounds different from last week" has no measurement behind it at all.
      //
      // A voice id is not content. It is the name of a file that ships with the extension.
      trace('voice finished', message.ms
        ? `${message.voice ?? '?'} (${message.engine ?? '?'}) · `
          + `first word ${message.ms.firstWord ?? '?'}ms · `
          + `load ${message.ms.load ?? '?'}ms${message.ms.cold ? ' (cold)' : ''} · `
          + `synth ${message.ms.synth ?? '?'}ms → ${message.ms.audio ?? '?'}ms audio `
          + `in ${message.ms.chunks ?? '?'} chunks at ${message.ms.rate ?? '?'}Hz · `
          + `peak ${message.ms.peak ?? '?'} · spoke ${message.ms.play ?? '?'}ms`
          + (message.ok ? '' : ` · ${message.reason ?? 'failed'}`)
        : `${message.voice ? `${message.voice} (${message.engine ?? '?'}) · ` : ''}`
          + (message.ok ? 'spoken' : (message.reason ?? 'failed')));
      panelLevel(0);
      // A voice that failed or was cancelled before making a sound never sent `audible`.
      // **And the turn is over**, so the status line settles from "is speaking" to the name. Nothing
      // did this before 2026-10-28, so every answer said "is speaking" until the next turn began.
      panel({ warming: false, phase: 'idle', ifPhase: 'answering' });
      if (!message.ok) reportUnspoken(message.reason);
      if (awaitingReply) {
        awaitingReply = false;
        // Only once the question has actually been heard. A voice that failed or was cut off
        // asked nothing, and a microphone opening by itself after that is just a microphone
        // opening by itself.
        if (message.ok && message.reason !== 'cancelled') {
          startListening({ reply: true }).catch((error) => {
            console.warn('[openposse] could not listen for the reply –', error?.message ?? error);
          });
        }
      }
      return true;

    case 'openposse.level':
      // Straight through. Not stored, not logged – it is a fact about the room, and only the
      // orb wants it.
      panelLevel(message.level);
      return true;

    case 'openposse.listen.started':
    case 'openposse.offscreen.ready':
      return true;

    default:
      return false;
  }
}
