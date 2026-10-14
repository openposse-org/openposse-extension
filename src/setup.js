// The three things that have to happen once, and the only page where two of them can.
//
// The microphone prompt and the speech-model download both need a real tab. An offscreen
// document has no UI to show a permission prompt in, and a side panel is documented as failing
// with `NotAllowedError: Permission dismissed` on macOS. This page exists for that reason, not
// for tidiness.

import {
  loadRoster, recipeFor, setMicGranted, micGranted, voiceSpeed, setVoiceSpeed, clampSpeed,
  orbStyle, setOrbStyle, avatarsByCount, setAvatarsByCount, engineSettings,
} from './storage.js';
import { mountThemeToggle, segmented } from './appearance.js';
import { channelOf, colourName, initialFor, PALETTE } from './channels.js';
import { sortedIDs } from './order.js';
import { pack, unpack, toFile, filenameFor, summarise } from './share.js';
import { matchPattern, patternForHost } from './domain.js';
import { FLOOR_MS, FLOOR_OVERRIDE_KEY, FLOOR_RANGE, floorWindow, productLabel } from './routing.js';
import { ANSWER_GRACE_MS, GRACE_OVERRIDE_KEY, GRACE_RANGE, graceWindow } from './grace.js';
import { setSurface } from './surface.js';
import { MOCK_SIZES } from './mocks.js';
import { chooseEngine, describeEngine, hasWebGPU } from './tts.js';
import { offeredVoices } from './voices.js';
import {
  weightsStatus, downloadWeights, removeWeights, ensureAccess, TOTAL_BYTES, VOICES, SUPERTONIC,
} from './weights.js';
import { icon } from './icons.js';
import { ICONS, iconPages, putIcon } from './favicons.js';

const SR = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
const LANGS = { langs: ['en-US'], processLocally: true };

const el = (id) => document.getElementById(id);
/**
 * A step's status, and how it should look: `good` is done, `warn` is something left to do, `bad`
 * is something that went wrong, and nothing is neutral – an optional step left off, or progress.
 * The words carry the same meaning as the colour, for anyone who cannot tell green from amber.
 */
const setStatus = (id, text, tone = '') => {
  el(id).textContent = text;
  el(id).dataset.tone = tone;
};
const markDone = (section, done) => el(section).classList.toggle('done', done);
/** The words of an icon button: its hover label, and what a screen reader says for it. */
const label = (button, text) => button.setAttribute('aria-label', text);
/** Swaps an icon button's glyph in place. */
const glyph = (button, name, size = 15) => button.replaceChildren(icon(name, { size }));

// The page's own icon buttons name their glyph in the markup, `data-icon`, and are drawn from
// icons.js here – the same table the roster's buttons come from, so the geometry has one home.
for (const button of document.querySelectorAll('[data-icon]')) {
  glyph(button, button.dataset.icon, Number(button.dataset.size ?? 15));
}

// ── 1. Microphone ──────────────────────────────────────────────────────────────────────────

/** The one state `permissions.query` is unambiguous about, and the one we cannot fix. */
async function isBlocked() {
  try {
    return (await navigator.permissions.query({ name: 'microphone' })).state === 'denied';
  } catch {
    return false;
  }
}

async function refreshMic() {
  const granted = await micGranted();
  if (granted) {
    setStatus('mic-status', 'granted', 'good');
  } else {
    const blocked = await isBlocked();
    setStatus('mic-status', blocked
      ? 'blocked by Chrome – allow it in this extension’s site settings'
      : 'not granted', blocked ? 'bad' : 'warn');
  }
  markDone('step-mic', granted);
  el('grant-mic').disabled = granted;
  return granted;
}

el('grant-mic').addEventListener('click', async () => {
  setStatus('mic-status', 'asking…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Released at once. The *grant* is what persists; holding the device would light the
    // recording indicator for no reason and worry people.
    for (const track of stream.getTracks()) track.stop();

    // Recorded here because this is the only place that knows. Everywhere else has to infer
    // it from an API that answers `prompt` in three different situations – see `storage.js`.
    await setMicGranted(true);
    await refreshMic();
  } catch (error) {
    await setMicGranted(false);
    setStatus('mic-status', `${error.name} – ${error.message}`, 'bad');
  }
});

// ── 2. Speech model ────────────────────────────────────────────────────────────────────────

async function refreshModel() {
  if (!SR?.available) {
    setStatus('model-status', 'this browser has no on-device speech recognition', 'bad');
    el('install-model').disabled = true;
    return false;
  }
  const state = await SR.available(LANGS);
  const ready = state === 'available';
  const words = { available: 'ready', downloadable: 'not downloaded yet', downloading: 'downloading…' };
  setStatus('model-status', words[state] ?? state, ready ? 'good' : 'warn');
  markDone('step-model', ready);
  el('install-model').disabled = ready || state === 'unavailable';

  if (state === 'unavailable') {
    // Worth separating from "not downloaded yet". This is usually a field trial being off
    // rather than anything the user did, and no amount of clicking Download will fix it.
    setStatus('model-status', 'unavailable – on-device recognition is switched off in this Chrome',
      'bad');
  }
  return ready;
}

el('install-model').addEventListener('click', async () => {
  setStatus('model-status', 'downloading…');
  try {
    await SR.install(LANGS);
  } catch (error) {
    setStatus('model-status', `failed: ${error.message}`, 'bad');
    return;
  }
  await refreshModel();
});

// ── 3. The shortcut ────────────────────────────────────────────────────────────────────────
//
// Here because it cannot be done for them and would otherwise be folklore. A manifest may only
// *suggest* `Ctrl+Shift+[0-9]` for a shortcut that works outside Chrome – but the user's own
// assignment at `chrome://extensions/shortcuts` carries no such restriction, so ⌥V is available
// to anyone who knows the page exists. Telling them beats them not knowing.
//
// A plain link cannot go there: `chrome://` URLs are not navigable from a page, including one
// of ours. `chrome.tabs.create` can.

async function refreshShortcut() {
  const summon = (await chrome.commands.getAll()).find((c) => c.name === 'summon');
  // Deliberately not claiming it is global. Nothing in the API reports that, and saying "press
  // it anywhere" about a Chrome-only binding would be a promise the product cannot keep.
  setStatus('shortcut-status', summon?.shortcut || 'none assigned', summon?.shortcut ? 'good' : 'warn');
  markDone('step-shortcut', Boolean(summon?.shortcut));
}

el('open-shortcuts').addEventListener('click', async () => {
  await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// ── 4. Where the panel may appear ──────────────────────────────────────────────────────────
//
// **A global shortcut and `activeTab` are mutually exclusive**, which is why this exists.
// Chrome grants an extension temporary access to the current tab when the user presses its
// shortcut – but not when that shortcut is marked `global`, because such a command can fire
// while Chrome is in the background and there is no tab the gesture belongs to. Measured, after
// two wrong explanations: the same keypress that works on a vendor's page fails on every other
// with "Cannot access contents of url".
//
// Vendor pages work without this, because a recorded assistant already has a host permission of
// its own. Everything else needs the broad grant or nothing.
//
// Offered rather than asked for at install. The prompt Chrome shows is alarming and it should
// be – this is the biggest thing the extension can ask for – so it belongs behind a sentence
// explaining what it buys and a choice the user makes knowingly.

const ALL_SITES = { origins: ['https://*/*'] };

async function refreshPanelAccess() {
  const granted = await chrome.permissions.contains(ALL_SITES);
  // Off is not a problem to fix – the step is optional – so it is neutral rather than amber.
  setStatus('panel-status', granted
    ? 'on – the orb appears on any page'
    : "off – the orb appears on AI assistants' pages only", granted ? 'good' : '');
  markDone('step-panel', granted);
  el('grant-panel').setAttribute('aria-checked', String(granted));
  return granted;
}

el('grant-panel').addEventListener('click', async () => {
  // Read first, act on the answer: this is a toggle, and `request()` on an already-granted
  // permission resolves true without showing anything, which would make the button dead.
  if (await chrome.permissions.contains(ALL_SITES)) {
    await chrome.permissions.remove(ALL_SITES);
  } else {
    // Not awaited-then-checked before the request: the prompt needs this click to still be
    // Chrome's idea of a user gesture, and the `contains` above is the only hop it can afford.
    await chrome.permissions.request(ALL_SITES);
  }
  await refreshPanelAccess();
});

// ── Which engine speaks ────────────────────────────────────────────────────────────────────
//
// Reported rather than chosen. The decision is made from what the machine can actually do, and
// the value of showing it is that "why does it sound like that" has an answer – a person on a
// browser without WebGPU should be told so, not left to wonder.
//
// The offscreen document is the only context that can answer: WebGPU and the voice list both
// live there, and it is created on demand by the worker.

// **Worked out here rather than asked of the offscreen document.**
//
// The first version messaged that document for the answer, and it usually does not exist –
// it is created when a turn starts, and opening settings is not a turn. So the send threw,
// the catch fell back to the bland "System voices", and the page never showed the *reason*,
// which is the only part worth reading. It looked like the line was not updating.
//
// This page is a Window, so it has `navigator.gpu` and can read the weights itself. Nothing
// about the choice needs a microphone, and asking something that may not be there for an
// answer we can compute was the whole mistake.
async function answeringEngine() {
  return chooseEngine({
    hasWebGPU: await hasWebGPU(),
    hasKokoroAssets: (await weightsStatus()).state === 'ready',
    hasSupertonicAssets: (await SUPERTONIC.status()).state === 'ready',
    // The same preference and agreement every answer is sent with, so this line cannot name an
    // engine the answers would not use.
    ...(await engineSettings()),
  });
}

async function refreshEngine() {
  const choice = await answeringEngine();
  const neural = choice.engine !== 'system';
  // Green for a neural voice; the system voices are the working fallback rather than a fault,
  // so neutral.
  setStatus('engine', describeEngine(choice), neural ? 'good' : '');
  // **Done once something on this machine can speak an answer**: a neural voice, or an on-device
  // system voice. Remote ones sit in the same list and do not count – see the local-only rule in
  // voices.js. The step had no done state at all until 2026-10-06, so it was never green.
  markDone('step-voices', neural
    || speechSynthesis.getVoices().some((voice) => voice.localService));
  refreshSystemVoices(!neural);
  // Each assistant's picker lists this engine's voices, so it redraws with it.
  redrawRoster();
}

// Chrome fills the system voice list after the page asks for it, so the first check can find
// it empty; this runs the check again once it is there.
speechSynthesis.addEventListener('voiceschanged', () => { refreshEngine(); });

// ── The neural voices ──────────────────────────────────────────────────────────────────────
//
// **This button is the amended rule's entire justification, so it has to behave like it.** The
// rule now permits a model download that the user starts, from a pinned URL, verified against a
// hash in the build – and each of those is only true because this page does it that way. A
// download that started itself, or that installed whatever arrived, would make the amendment a
// piece of paperwork.
//
// Sizes are shown before anything is fetched, and progress while it is, because 89 MB on a
// hotel connection is a decision and not a detail.

const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;

async function refreshWeights() {
  const { state, have, want, core, missingBytes } = await weightsStatus();
  const done = state === 'ready';
  el('weights-size').textContent = mb(TOTAL_BYTES);

  el('drop-weights').hidden = !have;
  el('get-weights').hidden = done;
  // **"Resume" is wrong for an install that grew.** Nothing stopped: the voice set went from
  // six to 28, so a complete install is now short some files it never had. `core` distinguishes
  // the two, and the word has to follow – "Resume" and "interrupted" send somebody looking for
  // a failure that did not happen.
  const extending = state === 'partial' && core;
  label(el('get-weights'), extending
    ? 'Download the new voices' : state === 'partial' ? 'Resume the download' : 'Download the voices');
  // Says what is on disk, and nothing about whether it is being used – the engine line above
  // owns that, and this claiming "used whenever WebGPU is available" directly contradicted it
  // while the engine was still unbuilt. One fact, one place.
  // Not downloaded is neutral: the step is optional. Interrupted is amber – something started
  // and did not finish.
  setStatus('weights-status', done
    ? `installed – ${want} files, verified`
    : extending
      ? `${want - have} more voices available · ${mb(missingBytes)}`
      : state === 'partial'
        ? `${have} of ${want} files – interrupted`
        : `not downloaded · ${mb(TOTAL_BYTES)}`,
  done ? 'good' : state === 'partial' && !extending ? 'warn' : '');
  markDone('step-weights', done);
  return state;
}

el('get-weights').addEventListener('click', async () => {
  // First, before any await: `permissions.request` needs this click to still be a live user
  // gesture. HuggingFace redirects to a CDN on another host and neither sends `*` for CORS, so
  // without both origins every file fails with a message that says nothing useful.
  const allowed = await ensureAccess();
  if (!allowed) {
    setStatus('weights-status', 'needs access to huggingface.co to download – not granted', 'warn');
    return;
  }

  el('get-weights').disabled = true;
  setStatus('weights-status', 'starting…');

  // Progress arrives per chunk of the file being fetched, so the line is only rewritten when
  // what it says changes – a whole percent or a whole megabyte.
  let shown = '';
  let result;
  try {
    result = await downloadWeights({
      onProgress: ({ bytes, totalBytes }) => {
        const percent = Math.min(100, Math.floor((bytes / totalBytes) * 100));
        const line = `${percent}% · ${Math.round(bytes / 1e6)} of ${mb(totalBytes)}`;
        if (line === shown) return;
        shown = line;
        setStatus('weights-status', line);
      },
    });
  } catch (error) {
    // A button that does nothing is the worst outcome available, so nothing gets to throw
    // past here silently – the page says what happened and the console says it precisely.
    console.error('[openposse] weights download threw –', error?.message ?? error);
    setStatus('weights-status', `could not start: ${error?.message ?? error}`, 'bad');
    el('get-weights').disabled = false;
    return;
  }
  el('get-weights').disabled = false;

  if (!result.ok) {
    // **The reason, not a count of failures.** The first version said "could not download
    // model, bm_george, … – try again" for every cause there is, and the actual message –
    // which named a CORS refusal – was thrown away by this very line. Listing the files told
    // nobody anything; they had all failed for one reason.
    for (const f of result.failed) console.warn('[openposse] weights:', f.id, '–', f.reason);

    const mismatched = result.failed.filter((f) => f.reason === 'mismatch');
    const reasons = [...new Set(result.failed.map((f) => f.reason))];
    setStatus('weights-status', mismatched.length
      ? `refused: ${mismatched.map((f) => f.id).join(', ')} did not match the expected contents`
      : `${result.failed.length} of ${result.failed.length} failed – ${reasons.join(' · ')}`, 'bad');
    el('drop-weights').hidden = false;
    return;
  }
  await refreshWeights();
  await refreshEngine();
  await refreshVoices();
});

el('drop-weights').addEventListener('click', async () => {
  await removeWeights();
  await refreshWeights();
  await refreshEngine();
});

// ── Pace ───────────────────────────────────────────────────────────────────────────────────
//
// **One number for both engines**, because which of the two is speaking depends on whether a
// 340 MB download finished, and that is not a thing anybody should have to reason about while
// deciding how fast they want to be read to. Kokoro takes it as `speed` through its duration
// predictor; a system voice takes it as `utterance.rate`. Both are 1-is-normal and both stretch
// time without moving pitch.
//
// The slider stops well inside what the engines accept – 0.7 to 1.6 against HeadTTS's 0.25 to 4
// – because the useful range is narrow and a slider spanning the full one makes it a sliver.
// `clampSpeed` still guards the stored value, so a number set by hand outside this remains
// valid rather than being silently rejected by one engine and accepted by the other.

/** The live value, so a preview started from this page speaks at what the slider now says. */
let pace = 1.3;

const showPace = () => { el('speed-value').textContent = `${pace.toFixed(2)}×`; };

async function loadPace() {
  pace = await voiceSpeed();
  el('speed').value = String(pace);
  showPace();
}

// `input` rather than `change`: the number has to track the thumb while it is being dragged, or
// the only feedback is the thumb's own position, which says nothing about what it means.
el('speed').addEventListener('input', () => {
  pace = clampSpeed(el('speed').value);
  showPace();
});

// **Saved on `change`, which fires when the thumb is released.** Writing on every `input` would
// put sixty storage writes into one drag, and each one wakes the service worker through
// `storage.onChanged`.
//
// **It does not speak.** It used to, on the reasoning that pace cannot be judged by reading –
// which is true, and is the argument for *a way* to hear it rather than for hearing it on every
// release. A drag across the slider crosses a dozen values and each release is a separate
// change, so the setting that is hardest to judge was the one that talked back the most. Playing
// is now its own button, below.
el('speed').addEventListener('change', async () => {
  pace = await setVoiceSpeed(el('speed').value);
  showPace();
});

/**
 * The voice the pace sample uses, or null for "nobody has said".
 *
 * Null is a real answer rather than a missing one: with no voice named, the preview goes down
 * the roster's own assignment and you hear what your *assistant* will sound like, which is the
 * question somebody adjusting the pace is actually asking. It becomes a specific voice only once
 * you have picked one, which is when naming it starts being what you meant.
 */
let lastHeardVoice = null;

// ── Previews ───────────────────────────────────────────────────────────────────────────────
//
// **This page does not speak. It asks the worker to.**
//
// It used to call Kokoro directly, which is the only engine a *page* can point at a named voice:
// the system path lives in the offscreen document and picks per agent. So the pace preview
// worked on machines that had downloaded 340 MB and was a dead button on every other one, which
// is to say on exactly the machines whose owner was deciding whether to.
//
// Going through `openposse.voice.preview` fixes more than the dead button, and that is the
// reason it is worth the round trip. A preview is a claim about what answers will sound like,
// and the only way to make the claim true is to let the same code choose: `chooseEngine` picks
// the engine, the roster picks the voice, the pace is read from storage rather than handed over
// from a slider that may not have been saved yet. A preview choosing any of those for itself
// would be demonstrating something else and sounding confident about it.
//
// Two consequences worth stating, because both look like side effects and are the point:
//
// - **Stopping is free.** `speak()` cancels whatever is speaking before it starts, so a second
//   preview silences the first rather than playing over it, and pressing ⌥V silences it too.
// - **It outlives this tab**, since the audio is the offscreen document's rather than this
//   page's. Previously, navigating away mid-sample cut it off.

/** Long enough for a cold Kokoro load, short enough that a lost reply is not a hung button. */
const PREVIEW_PATIENCE_MS = 45_000;

/** Who is waiting on the current preview, so the answer reaches the button that asked. */
let awaiting = null;
let patience = null;

const SPOKEN_PROBLEM = {
  'no-local-voice': 'no local voice is installed for this – check your system speech settings',
  'synthesis-unavailable': 'this browser reported no speech voices at all',
  'no-answer': 'the voice engine did not answer',
  cancelled: 'stopped',
};

/** Hands the outcome to whoever asked, once, and lets the next preview start. */
function settle(outcome) {
  if (!awaiting) return;
  const report = awaiting;
  awaiting = null;
  clearTimeout(patience);
  report(outcome);
}

/**
 * Speaks the sample down the real path and routes the result back to one caller.
 *
 * `report` is called exactly once, with the `openposse.spoke` message or a stand-in carrying the
 * same shape – so a caller never has to tell "it is still synthesising" from "it refused", which
 * is the distinction this page kept losing.
 */
async function playSample({ voice = null, report }) {
  // One at a time. The engines speak one utterance at a time anyway, and two voices over each
  // other tells you nothing about either – but the first caller has to be *told*, or its button
  // sits on "Playing…" while the second one plays.
  settle({ ok: false, reason: 'cancelled' });
  awaiting = report;
  patience = setTimeout(() => settle({ ok: false, reason: 'no-answer' }), PREVIEW_PATIENCE_MS);

  const sent = await chrome.runtime
    .sendMessage({ kind: 'openposse.voice.preview', text: sample(), voice })
    .catch((error) => ({ ok: false, reason: error?.message ?? String(error) }));

  // This only says the instruction was dispatched. The outcome arrives below, which is where the
  // speaking actually finishes – so a failure here is a failure to *start*, and says so.
  if (!sent?.ok) settle({ ok: false, reason: sent?.reason ?? 'could not reach the voice engine' });
}

/**
 * The outcome of a preview, which arrives as a broadcast rather than as a reply.
 *
 * `preview` is what tells this apart from an answer being read out in another tab – a real turn
 * sends the same message and this page would otherwise report somebody else's agent as its own
 * sample.
 */
chrome.runtime.onMessage.addListener((message) => {
  if (message?.kind !== 'openposse.spoke' || !message.preview) return;
  // The same breakdown the turn logs, because this page is where a voice gets judged and
  // "it played and I heard nothing" needs the same numbers to be answerable here.
  const m = message.ms ?? {};
  if (message.ms) {
    console.info(`[openposse] preview ${message.voice ?? '?'} (${message.engine ?? '?'}) · `
      + `first word ${m.firstWord ?? '?'}ms · synth ${m.synth ?? '?'}ms → ${m.audio ?? '?'}ms `
      + `audio in ${m.chunks ?? '?'} chunks at ${m.rate ?? '?'}Hz · peak ${m.peak ?? '?'} · `
      + `spoke ${m.play ?? '?'}ms${message.ok ? '' : ` · ${message.reason}`}`);
  }
  settle(message);
});

/** What actually spoke, which is the one thing a preview can report that reading cannot tell you. */
function describeSpoken(message) {
  const engine = { kokoro: 'Kokoro', supertonic: 'Supertonic' }[message.engine] ?? 'System voice';
  const voice = message.engine === 'kokoro' && message.voice
    ? describeVoice(message.voice).name
    : message.voice;
  return voice ? `${engine} · ${voice}` : engine;
}

el('play-sample').addEventListener('click', () => {
  const button = el('play-sample');
  button.disabled = true;
  glyph(button, 'loader-circle');
  button.classList.add('busy');
  setStatus('sample-status', '');

  playSample({
    voice: lastHeardVoice,
    report: (outcome) => {
      button.disabled = false;
      glyph(button, 'play');
      button.classList.remove('busy');
      // Naming the engine is most of the value. "Which of the two is actually speaking" is the
      // question this whole section is about, and a preview that answered it only by sounding a
      // particular way would be making the reader guess at the thing it just demonstrated.
      setStatus('sample-status', outcome.ok
        ? describeSpoken(outcome)
        : SPOKEN_PROBLEM[outcome.reason] ?? outcome.reason ?? 'it did not play');
    },
  });
});

// ── Trying the voices ──────────────────────────────────────────────────────────────────────
//
// **The same words in every voice**, whatever they are. Different lines per voice would sample
// them; one line lets them be compared, which is the actual question – "which of these should
// Ivan be" is a judgement nobody can make from six different sentences.
//
// Editable, because the right sample depends on what you are listening for. A default that
// suits prosody is no use to somebody checking how a voice handles their own product's
// vocabulary, and vice versa.
//
// Short, and it is the product's own line rather than a passage chosen to stress the engine.
// The previous default was four clauses of T. E. Lawrence, picked because it crosses HeadTTS's
// sentence split and so exercises chunk chaining – a real concern while that was the bug, and
// the wrong trade once it was fixed: comparing 28 voices means hearing the same words 28 times,
// and a paragraph makes that a minute of listening per voice rather than two seconds.
//
// It still crosses the sentence split, so the chunking path is exercised anyway.
const DEFAULT_SAMPLE = "It's time. Gather your posse.";

/** What to speak: the box, or the default if it has been emptied. */
function sample() {
  const typed = el('sample').value.trim();
  return typed || DEFAULT_SAMPLE;
}

// Seeded once at load. It used to be filled in by `refreshVoices`, which was fine while the box
// lived inside the section that renders – now the box is always on screen and that section is
// hidden until Kokoro is installed, so seeding there would leave it empty for everyone who has
// not downloaded anything.
function loadSample() {
  if (!el('sample').value) el('sample').value = DEFAULT_SAMPLE;
}

const ACCENT = { a: 'American', b: 'British' };
const GENDER = { f: 'female', m: 'male' };

function describeVoice(id) {
  const [accent, gender] = id;
  const name = id.slice(3);
  return {
    name: name.charAt(0).toUpperCase() + name.slice(1),
    accent: `${ACCENT[accent] ?? '?'} ${GENDER[gender] ?? ''}`.trim(),
  };
}

/**
 * The four accent groups, in the order they are offered.
 *
 * Fixed here rather than derived from `VOICES`, whose order is the *assignment* order and puts
 * the six original voices first so nobody's agent changes voice – see the note on `VOICES`.
 * Reading that order into the UI would produce four groups interleaved by history.
 *
 * **American first**, which is also what the roster does: `assignKokoroVoices` reads `en-US`
 * unless an agent carries a British hint, so these are the voices an agent gets by default and
 * the ones somebody opening this list is most likely choosing between. They are also two thirds
 * of the set – 20 of 28 – so leading with the smaller pair would put the shorter answer first
 * and the likely one last.
 */
const VOICE_GROUPS = ['American female', 'American male', 'British female', 'British male'];

/** Every voice in one accent group, by name, because that is how somebody scans 28 of them. */
const voicesIn = (accent) => VOICES
  .map(({ id }) => ({ id, ...describeVoice(id) }))
  .filter((v) => v.accent === accent)
  .sort((a, b) => a.name.localeCompare(b.name));

async function refreshVoices() {
  const ready = (await weightsStatus()).state === 'ready';
  // Read by the pace slider, which lives outside this section and must know whether it can
  // play anything back.
  // **Nothing outside this section reads it any more.** It used to gate the Play sample button,
  // because the page could only speak through Kokoro – now the worker speaks and that button is
  // live on every machine, so "are the weights here" is only a question about whether there is a
  // list of voices to show.
  el('voices-section').hidden = !ready;
  if (!ready) return;
  renderVoiceGroups(el('voice-list'),
    VOICE_GROUPS.map((accent) => ({ accent, voices: voicesIn(accent) })));
}

// ── The system voices, to try ──────────────────────────────────────────────────────────────
//
// Step 4's list, the twin of step 5's and drawn by the same code. Shown only while the system
// voices are what answers use: once Kokoro is installed, `speak` routes every preview to it
// (it never forks the engine), so a system voice played from here would be Kokoro wearing its
// name.
//
// **The offered voices, grouped by region.** `offeredVoices` decides which: on a Mac, the four
// the user chose; elsewhere every local English voice. The same set feeds each assistant's
// picker and the automatic assignment, so nothing here can be heard that an assistant could not
// be given.

const REGIONS = {
  US: 'American', GB: 'British', AU: 'Australian', IE: 'Irish', IN: 'Indian',
  ZA: 'South African', NZ: 'New Zealand',
};
const REGION_ORDER = [...Object.values(REGIONS), 'Other English', 'Other languages'];

function systemVoiceGroups() {
  const groups = new Map();
  for (const voice of offeredVoices(speechSynthesis.getVoices())) {
    const [language, region = ''] = String(voice.lang).split(/[-_]/);
    const accent = language.toLowerCase() === 'en'
      ? REGIONS[region.toUpperCase()] ?? 'Other English'
      : 'Other languages';
    // "Eddy (English (UK))" is Eddy once the group heading says British.
    const name = voice.name.replace(/\s*\(English \([^)]*\)\)$/, '') || voice.name;
    if (!groups.has(accent)) groups.set(accent, []);
    groups.get(accent).push({ id: voice.voiceURI, name });
  }
  return [...groups]
    .sort(([a], [b]) => REGION_ORDER.indexOf(a) - REGION_ORDER.indexOf(b))
    .map(([accent, voices]) => ({
      accent, voices: voices.sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

function refreshSystemVoices(answering) {
  const groups = answering ? systemVoiceGroups() : [];
  const list = el('system-voice-list');
  el('system-voices-section').hidden = groups.length === 0;

  // A handful of voices do not need a drawer each: the Mac's four are one short list, each
  // named with its accent. A machine offering every English voice gets them grouped, as in step 5.
  const flat = groups.flatMap(({ accent, voices }) =>
    voices.map((v) => ({ ...v, name: `${v.name} – ${accent}` })));
  if (flat.length > 6) {
    renderVoiceGroups(list, groups);
    return;
  }
  list.textContent = '';
  if (flat.length > 0) list.append(voiceGrid(flat));
}

/**
 * What an assistant's voice picker offers: the voices its answers are actually spoken in.
 * Kokoro's when Kokoro answers, the offered system voices otherwise.
 */
async function voiceChoices() {
  if ((await answeringEngine()).engine === 'kokoro') {
    return VOICE_GROUPS.map((accent) => ({ accent, voices: voicesIn(accent) }));
  }
  return systemVoiceGroups();
}

/**
 * Collapsible groups of try-it rows, for either engine's voices.
 *
 * @param list    the container, emptied first
 * @param groups  `{ accent, voices: [{ id, name }] }` in the order they are offered
 */
function renderVoiceGroups(list, groups) {
  list.textContent = '';

  // **Collapsible groups, two columns each.** 28 rows in one column is a scroll rather
  // than a list, and the first thing anybody narrows by is accent – so the accent is the thing
  // that collapses. The heading carries it, which leaves each row's second line free to carry
  // a failure instead, which is what it is really for.
  for (const { accent, voices } of groups) {
    if (voices.length === 0) continue;

    const group = document.createElement('details');
    group.className = 'voice-group';
    // Closed, which is `<details>`'s own default – stated by not setting `open` rather than by
    // setting it false, since the attribute is presence-based and `open = false` reads as a
    // decision that has to be kept in step with one.

    const summary = document.createElement('summary');
    const label = document.createElement('span');
    label.textContent = accent;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = String(voices.length);
    summary.append(icon('chevron-right', { size: 12, className: 'chev' }), label, count);

    group.append(summary, voiceGrid(voices));
    list.append(group);
  }
}

/** Two columns of try-it rows, filled downwards. */
function voiceGrid(voices) {
  const grid = document.createElement('div');
  grid.className = 'voice-grid';
  // Where the second column starts. The grid fills downwards, so this is what splits the
  // alphabet in half rather than interleaving it – and it is set here because each group is a
  // different size and CSS has no way to count its own children.
  const rows = Math.ceil(voices.length / 2);
  grid.style.setProperty('--rows', String(rows));
  // The bottom of each column, so its rule can go: the drawer's own border is directly below.
  voices.forEach(({ id, name }, i) => {
    renderVoice(grid, id, name, { endsColumn: i === rows - 1 || i === voices.length - 1 });
  });
  return grid;
}

/** One row of the try-it list: a play control, the name it plays, and a line for what went wrong. */
function renderVoice(grid, id, name, { endsColumn = false } = {}) {
  const row = document.createElement('div');
  row.className = 'voice';
  row.classList.toggle('ends-column', endsColumn);

  const sub = document.createElement('div');
  sub.className = 'accent';

  // **The whole row is the button, with the icon leading it.**
  //
  // The icon was a separate control on the right, which is where a trailing action goes and is
  // wrong here: the name took the remaining width, so each button sat far from its own name and
  // close to the next column's. Adam's button read as Echo's, and no column gap fixes that –
  // nothing makes 150px of intra-row space read as closer than 26px of gutter.
  //
  // Leading the name removes the question rather than arguing with it: there is nothing between
  // the triangle and the word it plays. Making the row the target rather than the circle is the
  // other half, because the hover tint then shows how far one voice's row extends.
  //
  // **Icon rather than the word "Play", still.** Twenty-eight rows carrying the same five
  // letters was the noisiest thing on the page, competing with the one word that varies. The
  // name is the button's own text now, so a screen reader reads it either way; `aria-label`
  // keeps the verb, and contains the visible name so the two do not disagree.
  const play = document.createElement('button');
  play.className = 'play';
  play.setAttribute('aria-label', `Play ${name}`);

  const glyph = document.createElement('span');
  glyph.className = 'glyph';
  glyph.append(icon('play', { size: 11 }));

  const label = document.createElement('span');
  label.className = 'name';
  label.textContent = name;
  play.append(glyph, label);

  /** Swaps the glyph in place, so the name does not move while it loads. */
  const show = (which) => {
    glyph.textContent = '';
    glyph.append(icon(which, { size: 11 }));
    play.classList.toggle('busy', which === 'loader-circle');
  };

  play.addEventListener('click', () => {
    // Every button disabled, not just this one: the engines speak one utterance at a time, and
    // leaving the rest live would mean a second click cancels a sample that is still loading –
    // which looks like the first voice simply failing. Both lists' rows and `#play-sample` are in
    // the set; they all go down the same path.
    const buttons = [...document.querySelectorAll('.voice-grid button'), el('play-sample')];
    for (const b of buttons) b.disabled = true;
    show('loader-circle');
    sub.textContent = '';

    // Remembered, so the pace sample above speaks in whatever was last judged here rather than
    // reverting to the roster's choice. The pace itself is not passed: the worker reads what is
    // *stored*, which is the number an answer will actually use.
    lastHeardVoice = id;
    playSample({
      voice: id,
      report: (outcome) => {
        if (!outcome.ok && outcome.reason !== 'cancelled') {
          sub.textContent = SPOKEN_PROBLEM[outcome.reason] ?? outcome.reason;
          sub.style.color = 'var(--error)';
        }
        show('play');
        for (const b of buttons) b.disabled = false;
      },
    });
  });

  row.append(play, sub);
  grid.append(row);
}

// ── Site icons on the avatars ──────────────────────────────────────────────────────────────
//
// Holding the `favicon` permission is the setting – see favicons.js – so this toggles a grant the
// way step 4 does, and the panel redraws itself from `permissions.onAdded` and `onRemoved`.

async function refreshIcons() {
  el('grant-icons').setAttribute('aria-checked', String(await chrome.permissions.contains(ICONS)));
}

el('grant-icons').addEventListener('click', async () => {
  const status = el('icons-status');
  status.hidden = true;
  try {
    // Step 4's shape: `contains` is the one hop the click's gesture survives before `request`.
    if (await chrome.permissions.contains(ICONS)) await chrome.permissions.remove(ICONS);
    else await chrome.permissions.request(ICONS);
  } catch (error) {
    status.textContent = `not changed – ${error?.message ?? error}`;
    status.hidden = false;
  }
  await refreshIcons();
  await refreshRoster();
});

// ── Roster ─────────────────────────────────────────────────────────────────────────────────

/** Past this many, a search box appears over the roster. */
const SEARCH_FROM = 11;

/** Which redraw is the latest – see `refreshRoster`. */
let rosterDrawn = 0;

async function refreshRoster() {
  // **Only the latest redraw reaches the screen, and it arrives whole.** The list now redraws
  // itself on every roster change in storage as well as after this page's own edits – so a
  // rename asks twice, once itself and once through the change it causes – and each pass awaits
  // storage before it draws. Clearing first and appending as rows were made let two passes
  // interleave into one list twice as long; swapping the finished list in at the end, and only
  // from the newest pass, means an older read can never land on top of a newer one.
  const drawing = ++rosterDrawn;
  // In the order arranged here – by dragging, or by the Sort menu.
  const { arranged: agents, broken, problem } = await loadRoster();
  const target = el('roster');
  const search = el('roster-search');

  if (problem || agents.length === 0) {
    if (drawing !== rosterDrawn) return;
    target.className = problem ? 'card bad' : 'card';
    target.textContent = problem ?? 'none yet – record one from the toolbar button';
    el('sort-roster').hidden = true;
    search.hidden = true;
    search.value = '';
    el('roster-none').hidden = true;
    return;
  }

  const patterns = Object.fromEntries(await Promise.all(
    agents.map(async (agent) => [agent.id, (await recipeFor(agent))?.domainPattern])));
  const icons = await iconPages(patterns);
  const choices = await voiceChoices();
  if (drawing !== rosterDrawn) return;

  const built = [];
  for (const [index, agent] of agents.entries()) {
    const row = document.createElement('div');
    // Everyone is shown lit here: this is a list of what exists, not of who is speaking.
    row.className = 'agent active';
    row.dataset.id = agent.id;
    row.style.setProperty('--channel', channelOf(agent));
    // What the Share sheet hangs from – one name per row, like the palette's.
    row.style.setProperty('anchor-name', `--tile-${index}`);

    // ── Its colour ─────────────────────────────────────────────────────────────────────
    //
    // **The avatar is the control, because the colour is the avatar.** Clicking it opens the
    // palette over the list, under the avatar. Every swatch already held by
    // another agent carries that agent's initial, so taking a colour somebody else has is a
    // choice made knowingly rather than a clash found later on the panel – allowed, because it
    // is the person's call, but never by accident.
    const avatar = document.createElement('button');
    avatar.className = `avatar${agent.mock ? ' mock' : ''}`;
    avatar.textContent = initialFor(agent.name);
    putIcon(avatar, icons[agent.id]);
    avatar.setAttribute('aria-expanded', 'false');
    // It is also what you drag the assistant by – see "Arranging" below.
    avatar.draggable = true;
    avatar.title = `${agent.name} is ${colourName(channelOf(agent))} – click to change, drag to move`;
    avatar.setAttribute('aria-label', avatar.title);

    // **A popover, so it floats over the list instead of pushing it down.** Chrome draws it in
    // the top layer and closes it on a click elsewhere or Escape, and `auto` also closes any
    // other palette left open. Each row anchors its own: one shared anchor name would put every
    // palette under whichever avatar was laid out last.
    const palette = document.createElement('div');
    palette.className = 'palette';
    palette.popover = 'auto';
    palette.setAttribute('role', 'group');
    palette.setAttribute('aria-label', `Colours for ${agent.name}`);
    avatar.style.setProperty('anchor-name', `--avatar-${index}`);
    palette.style.setProperty('position-anchor', `--avatar-${index}`);

    for (const { hex, name: colour } of PALETTE) {
      const mine = channelOf(agent) === hex;
      const holders = agents.filter((a) => a.id !== agent.id && channelOf(a) === hex);

      const swatch = document.createElement('button');
      swatch.className = `swatch${mine ? ' mine' : ''}`;
      swatch.style.setProperty('--swatch', hex);
      swatch.textContent = holders.length ? initialFor(holders[0].name) : '';
      swatch.setAttribute('aria-pressed', String(mine));
      swatch.title = [
        colour,
        mine ? `${agent.name}'s now` : null,
        holders.length ? `${holders.map((h) => h.name).join(' and ')} already has it` : null,
      ].filter(Boolean).join(' – ');
      swatch.setAttribute('aria-label', swatch.title);

      swatch.addEventListener('click', async () => {
        if (mine) return;
        const result = await chrome.runtime
          .sendMessage({ kind: 'openposse.agent.channel', agentId: agent.id, channel: hex })
          .catch((error) => ({ ok: false, reason: String(error?.message ?? error) }));
        if (!result?.ok) {
          problemLine.textContent = result?.reason ?? 'could not set that colour';
          problemLine.className = 'kind bad';
          problemLine.hidden = false;
          return;
        }
        await refreshRoster();
      });
      palette.append(swatch);
    }

    // The browser opens and closes it now, light dismiss included, so the expanded state is read
    // back from the popover rather than kept beside it.
    avatar.popoverTargetElement = palette;
    palette.addEventListener('toggle', (event) => {
      avatar.setAttribute('aria-expanded', String(event.newState === 'open'));
    });

    // What it drives – "Notion", "LeanIX" – where every row used to say "Via browser", which
    // was true of all of them and so told nobody anything. The panel's label, from the same
    // derivation.
    const kind = document.createElement('div');
    // A broken agent is listed, not hidden. It still routes, so being told beats finding out
    // when it is asked a question.
    const isBroken = broken.includes(agent.id);
    kind.className = isBroken ? 'kind bad' : 'kind';
    kind.textContent = isBroken
      ? 'needs re-recording – its recipe is missing'
      : productLabel(patterns[agent.id]) || patterns[agent.id] || '';

    // A made-up recording from the panel's debug drawer says so, and nothing else about it is
    // different: it is drawn exactly as a real one would be, which is what it is for.
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'mock';
    badge.hidden = !agent.mock;

    // What the search box matches: the name, the product, and "mock" for the mocks.
    row.dataset.find = [agent.name, kind.textContent, agent.mock ? 'mock' : '']
      .join(' ').toLowerCase();

    // ── Renaming lives here, and that is deliberate ────────────────────────────────────
    //
    // Recording used to end with a name field in the orb, over the vendor's page. It could not
    // be typed into: a page manages its own focus, and Notion takes it straight back. Rather
    // than fight that per vendor forever, a recording now saves itself under the vendor's
    // product name and the name becomes an edit – here, in our own page, where nothing
    // competes for the keyboard.
    //
    // A plain input rather than a dialog: there is one field and it already shows the current
    // value, so a modal would add a step to confirm something the user can already see.
    const rename = document.createElement('input');
    rename.type = 'text';
    rename.className = 'rename';
    rename.value = agent.name;
    rename.maxLength = 24;
    rename.setAttribute('aria-label', `Rename ${agent.name}`);

    const problemLine = document.createElement('div');
    problemLine.className = 'kind bad';
    problemLine.hidden = true;

    const commit = async () => {
      const wanted = rename.value.trim();
      if (!wanted || wanted === agent.name) { rename.value = agent.name; return; }

      const result = await chrome.runtime
        .sendMessage({ kind: 'openposse.agent.rename', agentId: agent.id, name: wanted })
        .catch((error) => ({ ok: false, reason: String(error?.message ?? error) }));

      if (!result?.ok) {
        // A rename that did not happen must not look like one that did – the roster is what
        // the user says out loud, so believing a stale name means addressing an agent that
        // does not answer.
        problemLine.textContent = result?.reason ?? 'could not rename';
        problemLine.hidden = false;
        rename.value = agent.name;
        return;
      }
      await refreshRoster();
    };

    rename.addEventListener('blur', commit);
    rename.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') rename.blur();
      // Escape puts back what was there, so a half-typed name is not committed by clicking away.
      if (event.key === 'Escape') { rename.value = agent.name; rename.blur(); }
    });

    // ── Its voice ──────────────────────────────────────────────────────────────────────
    //
    // **Only the voices this agent's answers can actually be spoken in**: Kokoro's when Kokoro
    // answers, the offered system voices otherwise. It used to list Kokoro's 28 whether or not
    // they were installed, and picking one without them silently gave the agent some unrelated
    // system voice. Empty is a real choice rather than an absence: it hands the agent back to
    // the accent heuristic, which keeps every agent sounding different as the roster grows.
    //
    // One stored field holds either kind. A system voice chosen here is kept if Kokoro is
    // installed later, and comes back if it is removed; meanwhile Kokoro assigns by accent.
    //
    // Grouped by accent. A flat list of six was a list; a flat list of 28 is a search, and the
    // first thing anyone narrows by is whether they want a British voice or an American one.
    const voice = document.createElement('select');
    voice.className = 'voice-pick';
    voice.setAttribute('aria-label', `Voice for ${agent.name}`);

    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Chosen for me';
    voice.append(auto);

    for (const { accent, voices } of choices) {
      const group = document.createElement('optgroup');
      group.label = accent;
      for (const { id, name } of voices) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = name;
        group.append(option);
      }
      voice.append(group);
    }
    voice.value = choices.some(({ voices }) => voices.some((v) => v.id === agent.voice))
      ? agent.voice : '';

    voice.addEventListener('change', async () => {
      const result = await chrome.runtime
        .sendMessage({ kind: 'openposse.agent.voice', agentId: agent.id, voice: voice.value })
        .catch((error) => ({ ok: false, reason: String(error?.message ?? error) }));

      if (!result?.ok) {
        problemLine.textContent = result?.reason ?? 'could not set that voice';
        problemLine.className = 'kind bad';
        problemLine.hidden = false;
        return;
      }
      // Spoken back rather than only saved. A voice is the one setting here you cannot judge
      // by reading, and hearing it immediately is the difference between choosing and guessing.
      //
      // "Chosen for me" deliberately says nothing: the heuristic picks from the whole roster, so
      // the voice this agent lands on is not knowable until every agent has been placed, and
      // playing *a* voice would be asserting one that may not be the one it gets.
      if (voice.value) {
        lastHeardVoice = voice.value;
        playSample({ voice: voice.value, report: (outcome) => {
          if (outcome.ok || outcome.reason === 'cancelled') return;
          problemLine.textContent = SPOKEN_PROBLEM[outcome.reason] ?? outcome.reason;
          problemLine.className = 'kind bad';
          problemLine.hidden = false;
        } });
      }
    });

    // ── What it captured, re-recording, and removing ───────────────────────────────────
    const tools = document.createElement('div');
    tools.className = 'tools';

    const say = (message, bad = false) => {
      problemLine.textContent = message;
      problemLine.className = bad ? 'kind bad' : 'kind';
      problemLine.hidden = false;
    };

    /** One of the row's icon buttons, its words in the hover label. */
    const tool = (name, words, className = '') => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `icon small ${className}`.trim();
      button.dataset.tipAt = 'end';
      glyph(button, name, 14);
      label(button, words);
      return button;
    };

    /**
     * A sheet over the list, hung from this row, that `button` opens and closes – the palette's
     * mechanism, so a second click, a click elsewhere and Escape all close it, and opening one
     * closes any other. The recipe is asked for when it opens, not on every redraw of every row,
     * and `fill` writes it in.
     */
    const sheetFor = (button, fill) => {
      const sheet = document.createElement('div');
      sheet.className = 'sheet';
      sheet.popover = 'auto';
      sheet.style.setProperty('position-anchor', `--tile-${index}`);
      button.popoverTargetElement = sheet;
      button.setAttribute('aria-expanded', 'false');
      sheet.addEventListener('toggle', async (event) => {
        button.setAttribute('aria-expanded', String(event.newState === 'open'));
        if (event.newState !== 'open') return;

        sheet.textContent = 'reading…';
        const result = await chrome.runtime
          .sendMessage({ kind: 'openposse.agent.recipe', agentId: agent.id })
          .catch((error) => ({ ok: false, reason: String(error?.message ?? error) }));

        if (!result?.ok || !result.recipe) {
          sheet.hidePopover();
          say(result?.reason ?? 'its recipe is missing', true);
          return;
        }
        sheet.textContent = '';
        fill(sheet, result.recipe);
      });
      return sheet;
    };

    /**
     * The strip along a sheet's top: its title, then its actions and Copy at the far end. A copy
     * the clipboard refused says why, in the strip – one that silently did nothing would be found
     * out later, somewhere else, as an empty paste.
     */
    const toolbar = (text, what, title, ...actions) => {
      const note = document.createElement('span');
      note.className = 'tech note';
      const copy = tool('copy', `Copy ${what}`);
      // Labels open downwards in this strip: it is the top of a sheet that scrolls, which would
      // clip a label drawn above it.
      copy.dataset.tipBelow = '';
      copy.addEventListener('click', async () => {
        note.textContent = '';
        try {
          await navigator.clipboard.writeText(text);
        } catch (error) {
          note.textContent = `not copied – ${error?.message ?? error}`;
          return;
        }
        glyph(copy, 'check', 14);
        label(copy, 'Copied');
        setTimeout(() => { glyph(copy, 'copy', 14); label(copy, `Copy ${what}`); }, 1500);
      });
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.append(title, note, ...actions, copy);
      return bar;
    };

    /** A sheet's lines: a lead-in saying what follows, and the block itself. */
    const lede = (...words) => {
      const line = document.createElement('p');
      line.className = 'lede';
      line.append(...words);
      return line;
    };
    const block = (text) => {
      const pre = document.createElement('pre');
      pre.className = 'recipe';
      pre.textContent = text;
      return pre;
    };

    // **Share** – the file that carries this assistant. A See button listing its steps as rows
    // went on 2026-10-06, too technical for a sheet about sending it; whoever receives the file
    // still sees those rows in the Add a shared assistant preview, before they grant anything.
    //
    // Shown before it is saved, because the JSON *is* the review surface. Downloading it silently
    // would make the file the thing you trust without ever having seen it. Shown, it can be read
    // before it is sent and read again by whoever receives it, which is half of what stands
    // between an imported recipe and a bad host permission. The other half is Chrome's own
    // prompt, on the far side.
    const share = tool('share', `Share ${agent.name}`);
    const sharing = sheetFor(share, (sheet, recipe) => {
      const text = toFile(pack({ name: agent.name, recipe }));
      const file = filenameFor(agent.name);

      const title = document.createElement('h3');
      title.textContent = `Share ${agent.name}`;
      const filename = document.createElement('span');
      filename.className = 'tech';
      filename.textContent = file;

      const save = tool('download', `Save ${file}`);
      // Its label opens downwards: the sheet scrolls, so a label drawn above its top strip would
      // be clipped by it.
      save.dataset.tipBelow = '';
      save.addEventListener('click', () => {
        // A blob URL from an extension page needs no `downloads` permission, and revoking it
        // after the click keeps the object out of memory for the life of the page.
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = file;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });

      // Save at the top, beside Copy, rather than under a file that can run past the fold.
      sheet.append(
        toolbar(text, 'the file', title, save),
        lede(filename, ' – send it to someone to add under Add a shared AI assistant.'),
        block(text),
      );
    });

    // **Re-record** – same wizard, keeping this agent's name and voice.
    const again = tool('rotate-ccw', `Record ${agent.name} again`);
    again.addEventListener('click', async () => {
      again.disabled = true;
      say('opening the page…');
      const result = await chrome.runtime
        .sendMessage({ kind: 'openposse.agent.rerecord', agentId: agent.id })
        .catch((error) => ({ ok: false, reason: String(error?.message ?? error) }));

      again.disabled = false;
      if (!result?.ok) { say(result?.reason ?? 'could not start', true); return; }
      say('recording – the panel is on that tab now');
    });

    // **Delete** – confirmed in place. A dialog would be a second surface to build and would
    // still be a yes/no; turning the button itself into the confirmation keeps the question
    // attached to the row it is about, so there is no chance of confirming the wrong one.
    const remove = tool('trash', `Delete ${agent.name}`, 'bad');
    let armed = false;
    /** Loaded, it turns into a red tick whose label says what the next click does. */
    const arm = (on) => {
      armed = on;
      remove.classList.toggle('armed', on);
      glyph(remove, on ? 'check' : 'trash', 14);
      label(remove, on ? `Click again to delete ${agent.name}` : `Delete ${agent.name}`);
    };
    remove.addEventListener('click', async () => {
      if (!armed) {
        arm(true);
        // Disarms itself, so a stray click cannot leave a loaded button waiting for the next one.
        setTimeout(() => arm(false), 4000);
        return;
      }
      const result = await chrome.runtime
        .sendMessage({ kind: 'openposse.agent.remove', agentId: agent.id })
        .catch((error) => ({ ok: false, reason: String(error?.message ?? error) }));

      if (!result?.ok) { say(result?.reason ?? 'could not delete', true); return; }
      await refreshRoster();
    });

    tools.append(share, again, remove);

    // Two lines beside the avatar: the name, which is the rename field, and its tools; then what
    // it drives and its voice. The sheets and the palette are in the row only to be found –
    // they are drawn in Chrome's top layer, over the list.
    const named = document.createElement('div');
    named.className = 'line';
    named.append(rename, tools);
    const about = document.createElement('div');
    about.className = 'line';
    about.append(kind, badge, voice);
    const who = document.createElement('div');
    who.className = 'who';
    who.append(named, about, problemLine);

    row.append(avatar, who, palette, sharing);
    built.push(row);
  }

  target.className = 'grid';
  target.replaceChildren(...built);
  el('sort-roster').hidden = agents.length < 2;
  // Only worth its space once the list is long; hidden, it must not go on filtering.
  search.hidden = agents.length < SEARCH_FROM;
  if (search.hidden) search.value = '';
  filterRoster();
}

/** How many columns the stylesheet gives the roster at this width – `--columns` in setup.html. */
const columnsOf = (target) => Number.parseInt(getComputedStyle(target).getPropertyValue('--columns'), 10) || 1;
/** The count the roster was last laid out for, so a resize lays it out again only past a breakpoint. */
let laidOutFor = 0;

/**
 * Shows the assistants the search box matches, and lays the columns out over what is shown.
 *
 * The roster fills down, so where each column starts is a count – and it has to be the count of
 * what is on screen. Kept at the whole roster's share, five matches out of thirty would all sit
 * in the first column with empty ones beside it.
 */
function filterRoster() {
  const target = el('roster');
  if (!target.classList.contains('grid')) return;
  const typed = el('roster-search').value.trim();
  const wanted = typed.toLowerCase();

  const rows = [...target.children];
  for (const row of rows) row.hidden = Boolean(wanted) && !row.dataset.find.includes(wanted);
  const shown = rows.filter((row) => !row.hidden);

  laidOutFor = columnsOf(target);
  const down = Math.max(Math.ceil(shown.length / laidOutFor), 1);
  target.style.setProperty('--rows', String(down));
  // How many columns have anyone in them – one match fills only the first, and four across three
  // fill two – so no divider is drawn beside nothing, where it reads as a stray line.
  target.dataset.columns = String(Math.ceil(shown.length / down));
  // The bottom of each column drops its rule, as the voice list's do.
  shown.forEach((row, i) => row.classList.toggle('ends-column', (i + 1) % down === 0 || i === shown.length - 1));

  const none = el('roster-none');
  none.hidden = shown.length > 0;
  none.textContent = shown.length ? '' : `No AI assistant matches “${typed}”.`;
}

el('roster-search').addEventListener('input', filterRoster);
window.addEventListener('resize', () => {
  if (columnsOf(el('roster')) !== laidOutFor) filterRoster();
});

// ── Arranging ──────────────────────────────────────────────────────────────────────────────
//
// **An assistant is dragged by its avatar.** A click on it still opens the colours – to the
// browser a drag is a different gesture – so a tile that already holds six controls gets no
// seventh. The order is saved apart from the roster, for the reason in order.js, and the panel and
// the popup draw from it too.

/** Our own type, so a dragged avatar cannot be dropped into the search box or a name as text. */
const DRAGGED = 'application/x-openposse-agent';

/** The assistant being dragged from this page, by id; null between drags. */
let dragged = null;
/** Set when the list changed in storage mid-drag – its redraw waits for the drag to end. */
let redrawAfterDrag = false;

/** Shows where a drop would land: a line above `row`, or below it with `after`. No row clears it. */
function mark(row = null, after = false) {
  for (const marked of el('roster').querySelectorAll('.drop-before, .drop-after')) {
    if (marked !== row) marked.classList.remove('drop-before', 'drop-after');
  }
  row?.classList.toggle('drop-before', !after);
  row?.classList.toggle('drop-after', after);
}

/** Saves `ids` as the order, or says why not – `failed` leads the sentence – and redraws either way. */
async function saveOrder(ids, failed) {
  const status = el('order-status');
  status.hidden = true;
  const result = await chrome.runtime
    .sendMessage({ kind: 'openposse.agent.order', ids })
    .catch((error) => ({ ok: false, reason: String(error?.message ?? error) }));
  if (!result?.ok) {
    status.textContent = `${failed} – ${result?.reason ?? 'the extension did not answer'}`;
    status.hidden = false;
  }
  // From storage, so a move that was not saved goes back to where it is saved.
  await refreshRoster();
}

el('roster').addEventListener('dragstart', (event) => {
  const row = event.target.closest?.('.agent');
  if (!row || !event.target.matches('.avatar')) return;
  dragged = row.dataset.id;
  event.dataTransfer.setData(DRAGGED, dragged);
  event.dataTransfer.effectAllowed = 'move';
  // The whole tile, held where it was picked up, so it is clear what is moving.
  const box = row.getBoundingClientRect();
  event.dataTransfer.setDragImage(row, event.clientX - box.left, event.clientY - box.top);
  row.classList.add('dragging');
});

el('roster').addEventListener('dragover', (event) => {
  if (!event.dataTransfer.types.includes(DRAGGED)) return;
  const row = event.target.closest?.('.agent');
  // Over itself it would land where it already is, so that is no place to drop.
  if (!row || row.dataset.id === dragged) { mark(); return; }
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const box = row.getBoundingClientRect();
  mark(row, event.clientY > box.top + box.height / 2);
});

// Off the list nothing would land, so no line. Not `dragleave`: it also fires on moving between a
// tile's own parts, and the line would flicker.
document.addEventListener('dragover', (event) => {
  if (!el('roster').contains(event.target)) mark();
});

el('roster').addEventListener('drop', (event) => {
  const row = event.target.closest?.('.agent');
  const after = row?.classList.contains('drop-after');
  mark();
  const id = event.dataTransfer.getData(DRAGGED);
  const moving = id && el('roster').querySelector(`.agent[data-id="${CSS.escape(id)}"]`);
  if (!row || !moving || moving === row) return;
  event.preventDefault();
  // Moved at once, so the list answers the drop itself rather than after a trip to storage.
  if (after) row.after(moving); else row.before(moving);
  filterRoster();
  saveOrder([...el('roster').children].map((tile) => tile.dataset.id), 'not moved');
});

el('roster').addEventListener('dragend', () => {
  dragged = null;
  mark();
  for (const row of el('roster').querySelectorAll('.dragging')) row.classList.remove('dragging');
  if (redrawAfterDrag) { redrawAfterDrag = false; refreshRoster(); }
});

// ── Sorting ────────────────────────────────────────────────────────────────────────────────
//
// **A sort sets the order once, and then it is yours to drag.** Not a mode the list stays in:
// there is one order, everywhere, so the panel and Settings never disagree about who is first.

el('sort-menu').addEventListener('toggle', (event) => {
  el('sort-roster').setAttribute('aria-expanded', String(event.newState === 'open'));
});

for (const choice of el('sort-menu').querySelectorAll('button[data-sort]')) {
  choice.addEventListener('click', async () => {
    el('sort-menu').hidePopover();
    // From storage rather than the screen: Newest and Oldest need the order they were added in.
    const { agents, problem } = await loadRoster();
    if (problem) {
      el('order-status').textContent = `not sorted – ${problem}`;
      el('order-status').hidden = false;
      return;
    }
    const sites = Object.fromEntries(await Promise.all(agents.map(async (agent) => {
      const pattern = (await recipeFor(agent))?.domainPattern;
      return [agent.id, productLabel(pattern) || pattern || ''];
    })));
    await saveOrder(sortedIDs(agents, choice.dataset.sort, (agent) => sites[agent.id]), 'not sorted');
  });
}

// **The list keeps itself current.** A recording finishing, the panel's mock roster, a colour or a
// voice changed in another window – each lands in storage, and this page used to show none of it
// until it was reloaded. `iconSites` is in the set because a site icon learned elsewhere is a
// change to how the list looks, and `rosterOrder` for an order changed in another window.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes);
  const watched = ['agents', 'rosterOrder', 'iconSites'];
  if (!keys.some((key) => watched.includes(key) || key.startsWith('recipe:'))) return;
  redrawRoster();
});

/** Redraws the roster, unless that would pull something out from under the person using it. */
function redrawRoster() {
  // Not mid-drag: a redraw would take the tile out from under the pointer.
  if (dragged) { redrawAfterDrag = true; return; }

  // Not under somebody's typing. A redraw replaces every field in the list, so one arriving
  // while a name or a voice is being changed would take the field out from under them; it waits
  // until they leave it instead.
  const roster = el('roster');
  if (roster.contains(document.activeElement) && document.activeElement.matches('input, select')) {
    roster.addEventListener('focusout', () => refreshRoster(), { once: true });
    return;
  }
  refreshRoster();
}

// ── Adding an assistant somebody else recorded ─────────────────────────────────────────────
//
// **Two beats, and the split is load-bearing rather than tidy.** `permissions.request` needs a
// Chrome user gesture, and a gesture does not survive an `await` – the constraint `popup.js`
// documents at length, which is why the recording grant lives on a button there. So the file is
// read and shown on one interaction, and the origin is requested on a *separate* click whose
// very first statement is the request.
//
// Reading first also means the site is named on screen before anyone is asked to allow it.
// Chrome's prompt says "Read and change your data on notion.so"; this says which assistant that
// is for, and what it will drive.

/** The recipe waiting to be added, and nothing else. Null whenever the preview is not valid. */
let pending = null;

function showImport(message, bad = false) {
  const status = el('import-status');
  status.textContent = message;
  status.className = bad ? 'status tech bad' : 'status tech';
}

/**
 * Reads what was pasted or picked, and says what it is or what is wrong with it.
 *
 * Every refusal names its reason. A file that cannot be added and does not say why is the exact
 * shape this project keeps banning, and here it would read as "the button is broken".
 */
function offer(text) {
  const preview = el('import-preview');
  pending = null;
  el('import-add').disabled = true;

  if (!String(text ?? '').trim()) {
    preview.hidden = true;
    showImport('nothing to add yet');
    return;
  }

  const read = unpack(text);
  if (!read.ok) {
    preview.hidden = true;
    showImport(read.problems.join(' '), true);
    return;
  }

  // What it will do, in a sentence – the selectors themselves were too technical for the person
  // deciding. The site it names is the one Chrome's prompt will name too.
  preview.textContent = summarise(read.name, read.recipe);
  preview.hidden = false;

  // **The raw text is kept, not just the parsed result.** The worker re-validates on the bytes
  // rather than trusting this page, so it needs exactly what was read here – re-serialising the
  // parsed object would hand it something this page had already touched.
  pending = { ...read, raw: String(text) };
  el('import-add').disabled = false;
  if (read.notes.length) showImport(read.notes.join(' '));
  else sayAccess(pending);
}

/**
 * Whether adding it will bring up Chrome's prompt – said once Chrome has answered, not assumed.
 *
 * The line used to promise a prompt every time, and a site already granted is never asked about
 * again: by an earlier recording on it, or by an all-sites grant from Chrome's Site access menu
 * or the old step 4. `contains` answers whether the site is *covered*, which is the question.
 */
async function sayAccess(waiting) {
  const site = waiting.recipe.domainPattern.replace(/^\*\./, '');
  showImport('checking site access…');
  const covered = await chrome.permissions
    .contains({ origins: [matchPattern(waiting.recipe.domainPattern)] })
    .catch((error) => {
      console.warn('[openposse] could not check site access –', error?.message ?? error);
      return null;
    });
  // Something else was pasted or picked while Chrome answered; that one says its own.
  if (pending !== waiting) return;
  if (covered === null) showImport(`ready – could not check access to ${site}, so Chrome may ask`);
  else if (covered) showImport(`ready – OpenPosse already has access to ${site}, so Chrome won’t ask`);
  else showImport(`ready – Chrome will ask you to allow access to ${site}`);
}

// Access changing while a file waits here – granted by recording on that site, or switched in
// Chrome's own Site access menu – changes whether Chrome will ask, so the line is checked again.
const recheckAccess = () => { if (pending && !pending.notes.length) sayAccess(pending); };
chrome.permissions.onAdded.addListener(recheckAccess);
chrome.permissions.onRemoved.addListener(recheckAccess);

el('import-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) { offer(''); return; }
  try {
    offer(await file.text());
  } catch (error) {
    // A file that cannot be read is not the same event as a file that is not a recipe, and the
    // person reacts to them differently – one is worth retrying, the other is not.
    showImport(`That file could not be read – ${error?.message ?? error}`, true);
  }
});

el('import-text').addEventListener('input', (event) => offer(event.target.value));

// The file input is hidden – Chrome's own "Choose File" cannot be restyled – and this opens it.
el('import-pick').addEventListener('click', () => el('import-file').click());

el('import-add').addEventListener('click', async () => {
  if (!pending) return;                       // the button is disabled; this is belt and braces

  // **First statement, nothing awaited before it.** See the note above this section.
  const granted = await chrome.permissions.request({
    origins: [matchPattern(pending.recipe.domainPattern)],
  });
  if (!granted) {
    // Declining is an answer. Nothing is added and the file stays loaded, so the same click
    // works if they change their mind.
    showImport(`Not added – OpenPosse has no access to ${pending.recipe.domainPattern}.`, true);
    return;
  }

  // The *text* crosses, not the parsed recipe: the worker makes the trust decision itself, on
  // the bytes, so this page is not the only thing standing between a forged file and a grant.
  const result = await chrome.runtime
    .sendMessage({ kind: 'openposse.agent.import', text: pending.raw })
    .catch((error) => ({ ok: false, reason: String(error?.message ?? error) }));

  if (!result?.ok) { showImport(result?.reason ?? 'could not add it', true); return; }

  showImport(result.renamed
    ? `Added as ${result.name} – you already had one by that name.`
    : `Added ${result.name}.`);

  el('import-text').value = '';
  el('import-file').value = '';
  el('import-preview').hidden = true;
  el('import-add').disabled = true;
  pending = null;
  await refreshRoster();
});

// ── Debug tools ────────────────────────────────────────────────────────────────────────────
//
// Behind the bug icon by the logo – moved from the panel's dock on 2026-10-06, so the panel
// keeps only what a turn needs. Of what the Mac app's menu and sliders carried, only the
// follow-up window is still a guess this extension makes; the answer settle wait is here because
// it is the other clock a turn still waits on. The rest is this extension's own scaffolding:
// E14's surface switch, the voice diagnostics, the mock roster and the site-icon loader. The demo
// went back to the panel the same day, top right over the orb, because that is where it plays.
//
// The panel's site line did not come with them. It described the tab in front of the panel, and
// this page has no such tab; the panel's key button still appears whenever there is access to
// grant. Its all-sites note did come, because that is about the browser rather than any tab.

// The drawer is for developing OpenPosse, not for using it, so a store build hides its button:
// the timing knobs, the mock roster, voice diagnostics and "Load icons" all live behind it.
// `DEV_TOOLS` is set by `tools/build.mjs`. The drawer stays in the page, unreachable, because
// the wiring below expects it to exist.
el('debug').hidden = !DEV_TOOLS;

el('debug-tools').addEventListener('toggle', (event) => {
  el('debug').setAttribute('aria-expanded', String(event.newState === 'open'));
});

/**
 * The sliders, one row each. `resolve` is the function every reader of that value already goes
 * through, so this shows exactly what the worker and the page will use – including falling back
 * to the default for anything out of range – rather than a second opinion about it.
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
/** Mock recordings in the roster, for the icon's dot. */
let mockCount = 0;

function paintDebugToggle() {
  const set = [
    ...KNOBS.filter((k) => k.id in overrides).map((k) => `${k.name} ${overrides[k.id] / 1000} s`),
    ...(mockCount ? [`${mockCount} mock recordings`] : []),
  ];
  el('debug').classList.toggle('overridden', set.length > 0);
  label(el('debug'), ['Debug tools', set.join(', ')].filter(Boolean).join(' – '));
}

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
  // The range comes from the module that enforces it, so this cannot offer what the worker or
  // the page would refuse.
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

/**
 * E14's switch, and it is temporary by decision: when user testing picks a surface, the other is
 * deleted along with everything that exists to defend it.
 */
async function paintSurface() {
  const { surface } = await chrome.storage.local.get('surface');
  // Nothing stored, or nothing valid, is the panel – `surface.js`'s default.
  const onPanel = surface !== 'orb';
  // The icon is where a click takes you, not where you are – the same reading as the label.
  glyph(el('surface'), onPanel ? 'orbit' : 'panel-right', 16);
  label(el('surface'), onPanel
    ? 'Use the orb – show turns over the page instead'
    : 'Use the side panel – it also works on pages the orb cannot reach');
}

el('surface').addEventListener('click', async () => {
  const { surface } = await chrome.storage.local.get('surface');
  await setSurface(surface === 'orb' ? 'panel' : 'orb');
  await paintSurface();
});

// Kokoro's layer-by-layer check, `spike.js`, in a tab of its own.
el('diagnostics').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('spike.html') }).catch((error) => {
    console.warn('[openposse] could not open the voice diagnostics –', error?.message ?? error);
  });
});

// Whether a granted origin is a wildcard over every host.
//
// Line comments, deliberately: writing that pattern out inside a slash-star block ends the
// comment at its own star-slash and the rest parses as code – the same trap as a backtick in
// `orb.js`'s CSS template, a sequence inside a comment that terminates its container.
const isBroad = (origin) => origin === '<all_urls>' || /^(\*|https?):\/\/\*\//.test(origin);

/**
 * **Said out loud, because it was not and that cost an hour.** Chrome's own Site access menu
 * offers "On all sites" in one click, and nothing else in this extension mentions it afterwards –
 * so every site reads as granted, for a reason the product never stated. It is also the exact
 * trap that made two earlier tests of the grant flow prove nothing.
 */
async function paintBroadNote() {
  const { origins = [] } = await chrome.permissions.getAll().catch((error) => {
    console.warn('[openposse] could not read the granted sites –', error?.message ?? error);
    return { origins: [] };
  });
  const broad = origins.filter(isBroad);
  el('broad-note').textContent = broad.length
    ? `${broad.join(', ')} is granted, which covers every site. `
      + 'Chrome › Extensions › OpenPosse › Details › Site access is where that is set.'
    : '';
  el('broad-note').hidden = !broad.length;
}

chrome.permissions.onAdded.addListener(paintBroadNote);
chrome.permissions.onRemoved.addListener(paintBroadNote);

// The mock roster: made-up recordings for judging a long roster – see `mocks.js`. Off, then one
// button per size, pressed for whichever the roster is now. The write goes through the worker
// like every other roster change, and the redraw arrives through `storage.onChanged`.

for (const size of [0, ...MOCK_SIZES]) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon';
  button.dataset.size = String(size);
  button.dataset.tipAt = 'start';
  button.textContent = size ? String(size) : 'Off';
  label(button, size ? `Fill the roster to ${size} AI assistants` : 'No mock recordings');
  button.addEventListener('click', async () => {
    const result = await chrome.runtime.sendMessage({ kind: 'openposse.agent.mocks', size })
      .catch((error) => ({ ok: false, reason: error?.message ?? String(error) }));
    if (!result?.ok) {
      const why = result?.reason ?? 'the worker did not answer';
      console.warn('[openposse] the mock roster was not changed –', why);
      el('mock-value').textContent = `not changed – ${why}`;
    }
  });
  el('mock-sizes').append(button);
}

async function paintMocks() {
  const { agents } = await loadRoster();
  mockCount = agents.filter((a) => a.mock).length;
  for (const button of el('mock-sizes').children) {
    const size = Number(button.dataset.size);
    button.setAttribute('aria-pressed', String(size ? mockCount > 0 && agents.length === size : mockCount === 0));
  }
  el('mock-value').textContent = mockCount ? `${agents.length} AI assistants, ${mockCount} made up` : 'off';
  paintDebugToggle();
}

// Site icons, all at once. Chrome only has an icon for a site it has loaded, and a mock roster is
// thirty sites nobody has open. This loads every site still showing a letter in one minimized
// window, reads the icons while every tab is still open, then closes it.

const ICON_WAIT_MS = 20_000;

/** Every assistant's site, and which of them already has an icon to show. */
async function siteIcons() {
  const { agents } = await loadRoster();
  const patterns = Object.fromEntries(await Promise.all(
    agents.map(async (agent) => [agent.id, (await recipeFor(agent))?.domainPattern])));
  return { agents, patterns, icons: await iconPages(patterns) };
}

el('load-icons').addEventListener('click', async () => {
  const button = el('load-icons');
  const value = el('icons-value');
  const misses = el('icons-misses');
  misses.hidden = true;
  if (!await chrome.permissions.contains(ICONS)) {
    value.textContent = 'switch Site icons on first';
    return;
  }
  // One page per site: the bare domain, which is where a vendor keeps its icon.
  const before = await siteIcons();
  const sites = new Map();
  for (const agent of before.agents) {
    const pattern = before.patterns[agent.id];
    if (pattern && !before.icons[agent.id]) sites.set(pattern, `https://${pattern.replace(/^\*\./, '')}/`);
  }
  if (!sites.size) {
    value.textContent = 'every AI assistant has one';
    return;
  }

  button.disabled = true;
  value.textContent = `loading ${sites.size} sites…`;
  let win = null;
  try {
    win = await chrome.windows.create({ url: [...sites.values()], focused: false, state: 'minimized' });
    const ids = win.tabs.map((tab) => tab.id); // in the order of `sites`
    const deadline = Date.now() + ICON_WAIT_MS;
    let tabs = win.tabs;
    while (Date.now() < deadline && tabs.some((tab) => !tab.favIconUrl)) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      tabs = await chrome.tabs.query({ windowId: win.id });
    }
    // With every tab still open, which is when `iconPages` can learn each site's icon – the
    // roster redraws itself from the `iconSites` change that follows.
    const after = await siteIcons();
    const byId = new Map(tabs.map((tab) => [tab.id, tab]));
    const failed = [...sites.keys()].flatMap((pattern, i) => {
      const lit = after.agents.some((a) => after.patterns[a.id] === pattern && after.icons[a.id]);
      return lit ? [] : [`${pattern.replace(/^\*\./, '')} – ${whyNoIcon(byId.get(ids[i]), pattern)}`];
    });
    value.textContent = failed.length ? `${failed.length} of ${sites.size} without an icon` : 'done';
    misses.textContent = failed.join(' · ');
    misses.hidden = failed.length === 0;
  } catch (error) {
    console.warn('[openposse] site icons were not loaded –', error?.message ?? error);
    value.textContent = `not loaded – ${error?.message ?? error}`;
  } finally {
    if (win) {
      await chrome.windows.remove(win.id).catch((error) => {
        console.warn('[openposse] the window that loaded site icons did not close –', error?.message ?? error);
      });
    }
    button.disabled = false;
  }
});

/** Why a site All opened left its assistant with a letter, read from the tab it loaded in. */
function whyNoIcon(tab, pattern) {
  if (!tab) return 'its tab was closed';
  if (!tab.favIconUrl) {
    return tab.status === 'loading' ? `still loading after ${ICON_WAIT_MS / 1000} s` : 'the page has no icon';
  }
  const url = new URL(tab.url);
  if (url.protocol !== 'https:' || patternForHost(url.hostname) !== pattern) return `it went to ${url.origin}`;
  return 'its icon arrived but was not picked up';
}

// A slider moved in another window, the surface was switched elsewhere, or the roster changed.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && KNOBS.some((k) => changes[k.key])) paintKnobs();
  if (area !== 'local') return;
  if (changes.surface) paintSurface();
  if (changes.agents) paintMocks();
});

// ── Setup's sheet ──────────────────────────────────────────────────────────────────────────
//
// The steps, behind the checklist icon beside Debug's. Whether it opens by itself is decided at
// the end, once the checks below have said what is done.
el('setup-sheet').addEventListener('toggle', (event) => {
  el('setup').setAttribute('aria-expanded', String(event.newState === 'open'));
});

// ── Feedback ───────────────────────────────────────────────────────────────────────────────
//
// The form behind the speech-bubble icon, ahead of setup's. It has no backend yet, so
// `sendFeedback` is the one place a real one goes; everything around it already handles both
// outcomes. Nothing here logs what anyone wrote – the kind of feedback at most.

/**
 * Sends one piece of feedback. Resolves `{ ok: true }` once it has been accepted, or
 * `{ ok: false, reason }`. The reason reaches the person, so a new one wants a sentence in
 * `FEEDBACK_REASONS`; until then the code itself is shown rather than nothing.
 */
async function sendFeedback(entry) {
  console.info('[openposse] setup: feedback not sent – no backend yet; kind:', entry.kind ?? 'none');
  return { ok: false, reason: 'no-backend' };
}

const FEEDBACK_REASONS = {
  'no-backend': "Not sent – there's nowhere to send feedback yet. What you wrote is still here.",
};

const feedbackForm = el('feedback-form');
const feedbackStatus = el('feedback-status');
const feedbackSend = el('feedback-send');

// Closing forgets the last outcome, so the next opening starts without yesterday's "Sent". It
// keeps an unsent draft: a click outside closes this too, and that is too easy a way to lose
// a long message. A sent one is cleared by the send itself, below.
el('feedback-sheet').addEventListener('toggle', (event) => {
  el('feedback').setAttribute('aria-expanded', String(event.newState === 'open'));
  if (event.newState === 'closed') {
    feedbackStatus.textContent = '';
    feedbackStatus.classList.remove('bad');
  }
});

feedbackForm.addEventListener('input', () => {
  feedbackSend.disabled = !el('feedback-message').value.trim();
  feedbackStatus.textContent = '';
  feedbackStatus.classList.remove('bad');
});

feedbackForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = el('feedback-email');
  if (!email.checkValidity()) {
    feedbackStatus.textContent = "That email address doesn't look complete.";
    feedbackStatus.classList.add('bad');
    return;
  }
  const entry = {
    kind: feedbackForm.querySelector('input[name="kind"]:checked')?.value ?? null,
    message: el('feedback-message').value.trim(),
    email: email.value.trim() || null,
    version: chrome.runtime.getManifest().version,
  };
  if (!entry.message) return;

  feedbackSend.disabled = true;
  feedbackStatus.classList.remove('bad');
  feedbackStatus.textContent = 'Sending…';
  let result;
  try {
    result = await sendFeedback(entry);
  } catch (error) {
    result = { ok: false, reason: error?.message ?? String(error) };
  }
  if (result.ok) {
    // Ready for the next one, with the address kept – it is the same person.
    feedbackForm.reset();
    email.value = entry.email ?? '';
    feedbackStatus.textContent = 'Sent. Thank you.';
    return;
  }
  // Kept as typed, so a failed send costs nothing but the retry.
  feedbackStatus.textContent = FEEDBACK_REASONS[result.reason] ?? `Not sent – ${result.reason}.`;
  feedbackStatus.classList.add('bad');
  feedbackSend.disabled = false;
});

// ── Appearance ─────────────────────────────────────────────────────────────────────────────
//
// Light or dark, and the panel's orb as a sphere or a waveform. The panel follows both live: the
// theme through `localStorage` (see theme.js), the shape through `chrome.storage`. Both sit at
// the right end of the logo's row, so their labels hang from the right.
mountThemeToggle(el('theme'), { tipAt: 'end' });

async function paintOrbStyle() {
  // Pressed once the setting is stored, so the switch never shows a shape the panel is not using.
  const show = segmented(el('orb-style'), {
    tipAt: 'end',
    label: 'Orb in the panel',
    options: [
      { value: 'sphere', icon: 'orbit', label: 'Orb in the panel: sphere' },
      { value: 'wave', icon: 'audio-waveform', label: 'Orb in the panel: waveform' },
    ],
    value: await orbStyle(),
    onPick: (style) => setOrbStyle(style)
      .then(() => show(style))
      .catch((error) => console.error('[openposse] setup: orb style not saved –', error?.message ?? error)),
  });
}

// ── Size by number ─────────────────────────────────────────────────────────────────────────
//
// Whether the panel's avatars grow when there are few. Off by default; the panel follows the
// switch live (see `sizeAvatars` in sidepanel.js).
async function paintAvatarSizing() {
  const button = el('avatar-sizing');
  const show = (on) => button.setAttribute('aria-checked', String(on));
  show(await avatarsByCount());
  button.addEventListener('click', () => {
    const on = button.getAttribute('aria-checked') !== 'true';
    setAvatarsByCount(on)
      .then(() => show(on))
      .catch((error) => console.error('[openposse] setup: Size by number not saved –', error?.message ?? error));
  });
}

// ── GitHub, and the footer's links ─────────────────────────────────────────────────────────
//
// A placeholder until the repository exists: it opens github.com itself. Change the one URL,
// and the header's icon and every repository link in the footer follow. The website's pages
// and both social accounts are placeholders too.
const GITHUB_URL = 'https://github.com';
const WEBSITE_URL = 'https://openposse.org';
const SOCIAL_URLS = {
  x: 'https://x.com',
  linkedin: 'https://www.linkedin.com',
};

/** Where each footer link goes, by its `data-link`. */
const FOOTER_LINKS = {
  pro: 'https://openposse.com',
  issues: `${GITHUB_URL}/issues`,
  releases: `${GITHUB_URL}/releases`,
  sponsor: 'https://github.com/sponsors',
  licence: `${GITHUB_URL}/blob/main/LICENSE`,
};

/** Opens `url` in a new tab, naming `what` if Chrome refuses. */
function openTab(url, what) {
  chrome.tabs.create({ url }).catch((error) => {
    console.error(`[openposse] setup: ${what} did not open –`, error?.message ?? error);
  });
}

el('website').addEventListener('click', () => openTab(WEBSITE_URL, 'the website'));
el('github').addEventListener('click', () => openTab(GITHUB_URL, 'GitHub'));
for (const button of document.querySelectorAll('[data-social]')) {
  const url = SOCIAL_URLS[button.dataset.social];
  if (url) button.addEventListener('click', () => openTab(url, button.dataset.social));
  else console.warn('[openposse] setup: no address for social', button.dataset.social);
}

for (const link of document.querySelectorAll('.page-foot [data-link]')) {
  const url = FOOTER_LINKS[link.dataset.link];
  if (url) link.href = url;
  else console.warn('[openposse] setup: no address for footer link', link.dataset.link);
}
el('version').textContent = chrome.runtime.getManifest().version;

// The footer's height, for the page's bottom padding: its links wrap in a narrow window.
const footer = document.querySelector('.page-foot');
new ResizeObserver(() => {
  document.body.style.setProperty('--foot', `${footer.offsetHeight}px`);
}).observe(footer);

// The header's hairline, once it is holding at the top rather than sitting where it was.
// A sticky element reports nothing about being stuck, so the observer watches the window less
// its top pixel: a header holding at `top: 0` is then never wholly inside it.
const head = document.querySelector('.page-head');
new IntersectionObserver(
  ([entry]) => head.classList.toggle('stuck', entry.intersectionRatio < 1),
  { threshold: 1, rootMargin: '-1px 0px 0px 0px' },
).observe(head);

// ── Start ──────────────────────────────────────────────────────────────────────────────────

// Each section independently, and loudly when one fails.
//
// **This was a bare sequence of awaits, and that is how the weights section shipped broken.**
// `markDone` was given an id that did not exist, threw on null, and took every later step with
// it – so the page sat on "checking…" with a button that appeared to do nothing and nothing in
// the console to say why. A setup page is a list of independent facts about a machine; one of
// them being unreadable is no reason to stop reporting the rest.
for (const [name, refresh] of Object.entries({
  microphone: refreshMic,
  'speech model': refreshModel,
  shortcut: refreshShortcut,
  'panel access': refreshPanelAccess,
  'voice engine': refreshEngine,
  weights: refreshWeights,
  pace: loadPace,
  sample: loadSample,
  voices: refreshVoices,
  roster: refreshRoster,
  'site icons': refreshIcons,
  'orb style': paintOrbStyle,
  'size by number': paintAvatarSizing,
  'surface switch': paintSurface,
  'debug timings': paintKnobs,
  'mock roster': paintMocks,
  'all-sites note': paintBroadNote,
})) {
  try {
    await refresh();
  } catch (error) {
    console.error(`[openposse] setup: ${name} could not be read –`, error?.message ?? error);
  }
}

// **The setup sheet opens by itself until the three steps the product needs are done** – the
// microphone, the speech model and a shortcut. The rest are optional, or settings rather than
// tasks, so none of them holds it open. Decided here, once, from what the checks above found, and
// never closed by us: shutting it under somebody who has just finished a step would take it away
// while they read. Until 2026-10-06 the steps were a column beside the roster, folded the same way.
const complete = ['step-mic', 'step-model', 'step-shortcut']
  .every((id) => el(id).classList.contains('done'));
el('setup-done').hidden = !complete;
el('setup-title').textContent = complete ? 'Setup complete' : 'Set up OpenPosse';
// Lit while there is something to do, as each step's own next button is.
el('setup').classList.toggle('primary', !complete);
label(el('setup'), complete ? 'Setup – done' : 'Set up OpenPosse');
if (!complete && !el('setup-sheet').matches(':popover-open')) el('setup-sheet').showPopover();

// Shortcuts are changed on another tab, so this page is stale the moment they leave it. Chrome
// has no event for a rebinding – re-reading on focus is the only way the status can be true
// when they come back, and coming back is exactly what they do.
window.addEventListener('focus', () => { refreshShortcut(); });
