// The microphone's only home.
//
// A service worker has no DOM, so no `SpeechRecognition` and no `getUserMedia`. A content
// script has a DOM but runs at the *page's* origin, which would mean one microphone grant per
// site, lost on every navigation. An offscreen document is the extension's own origin with a
// DOM and no window: one grant, invisible, and it survives tab switches. That is the whole
// reason it exists — and E0 measured that audio genuinely reaches it rather than assuming so,
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
// name, an error code or a duration — except `text`, which goes to exactly one place: a live
// message to whoever is displaying it.

const SR = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
const Phrase = globalThis.SpeechRecognitionPhrase;

/** The live recogniser, or null when not listening. One at a time, always. */
let recognition = null;

// ── The endpointing measurement ───────────────────────────────────────────────────────────
//
// It took three attempts to measure the right interval, and the two failures are worth keeping
// because they share a shape: **both were anchored to result events, and result events are the
// recogniser talking to itself.**
//
// - *last result → `end`* came back 0 ms, twice. Not a finding, an identity: the final result
//   *is* the decision that the turn is over, so the two fire in one task.
// - *last interim → final* came back 0 ms on three turns of four. Also near-tautological —
//   SODA emits its final immediately after its last interim, so this measures dispatch order
//   rather than silence.
//
// What nobody had asked was **when the speaker stopped**, and the API has an event for it.
// `speechend` → final is the wait a person actually experiences between finishing a sentence
// and anything happening, and it is the only one of the three that is about them.
//
// **Whether it fires at all is itself the finding.** Apple's `SpeechDetector` emits nothing in
// practice — measured, recorded in the root CLAUDE.md, and the reason M1 had to endpoint on the
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
 * than quietly using a server — the promise holding, not breaking. Saying "speech recognition
 * failed" there would be true and would teach exactly the wrong thing.
 */
const ERROR_COPY = {
  'not-allowed': "The microphone isn't granted — finish setup and try again.",
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
 * documented, it is also **our endpointer for free** — it decides the utterance is over and
 * fires `end` without being told. M1 had to build `SilenceTimeoutEndpointer` against the
 * absence of transcription activity, because Apple's `SpeechDetector` emitted nothing at all.
 * The plan says to verify this here before porting anything, so `end` reports the gap since the
 * last result: that number is the measurement, and a long tail means the endpointer comes back.
 */
async function start({ phrases = [], lang = 'en-US' } = {}) {
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
          ? 'The speech model has not been downloaded yet — finish setup.'
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
  // have to distinguish. Strictly better than the `contextualStrings` this replaces — that took
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
    send('openposse.listen.ended', {
      cancelled: cancelling,
      tailMs: lastResultAt ? Math.round(performance.now() - lastResultAt) : null,
      // null means `speechend` never fired — the Apple outcome, and a finding in itself.
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
  send('openposse.listen.started', { biased: Boolean(Phrase) && phrases.length > 0 });
}

/**
 * Ends the turn, discarding what was said.
 *
 * `abort()` rather than `stop()`, because the only way to reach this is pressing the shortcut
 * again or clicking the button again — which M1 settled as *cancel*, not *send*. `stop()` would
 * finalise the half-sentence and hand it on to be acted upon, so "never mind" would ask the
 * question anyway. That is the more expensive mistake of the two.
 */
function stop() {
  if (!recognition) return;
  cancelling = true;
  recognition.abort();
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  switch (message?.kind) {
    case 'openposse.listen.start':
      start(message.options).then(() => respond({ ok: true }));
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
// document is now ready" — it has to hear it from here.
send('openposse.offscreen.ready');
