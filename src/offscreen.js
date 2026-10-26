// The microphone's only home.
//
// A service worker has no DOM, so no `SpeechRecognition` and no `getUserMedia`. A content
// script has a DOM but runs at the *page's* origin, which would mean one microphone grant per
// site, lost on every navigation. An offscreen document is the extension's own origin with a
// DOM and no window: one grant, invisible, and it survives tab switches. That is the whole
// reason it exists – and E0 measured that audio genuinely reaches it rather than assuming so,
// because the reports of speech recognition failing here are real and concern the *network*
// recogniser.
//
// **It decides nothing.** The phrases to bias on arrive in the start message rather than being
// read from storage here, so this file holds no opinion about who the agents are and no second
// copy of the roster to drift from the worker's. It is a recogniser with a remote control.
//
// **Transcript text passes through and is never written down.** Not to the console, not to
// storage, not to an error string. The E0 spike logged what it heard and said in a comment why
// it was allowed to; this is shipping code and is not. Everything reported here is a state
// name, an error code or a duration – except `text`, which goes to exactly one place: a live
// message to whoever is displaying it.

import { assignVoices, localVoices, offeredVoices } from './voices.js';
import {
  chooseEngine, hasWebGPU, assignKokoroVoices, KOKORO_VOICES,
  assignSupertonicVoices, SUPERTONIC_VOICES, supertonicLanguage,
} from './tts.js';
import { weightsStatus, SUPERTONIC } from './weights.js';
import * as kokoro from './kokoro.js';
import * as supertonic from './supertonic.js';

const SR = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
const Phrase = globalThis.SpeechRecognitionPhrase;

/** The live recogniser, or null when not listening. One at a time, always. */
let recognition = null;

// ── Loudness ──────────────────────────────────────────────────────────────────────────────
//
// The orb's radius follows the microphone, which is the design's own requirement and the
// reason it gives: **"so a dead mic can never look healthy."** A synthetic amplitude breaks
// that promise in the one case it exists for – a granted, connected, silent microphone draws
// the same confident sphere as a working one, and the person sees a healthy instrument while
// nothing is being heard.
//
// `SpeechRecognition` exposes no level, so this is a second capture of the same device
// alongside it. Guarded end to end: if the graph cannot be built, the orb falls back to the
// synthetic amplitude rather than the turn failing. Losing the meter costs a nicety; losing
// recognition costs the product.
//
// An RMS figure is a number about a room, not a transcript. It is never stored or logged.

/** ~20 Hz. The orb runs at 60 and eases between these, so more would be spent on messaging. */
const LEVEL_MS = 50;

/** One-pole smoothing, `1 − e^(−dt/τ)`, with the design's 80 ms attack and 250 ms release. */
const ATTACK = 1 - Math.exp(-LEVEL_MS / 80);
const RELEASE = 1 - Math.exp(-LEVEL_MS / 250);

let meter = null;
let level = 0;

async function startMeter() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);

    const buf = new Float32Array(analyser.fftSize);
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);

      // Decibels, not raw RMS. Loudness is perceived logarithmically, and a linear gain either
      // pins a loud voice at the ceiling or leaves a quiet one indistinguishable from silence.
      // −55 dB is a quiet room, −10 dB is someone speaking up.
      const db = 20 * Math.log10(Math.max(rms, 1e-6));
      const target = Math.min(1, Math.max(0, (db + 55) / 45));

      // Fast to rise, slow to fall – so a consonant registers and the orb does not flicker
      // between syllables.
      level += (target - level) * (target > level ? ATTACK : RELEASE);
      send('openposse.level', { level: Math.round(level * 1000) / 1000 });
    }, LEVEL_MS);

    meter = { ctx, stream, timer };
  } catch (error) {
    // No meter. The panel falls back to the synthetic amplitude, which is where it started – but
    // **the fallback is invisible**, so without this "the orb does not follow my voice" has
    // four possible causes and no way to tell them apart: a refused second capture, a blocked
    // AudioContext, an autoplay policy, or the orb simply being wrong.
    console.warn('[openposse] no level meter –', error?.message ?? error);
    meter = null;
    // Refused here means the grant setup recorded is gone – "Allow this time" ends with its
    // tab, and this document has no UI to ask again in, so Chrome dismisses the prompt (the
    // owner's report of 2026-10-26). The worker clears the record, so setup asks again.
    if (error?.name === 'NotAllowedError') send('openposse.mic.lost', { reason: error.message });
  }
}

function stopMeter() {
  if (!meter) return;
  clearInterval(meter.timer);
  for (const track of meter.stream.getTracks()) track.stop();
  meter.ctx.close().catch(() => {});
  meter = null;
  level = 0;
}

// ── The endpointing measurement ───────────────────────────────────────────────────────────
//
// It took three attempts to measure the right interval, and the two failures are worth keeping
// because they share a shape: **both were anchored to result events, and result events are the
// recogniser talking to itself.**
//
// - *last result → `end`* came back 0 ms, twice. Not a finding, an identity: the final result
//   *is* the decision that the turn is over, so the two fire in one task.
// - *last interim → final* came back 0 ms on three turns of four. Also near-tautological –
//   SODA emits its final immediately after its last interim, so this measures dispatch order
//   rather than silence.
//
// What nobody had asked was **when the speaker stopped**, and the API has an event for it.
// `speechend` → final is the wait a person actually experiences between finishing a sentence
// and anything happening, and it is the only one of the three that is about them.
//
// **Whether it fires at all is itself the finding.** Apple's `SpeechDetector` emits nothing in
// practice – measured on macOS 26.6 for the Mac app, and the reason M1 had to endpoint on the
// absence of transcription instead. A `null` here is the same answer from a different vendor,
// and E4's orb needs it either way: "the speaker stopped" is what moves it from listening to
// thinking, and without the event that transition has to be inferred all over again.

let lastResultAt = 0;
let speechEndAt = 0;
let waitMs = null;

/** Set while we are deliberately stopping, so the resulting `end` does not read as a surprise. */
let cancelling = false;

const send = (kind, body = {}) =>
  chrome.runtime.sendMessage({ kind, ...body }).catch(() => {
    // Nobody listening. The worker may have been terminated between our last result and this
    // one; it will be woken by the next message that matters, and a dropped state note is not
    // worth failing a turn over.
  });

/**
 * Plain sentences for the spec's error codes, because they need different actions.
 *
 * `service-not-allowed` is the interesting one and deliberately does not read as a fault. It
 * means we demanded on-device recognition and Chrome could not supply it, so it refused rather
 * than quietly using a server – the promise holding, not breaking. Saying "speech recognition
 * failed" there would be true and would teach exactly the wrong thing.
 */
const ERROR_COPY = {
  'not-allowed': "The microphone isn't granted – finish setup and try again.",
  'service-not-allowed':
    'On-device recognition was unavailable, so nothing was sent anywhere. '
    + 'Check the speech model in setup.',
  'audio-capture': 'No microphone was found.',
  'no-speech': "Didn't hear anything.",
  'network': 'Recognition asked for the network, which OpenPosse does not allow.',
  'aborted': 'Stopped.',
  'language-not-supported': 'That language has no on-device model.',
};

/**
 * Starts one turn.
 *
 * `continuous = false` is the push-to-talk shape and, if Chrome's recogniser behaves as
 * documented, it is also **our endpointer for free** – it decides the utterance is over and
 * fires `end` without being told. M1 had to build `SilenceTimeoutEndpointer` against the
 * absence of transcription activity, because Apple's `SpeechDetector` emitted nothing at all.
 * The plan says to verify this here before porting anything, so `end` reports the gap since the
 * last result: that number is the measurement, and a long tail means the endpointer comes back.
 */
async function start({ phrases = [], lang = 'en-US' } = {}, engineSettings = null) {
  if (!SR) {
    send('openposse.listen.failed', {
      code: 'no-api',
      message: 'This Chrome has no speech recognition.',
    });
    return;
  }
  if (recognition) return;                    // already listening; a second press stops it

  const options = { langs: [lang], processLocally: true };
  try {
    const state = await SR.available(options);
    if (state !== 'available') {
      // Deliberately not installed from here. `install()` can be a several-minute download
      // with no surface to show progress on, and starting one invisibly because somebody
      // pressed a hotkey is the wrong answer. Setup owns that step and has a page to show it in.
      send('openposse.listen.failed', {
        code: `model-${state}`,
        message: state === 'downloadable'
          ? 'The speech model has not been downloaded yet – finish setup.'
          : 'On-device speech recognition is switched off in this Chrome.',
      });
      return;
    }
  } catch (error) {
    send('openposse.listen.failed', { code: 'availability-threw', message: error.message });
    return;
  }

  const listener = new SR();
  listener.lang = lang;
  listener.continuous = false;
  listener.interimResults = true;

  // The hard requirement, and the reason this product can promise what it promises. The default
  // is `false`, which lets Chrome choose, which can mean Google's servers. Setting it true makes
  // local a *requirement*: the spec's answer to "local is unavailable" becomes an error event
  // rather than a silent fall back to the cloud, which is exactly the failure mode to want.
  listener.processLocally = true;

  // Layer 1 of routing, and the cheapest: bias the recogniser toward the names it is about to
  // have to distinguish. Strictly better than the `contextualStrings` this replaces – that took
  // a bare list, this takes a weight per phrase. Guarded because a shape change here must not
  // cost us the turn; unbiased recognition still works, it is just more likely to hear "Ivor".
  if (Phrase && phrases.length > 0) {
    try {
      listener.phrases = phrases.map(({ phrase, boost }) => new Phrase(phrase, boost));
    } catch {
      send('openposse.listen.note', { note: 'phrases-rejected' });
    }
  }

  listener.addEventListener('result', (event) => {
    const last = event.results[event.results.length - 1];
    const now = performance.now();
    lastResultAt = now;
    if (last.isFinal && speechEndAt) waitMs = Math.round(now - speechEndAt);

    // The one place transcript text is allowed to go: straight to whoever is showing it.
    send('openposse.heard', { text: last[0].transcript, isFinal: last.isFinal });
  });

  // The moment the recogniser believes you stopped talking. Everything after this is it
  // deciding, which is the only part of the wait we could ever do something about.
  listener.addEventListener('speechend', () => { speechEndAt = performance.now(); });

  listener.addEventListener('error', (event) => {
    // `no-speech` and `aborted` are ordinary ends to a turn, not faults. Reporting them through
    // the failure channel would put "Didn't hear anything" in the same place as a broken
    // microphone, and they call for completely different reactions.
    const ordinary = event.error === 'no-speech' || event.error === 'aborted';
    send(ordinary ? 'openposse.listen.note' : 'openposse.listen.failed', {
      code: event.error,
      note: event.error,
      message: ERROR_COPY[event.error] ?? `Speech recognition stopped: ${event.error}.`,
    });
  });

  listener.addEventListener('end', () => {
    recognition = null;
    // Released with the turn. Holding the device would light the recording indicator for no
    // reason, and a meter nothing is reading is a microphone held open for nothing.
    stopMeter();
    send('openposse.listen.ended', {
      cancelled: cancelling,
      tailMs: lastResultAt ? Math.round(performance.now() - lastResultAt) : null,
      // null means `speechend` never fired – the Apple outcome, and a finding in itself.
      waitMs,
      speechEndFired: Boolean(speechEndAt),
    });
    cancelling = false;
  });

  try {
    listener.start();
  } catch (error) {
    send('openposse.listen.failed', { code: 'start-threw', message: error.message });
    return;
  }

  recognition = listener;
  lastResultAt = 0;
  speechEndAt = 0;
  waitMs = null;
  startMeter();

  // Loads the model while the turn is still happening, so the ~1.7 s never lands on the answer.
  warmVoice(engineSettings);
  send('openposse.listen.started', { biased: Boolean(Phrase) && phrases.length > 0 });
}

/**
 * Ends the turn, discarding what was said.
 *
 * `abort()` rather than `stop()`, because the only way to reach this is pressing the shortcut
 * again or clicking the button again – which M1 settled as *cancel*, not *send*. `stop()` would
 * finalise the half-sentence and hand it on to be acted upon, so "never mind" would ask the
 * question anyway. That is the more expensive mistake of the two.
 */
function stop() {
  if (!recognition) return;
  cancelling = true;
  recognition.abort();
}

// ── Speaking ──────────────────────────────────────────────────────────────────────────────
//
// Here rather than in the worker for the same reason the microphone is: a service worker has no
// DOM and therefore no `speechSynthesis`. Here rather than in the page for a better one – an
// utterance started in a tab is cancelled when that tab navigates or closes, and the whole
// point of this product is that you can ask a question and then look at something else.

/**
 * `getVoices()` is empty until the engine has enumerated, and on a cold start that is *after*
 * the first call returns. Waiting on `voiceschanged` once is the difference between an agent
 * having a voice and everybody getting the browser default on the first answer of a session.
 */
function voices() {
  const now = speechSynthesis.getVoices();
  if (now.length > 0) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    // Some builds never fire it when there is genuinely nothing to report.
    setTimeout(done, 1000);
  });
}

/**
 * Whether Kokoro's weights are actually present.
 *
 * Reads the local store rather than the bundle: the weights are downloaded from setup, once,
 * verified, and kept – so "is this machine ready" is a question about what has been installed
 * and not about what shipped. It answers correctly before the download and after it, with
 * nothing to remember to flip.
 */
async function hasKokoroAssets() {
  return (await weightsStatus()).state === 'ready';
}

/**
 * Decided per turn rather than cached: a GPU can be lost, and assets can be added.
 *
 * @param settings  `{ preference, agreement }` from `engineSettings()` in storage.js, sent with
 *                  the message because this document cannot read storage. Missing means no
 *                  agreement, so Supertonic is not chosen: the safe reading of an older sender.
 */
async function engine(settings = null) {
  return chooseEngine({
    hasWebGPU: await hasWebGPU(),
    hasKokoroAssets: await hasKokoroAssets(),
    hasSupertonicAssets: (await SUPERTONIC.status()).state === 'ready',
    agreement: settings?.agreement ?? null,
    preference: settings?.preference ?? 'auto',
  });
}

/**
 * The two neural engines, by the name `chooseEngine` gives them, each with its voices and the way
 * it hands them out. `speak` and the warm-up treat them alike from here on.
 */
const NEURAL = {
  kokoro: { module: kokoro, voices: KOKORO_VOICES, assign: assignKokoroVoices },
  supertonic: { module: supertonic, voices: SUPERTONIC_VOICES, assign: assignSupertonicVoices },
};

/**
 * Frees Supertonic's graphs when another engine has been chosen, so a change of engine in
 * Settings does not leave two models on the GPU. Kokoro's lives in its own worker and is not
 * unloaded, as before. A no-op when Supertonic never loaded.
 */
function release(chosen) {
  if (chosen === 'supertonic') return;
  supertonic.unload().catch((error) => {
    console.warn('[openposse] Supertonic could not be unloaded –', error?.message ?? error);
  });
}

/**
 * Loads Kokoro before an answer needs it. Asked for by a spoken turn as listening starts, and by
 * the worker as a typed turn or the demo starts – neither opens the microphone, so neither would
 * reach the first, and both used to wait out the whole load after the answer had landed.
 *
 * Not awaited and not reported: if it fails, the speaking path will say so with a reason, and a
 * warm-up complaining before anything needs it would be noise.
 */
function warmVoice(settings) {
  engine(settings).then(({ engine: chosen }) => {
    release(chosen);
    NEURAL[chosen]?.module.warm();
  });
}

// `speed` arrives with the message rather than being read from storage here, for the same
// reason `roster` does: this document is handed everything it needs and keeps no copy of
// anything that can change behind its back.
//
// **`wanted` and `preview` are what Settings adds, and neither forks the engine choice.** That
// is the point of routing a preview through here rather than letting Settings speak for itself:
// a preview that picked its own engine would demonstrate an engine nobody's answers use, and the
// one person it would mislead is exactly the person previewing – somebody deciding whether to
// spend 340 MB.
//
// - `wanted` names a voice outright, for the Settings list, where the question is "what does
//   *this* one sound like" rather than "what will Ivan sound like". It is checked against what
//   is actually available rather than trusted, so a stale id falls back instead of failing.
// - `preview` is a label, not behaviour. It travels back out on `openposse.speaking` and
//   `openposse.spoke` so the worker can tell a preview from a turn – no floor is held, no panel
//   is waiting, and `trace`'s clock belongs to whatever turn last ran.
async function speak({
  text, agentID, roster = [], speed = 1, wanted = null, preview = false, engine: settings = null,
}) {
  if (!text) return;
  speechSynthesis.cancel();                 // never two agents at once
  // `cancel` leaves a paused synthesizer paused, by the spec, so an answer queued after the demo
  // was paused would wait, silent, for a resume that is never coming.
  speechSynthesis.resume();
  kokoro.cancel();
  supertonic.cancel();

  // The fork. `chooseEngine` routes to Supertonic or Kokoro when WebGPU and that engine's weights
  // are present (and, for Supertonic, its licence agreed to), and to the system voices otherwise.
  const { engine: chosen } = await engine(settings);
  release(chosen);
  const neural = NEURAL[chosen];
  if (neural) {
    // **Passed explicitly even though every voice now ships**, because the argument is about
    // which question is being asked rather than about the answer being different today. What is
    // downloadable and what is downloaded are separate facts, and `weights.js` is the one that
    // knows the second. When Kokoro's were six and 28, taking the default handed a third British
    // agent `bf_isabella` – a file the shim would refuse, correctly, three layers from anything
    // that could explain it. Naming the source keeps that true for whatever the next subset is.
    const installed = neural.voices;
    // A named voice wins, but only if it is one of this engine's installed ones. An id from a
    // stale Settings page, or one of the other engine's, would otherwise reach an engine that
    // has no such file, three layers from anything that could explain it.
    const named = installed.some((v) => v.id === wanted) ? wanted : null;
    const voice = named ?? neural.assign(roster, installed).get(agentID) ?? installed[0]?.id;
    send('openposse.speaking', { started: true, preview });
    const result = await neural.module.speak(text, voice, {
      // A real amplitude, on the same channel the microphone uses – so the orb follows an
      // answering agent exactly as it follows you. The system-voice path can only send
      // `pulse`, because `speechSynthesis` exposes no audio to measure.
      onLevel: (level) => send('openposse.speaking', { level }),
      // The first sound, which `started` above is not: that fires before the model has loaded.
      onStart: () => send('openposse.speaking', { audible: true, preview }),
      speed,
      // Supertonic's alone: Kokoro is English and ignores it.
      lang: supertonicLanguage(settings?.language),
    });

    // **No silent fall-through to the system voices.** Getting the other voices when a neural
    // engine fails would be a quieter failure than it deserves: somebody who downloaded hundreds
    // of megabytes for better voices and is hearing the old ones needs telling, not soothing. The
    // reason reaches the console and, where it is actionable, the panel.
    //
    // **The voice travels with the result**, which it did not, and the omission cost a round.
    // Everything about *how* the speaking went was reported – load, synthesis, duration, peak –
    // and the one thing identifying *who* spoke was dropped on the floor, two lines after being
    // computed. Voices are handed out by position, so an agent's voice changes when the roster
    // does; without this, "is this the voice it used last week" is unanswerable from the log,
    // and the answer to "why does it sound different" is a shrug.
    send('openposse.spoke', { ...result, engine: chosen, voice, preview });
    return;
  }

  const available = await voices();
  if (available.length === 0) {
    // Nothing at all, rather than nothing *local*. A different problem with a different fix,
    // and reporting both as "no local voice" would send someone to check a setting that is
    // not the one at fault.
    send('openposse.spoke', { ok: false, reason: 'synthesis-unavailable', preview });
    return;
  }

  // Assigned from the offered voices only – on a Mac, the four the user chose – so an assistant
  // never lands on a voice the Settings picker would not have let anybody choose.
  const offered = offeredVoices(available);
  const assigned = assignVoices(roster, offered);
  // **An empty roster is not a missing voice, and only a preview can tell the difference.**
  // During a turn there is always an agent, so `assigned.get(agentID)` coming back empty means
  // nothing local matched and refusing is right. A preview can be asked for before anybody has
  // recorded an assistant, where there is nothing to assign *from* – and answering "no local
  // voice" would send somebody to check a speech setting that is working perfectly.
  const local = localVoices(available);
  // A voice named by Settings' system list wins, matched against the *local* voices only, so an
  // id that is stale – or one of Kokoro's, left over from that list – falls back rather than
  // reaching a remote voice.
  const named = local.find((v) => v.voiceURI === wanted) ?? null;
  const voice = named ?? assigned.get(agentID) ?? (preview ? offered[0] ?? null : null);

  const utterance = new SpeechSynthesisUtterance(text);
  // No voice means nothing local could be found. Speaking anyway would use the browser default,
  // which may be a network voice – the exact thing `localVoices` exists to prevent – so this
  // stays silent and says why. A missing voice is a setup problem, not a reason to leak.
  if (!voice) {
    send('openposse.spoke', { ok: false, reason: 'no-local-voice', preview });
    return;
  }
  utterance.voice = voice;
  utterance.lang = voice.lang;
  // The same number Kokoro gets, because both are 1-is-normal and both stretch time without
  // moving pitch. Which engine is speaking depends on whether the weights downloaded, and that
  // is not something anyone should have to think about while setting how fast they are read to.
  utterance.rate = speed;

  // The orb's `agent` mode, driven by a real signal rather than a synthetic one – though a
  // coarser signal than the microphone's. `speechSynthesis` renders straight to the output
  // device and exposes no audio node, so there is no amplitude to read; `boundary` fires per
  // word, which is speech *rate* rather than loudness. It is honestly synchronised with what is
  // being said, which is what the orb is for, and E6's own audio can be metered properly.
  utterance.addEventListener('boundary', () => send('openposse.speaking', { pulse: true, preview }));
  utterance.addEventListener('start', () => send('openposse.speaking', { started: true, audible: true, preview }));
  // Named here too, for the same reason as the Kokoro path above – and because "which engine"
  // and "which voice" are one question. A log line that answers it for one path and not the
  // other is worse than one that answers neither: it reads as the system path having no voice.
  utterance.addEventListener('end', () => send('openposse.spoke', { ok: true, engine: 'system', voice: voice.name, preview }));
  utterance.addEventListener('error', (event) => {
    // `interrupted` and `canceled` are us stopping it on purpose, not faults.
    const ours = event.error === 'interrupted' || event.error === 'canceled';
    send('openposse.spoke', { ok: ours, reason: ours ? 'cancelled' : event.error, engine: 'system', preview });
  });

  speechSynthesis.speak(utterance);
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  switch (message?.kind) {
    case 'openposse.speak':
      speak(message).then(() => respond({ ok: true }));
      return true;
    case 'openposse.hush':
      // Both engines, unconditionally. Which one is speaking depends on state this does not
      // have, and stopping the wrong one is worse than stopping one that was already silent.
      speechSynthesis.cancel();
      speechSynthesis.resume();                 // see `speak` – a cancel keeps a pause
      kokoro.cancel();
      supertonic.cancel();
      respond({ ok: true });
      return true;
    case 'openposse.voice.pause':
      // The demo's Pause. Every engine for the same reason as `hush`, and the neural ones hold
      // even if their model is still loading.
      speechSynthesis.pause();
      kokoro.pause();
      supertonic.pause();
      respond({ ok: true });
      return true;
    case 'openposse.voice.resume':
      speechSynthesis.resume();
      kokoro.resume();
      supertonic.resume();
      respond({ ok: true });
      return true;
    case 'openposse.voice.warm':
      warmVoice(message.engine);
      respond({ ok: true });
      return true;
    case 'openposse.engine.query':
      // This document is the only place that can answer for itself – WebGPU and the voice list
      // both live here. The engine settings come with the question, as with everything else.
      engine(message.engine).then(respond);
      return true;
    case 'openposse.listen.start':
      start(message.options, message.engine).then(() => respond({ ok: true }));
      return true;                              // keeps the channel open for the async reply
    case 'openposse.listen.stop':
      stop();
      respond({ ok: true });
      return true;
    case 'openposse.listen.ping':
      respond({ ok: true, listening: Boolean(recognition) });
      return true;
    default:
      return false;
  }
});

// Announced rather than waited for. E0 measured that this document runs *before*
// `createDocument()` resolves in the worker, so the worker cannot treat that promise as "the
// document is now ready" – it has to hear it from here.
send('openposse.offscreen.ready');
