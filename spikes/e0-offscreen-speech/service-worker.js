// Creates the offscreen document and prints what it found.
//
// The service worker cannot do any of this itself — no DOM, so no `getUserMedia` and no
// `SpeechRecognition`. That limitation is the reason the offscreen document exists and the
// reason this spike has to be run rather than reasoned about.

const OFFSCREEN = 'offscreen.html';

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) {
    // Only one offscreen document may exist at a time, so a re-run replaces it. Closing and
    // recreating also re-runs the script, which is what makes the toolbar button repeatable.
    await chrome.offscreen.closeDocument();
  }
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL(OFFSCREEN),
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'on-device speech recognition for the E0 spike',
  });
}

chrome.action.onClicked.addListener(async () => {
  console.info('[e0] ── run ──────────────────────────────────');
  try {
    await ensureOffscreen();
    console.info('[e0] offscreen document created; speak now');
  } catch (error) {
    console.error('[e0] could not create the offscreen document:', error.message);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.kind !== 'e0.report') return;
  const f = message.findings;

  if (message.stage === 'listening') {
    console.info('[e0] listening', {
      availabilityBefore: f.availabilityBefore,
      installed: f.installed,
      availabilityAfter: f.availabilityAfter,
      processLocallyAccepted: f.processLocallyAccepted,
      phrasesSupported: f.phrasesSupported,
      phrasesError: f.phrasesError,
    });
    return;
  }

  if (message.stage === 'interim') {
    console.debug('[e0] interim:', f.heard?.text);
    return;
  }

  if (message.stage === 'final') {
    console.info('[e0] ✅ FINAL:', f.heard?.text);
    return;
  }

  if (f.error) {
    console.error('[e0] ❌', f.error);
  } else {
    console.info('[e0] ended');
  }
});

// A missing permission looks identical to a broken API from inside the offscreen document, so
// say which it is before anyone goes looking in the wrong place.
chrome.runtime.onInstalled.addListener(() => {
  console.info(
    '[e0] loaded. Open the options page and grant the microphone first, '
    + 'then click the toolbar button and speak.'
  );
});
