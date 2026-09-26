// E0 — the whole question, in one file.
//
// Does `SpeechRecognition` with `processLocally = true` work inside an offscreen document?
//
// It matters because the answer decides the shape of V1. If it works, the microphone lives
// invisibly, survives tab switches, and the orb can float over the page exactly as the design
// specifies. If it does not, audio has to live in a side panel — same capability, permanent
// screen width, and a design that no longer floats.
//
// The doubt is documented rather than invented: Chrome's extensions group has reports of
// `webkitSpeechRecognition` misbehaving in offscreen documents, because the *network*
// recogniser expected a real page context. SODA running locally may not care. Nobody has
// written down which, so this finds out.
//
// Secondary question, cheap to ask at the same time: does `phrases` biasing exist and does it
// help on an agent name? E2 depends on it, and `contextualStrings` is the thing it replaces.

const SR = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;

/** Everything learned, reported in one message so the service worker logs a single verdict. */
const findings = {
  constructorPresent: Boolean(SR),
  availabilityBefore: null,
  installed: null,
  availabilityAfter: null,
  phrasesSupported: null,
  processLocallyAccepted: null,
  heard: null,
  error: null,
};

const report = (stage) => {
  chrome.runtime.sendMessage({ kind: 'e0.report', stage, findings }).catch(() => {});
};

async function run() {
  if (!SR) {
    findings.error = 'no SpeechRecognition constructor in an offscreen document';
    return report('done');
  }

  const options = { langs: ['en-US'], processLocally: true };

  try {
    findings.availabilityBefore = await SR.available(options);
    if (findings.availabilityBefore !== 'available') {
      findings.installed = await SR.install(options);
      findings.availabilityAfter = await SR.available(options);
    } else {
      findings.availabilityAfter = 'available';
    }
  } catch (error) {
    findings.error = `available()/install() threw: ${error.name} — ${error.message}`;
    return report('done');
  }

  if (findings.availabilityAfter !== 'available') {
    findings.error = `on-device model not available (${findings.availabilityAfter})`;
    return report('done');
  }

  const recognition = new SR();
  recognition.lang = 'en-US';
  recognition.continuous = false;
  recognition.interimResults = true;

  // The hard requirement. If local recognition cannot be provided the spec says we get an
  // `error` event with code `service-not-allowed` rather than a silent fall back to the
  // cloud — which is exactly the failure mode this product needs it to have.
  try {
    recognition.processLocally = true;
    findings.processLocallyAccepted = recognition.processLocally === true;
  } catch (error) {
    findings.processLocallyAccepted = false;
    findings.error = `processLocally rejected: ${error.message}`;
  }

  // Guarded, because it is the secondary question and a shape mismatch here must not cost us
  // the primary answer.
  try {
    const roster = [['Ivan', 8], ['Andy', 8], ['Priya', 8]];
    recognition.phrases = roster.map(([phrase, boost]) =>
      new globalThis.SpeechRecognitionPhrase(phrase, boost));
    findings.phrasesSupported = recognition.phrases.length === roster.length;
  } catch (error) {
    findings.phrasesSupported = false;
    findings.phrasesError = `${error.name}: ${error.message}`;
  }

  recognition.addEventListener('result', (event) => {
    const last = event.results[event.results.length - 1];
    // Length and finality, not the words — until it is final, at which point the words *are*
    // the finding. A spike is the one place transcript text legitimately reaches a log, and
    // only because there is nothing else to report.
    findings.heard = { text: last[0].transcript, isFinal: last.isFinal };
    report(last.isFinal ? 'final' : 'interim');
  });

  recognition.addEventListener('error', (event) => {
    // `service-not-allowed` here is the interesting failure: it means local was demanded and
    // could not be supplied, which is a different answer from the API not working at all.
    findings.error = `recognition error: ${event.error}`;
    report('done');
  });

  recognition.addEventListener('end', () => report('ended'));

  try {
    recognition.start();
    report('listening');
  } catch (error) {
    findings.error = `start() threw: ${error.name} — ${error.message}`;
    report('done');
  }
}

run();
