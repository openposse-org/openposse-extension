// The three things that have to happen once, and the only page where two of them can.
//
// The microphone prompt and the speech-model download both need a real tab. An offscreen
// document has no UI to show a permission prompt in, and a side panel is documented as failing
// with `NotAllowedError: Permission dismissed` on macOS. This page exists for that reason, not
// for tidiness.

import { loadRoster, importFromMacApp, setMicGranted, micGranted } from './storage.js';
import { channelFor, initialFor } from './channels.js';
import { chooseEngine, describeEngine, hasWebGPU } from './tts.js';
import {
  weightsStatus, downloadWeights, removeWeights, ensureAccess, TOTAL_BYTES, VOICES,
} from './weights.js';
import { speak as speakWithKokoro } from './kokoro.js';

const SR = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
const LANGS = { langs: ['en-US'], processLocally: true };

const el = (id) => document.getElementById(id);
const setStatus = (id, text) => { el(id).textContent = text; };
const markDone = (section, done) => el(section).classList.toggle('done', done);

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
    setStatus('mic-status', 'granted');
  } else {
    setStatus('mic-status', await isBlocked()
      ? 'blocked by Chrome — allow it in this extension’s site settings'
      : 'not granted');
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
    // it from an API that answers `prompt` in three different situations — see `storage.js`.
    await setMicGranted(true);
    await refreshMic();
  } catch (error) {
    await setMicGranted(false);
    setStatus('mic-status', `${error.name} — ${error.message}`);
  }
});

// ── 2. Speech model ────────────────────────────────────────────────────────────────────────

async function refreshModel() {
  if (!SR?.available) {
    setStatus('model-status', 'this browser has no on-device speech recognition');
    el('install-model').disabled = true;
    return false;
  }
  const state = await SR.available(LANGS);
  const ready = state === 'available';
  setStatus('model-status', ready ? 'ready' : state);
  markDone('step-model', ready);
  el('install-model').disabled = ready || state === 'unavailable';

  if (state === 'unavailable') {
    // Worth separating from "not downloaded yet". This is usually a field trial being off
    // rather than anything the user did, and no amount of clicking Download will fix it.
    setStatus('model-status', 'unavailable — on-device recognition is switched off in this Chrome');
  }
  return ready;
}

el('install-model').addEventListener('click', async () => {
  setStatus('model-status', 'downloading…');
  try {
    await SR.install(LANGS);
  } catch (error) {
    setStatus('model-status', `failed: ${error.message}`);
    return;
  }
  await refreshModel();
});

// ── 3. The shortcut ────────────────────────────────────────────────────────────────────────
//
// Here because it cannot be done for them and would otherwise be folklore. A manifest may only
// *suggest* `Ctrl+Shift+[0-9]` for a shortcut that works outside Chrome — but the user's own
// assignment at `chrome://extensions/shortcuts` carries no such restriction, so ⌥V is available
// to anyone who knows the page exists. Telling them beats them not knowing.
//
// A plain link cannot go there: `chrome://` URLs are not navigable from a page, including one
// of ours. `chrome.tabs.create` can.

async function refreshShortcut() {
  const summon = (await chrome.commands.getAll()).find((c) => c.name === 'summon');
  // Deliberately not claiming it is global. Nothing in the API reports that, and saying "press
  // it anywhere" about a Chrome-only binding would be a promise the product cannot keep.
  setStatus('shortcut-status', summon?.shortcut || 'none assigned');
  markDone('step-shortcut', Boolean(summon?.shortcut));
}

el('open-shortcuts').addEventListener('click', async () => {
  await chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// ── 4. Where the panel may appear ──────────────────────────────────────────────────────────
//
// **A global shortcut and `activeTab` are mutually exclusive**, which is why this exists.
// Chrome grants an extension temporary access to the current tab when the user presses its
// shortcut — but not when that shortcut is marked `global`, because such a command can fire
// while Chrome is in the background and there is no tab the gesture belongs to. Measured, after
// two wrong explanations: the same keypress that works on a vendor's page fails on every other
// with "Cannot access contents of url".
//
// Vendor pages work without this, because a recorded assistant already has a host permission of
// its own. Everything else needs the broad grant or nothing.
//
// Offered rather than asked for at install. The prompt Chrome shows is alarming and it should
// be — this is the biggest thing the extension can ask for — so it belongs behind a sentence
// explaining what it buys and a choice the user makes knowingly.

const ALL_SITES = { origins: ['https://*/*'] };

async function refreshPanelAccess() {
  const granted = await chrome.permissions.contains(ALL_SITES);
  setStatus('panel-status', granted
    ? 'on — the panel appears on any page'
    : "off — the panel appears on assistants' pages only");
  markDone('step-panel', granted);
  el('grant-panel').textContent = granted ? 'Turn off' : 'Turn on';
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

// ── 5. Import ──────────────────────────────────────────────────────────────────────────────

el('pick-folder').addEventListener('click', () => el('folder').click());

el('folder').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  if (files.length === 0) return;

  setStatus('import-status', 'reading…');
  const result = await importFromMacApp(files);

  if (result.problem) {
    setStatus('import-status', result.problem);
  } else {
    const parts = [];
    if (result.imported.length) parts.push(`imported ${result.imported.join(', ')}`);
    // Skips are named with their reason. "2 skipped" tells someone nothing they can act on.
    for (const { name, why } of result.skipped) parts.push(`skipped ${name} — ${why}`);
    setStatus('import-status', parts.join(' · ') || 'nothing to import');
  }

  markDone('step-import', result.imported.length > 0);
  await refreshRoster();
  event.target.value = '';     // So choosing the same folder twice fires `change` again.
});

// ── Which engine speaks ────────────────────────────────────────────────────────────────────
//
// Reported rather than chosen. The decision is made from what the machine can actually do, and
// the value of showing it is that "why does it sound like that" has an answer — a person on a
// browser without WebGPU should be told so, not left to wonder.
//
// The offscreen document is the only context that can answer: WebGPU and the voice list both
// live there, and it is created on demand by the worker.

async function refreshEngine() {
  // **Worked out here rather than asked of the offscreen document.**
  //
  // The first version messaged that document for the answer, and it usually does not exist —
  // it is created when a turn starts, and opening settings is not a turn. So the send threw,
  // the catch fell back to the bland "System voices", and the page never showed the *reason*,
  // which is the only part worth reading. It looked like the line was not updating.
  //
  // This page is a Window, so it has `navigator.gpu` and can read the weights itself. Nothing
  // about the choice needs a microphone, and asking something that may not be there for an
  // answer we can compute was the whole mistake.
  const choice = chooseEngine({
    hasWebGPU: await hasWebGPU(),
    hasKokoroAssets: (await weightsStatus()).state === 'ready',
  });
  el('engine').textContent = describeEngine(choice);
}

// ── The neural voices ──────────────────────────────────────────────────────────────────────
//
// **This button is the amended rule's entire justification, so it has to behave like it.** The
// rule now permits a model download that the user starts, from a pinned URL, verified against a
// hash in the build — and each of those is only true because this page does it that way. A
// download that started itself, or that installed whatever arrived, would make the amendment a
// piece of paperwork.
//
// Sizes are shown before anything is fetched, and progress while it is, because 89 MB on a
// hotel connection is a decision and not a detail.

const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;

async function refreshWeights() {
  const { state, have, want } = await weightsStatus();
  const done = state === 'ready';

  el('drop-weights').hidden = !have;
  el('get-weights').hidden = done;
  el('get-weights').textContent = state === 'partial' ? 'Resume' : 'Download';
  // Says what is on disk, and nothing about whether it is being used — the engine line above
  // owns that, and this claiming "used whenever WebGPU is available" directly contradicted it
  // while the engine was still unbuilt. One fact, one place.
  setStatus('weights-status', done
    ? `installed — ${want} files, verified`
    : state === 'partial'
      ? `${have} of ${want} files — interrupted`
      : `not downloaded · ${mb(TOTAL_BYTES)}`);
  markDone('step-weights', done);
  return state;
}

el('get-weights').addEventListener('click', async () => {
  // First, before any await: `permissions.request` needs this click to still be a live user
  // gesture. HuggingFace redirects to a CDN on another host and neither sends `*` for CORS, so
  // without both origins every file fails with a message that says nothing useful.
  const allowed = await ensureAccess();
  if (!allowed) {
    setStatus('weights-status', 'needs access to huggingface.co to download — not granted');
    return;
  }

  el('get-weights').disabled = true;
  setStatus('weights-status', 'starting…');

  let result;
  try {
    result = await downloadWeights({
      onProgress: ({ bytes, totalBytes, done, total }) => {
        setStatus('weights-status', `${mb(bytes)} of ${mb(totalBytes)} · file ${done} of ${total}`);
      },
    });
  } catch (error) {
    // A button that does nothing is the worst outcome available, so nothing gets to throw
    // past here silently — the page says what happened and the console says it precisely.
    console.error('[openposse] weights download threw —', error?.message ?? error);
    setStatus('weights-status', `could not start: ${error?.message ?? error}`);
    el('get-weights').disabled = false;
    return;
  }
  el('get-weights').disabled = false;

  if (!result.ok) {
    // **The reason, not a count of failures.** The first version said "could not download
    // model, bm_george, … — try again" for every cause there is, and the actual message —
    // which named a CORS refusal — was thrown away by this very line. Listing the files told
    // nobody anything; they had all failed for one reason.
    for (const f of result.failed) console.warn('[openposse] weights:', f.id, '—', f.reason);

    const mismatched = result.failed.filter((f) => f.reason === 'mismatch');
    const reasons = [...new Set(result.failed.map((f) => f.reason))];
    setStatus('weights-status', mismatched.length
      ? `refused: ${mismatched.map((f) => f.id).join(', ')} did not match the expected contents`
      : `${result.failed.length} of ${result.failed.length} failed — ${reasons.join(' · ')}`);
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

// ── Trying the voices ──────────────────────────────────────────────────────────────────────
//
// **The same words in every voice**, whatever they are. Different lines per voice would sample
// them; one line lets them be compared, which is the actual question — "which of these should
// Ivan be" is a judgement nobody can make from six different sentences.
//
// Editable, because the right sample depends on what you are listening for. A default that
// suits prosody is no use to somebody checking how a voice handles their own product's
// vocabulary, and vice versa.
//
// This one runs long on purpose: several clauses, a colon, and shifts of pace that a short
// line cannot show. It also crosses HeadTTS's sentence split, so it exercises chunk chaining —
// the thing that made the spike say "Hello" and stop.
const DEFAULT_SAMPLE = 'All men dream, but not equally. Those who dream by night in the dusty '
  + 'recesses of their minds wake in the day to find that it was vanity: but the dreamers of '
  + 'the day are dangerous men, for they may act their dream with open eyes, to make it '
  + 'possible.';

/** What to speak: the box, or the default if it has been emptied. */
function sample() {
  const typed = el('sample').value.trim();
  return typed || DEFAULT_SAMPLE;
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

async function refreshVoices() {
  const ready = (await weightsStatus()).state === 'ready';
  el('voices-section').hidden = !ready;
  if (!ready) return;

  // Only on the first render, so re-rendering after a download does not discard something the
  // user has typed.
  if (!el('sample').value) el('sample').value = DEFAULT_SAMPLE;

  const list = el('voice-list');
  list.textContent = '';

  for (const { id } of VOICES) {
    const { name, accent } = describeVoice(id);
    const row = document.createElement('div');
    row.className = 'voice';

    const label = document.createElement('div');
    label.className = 'name';
    label.textContent = name;
    const sub = document.createElement('div');
    sub.className = 'accent';
    sub.textContent = accent;

    const play = document.createElement('button');
    play.className = 'secondary';
    play.textContent = 'Play';
    play.addEventListener('click', async () => {
      // Every button disabled, not just this one: two voices over each other tells you nothing
      // about either, and the engine speaks one utterance at a time anyway.
      const buttons = [...list.querySelectorAll('button')];
      for (const b of buttons) b.disabled = true;
      play.textContent = 'Loading…';

      const result = await speakWithKokoro(sample(), id);
      if (!result.ok) {
        sub.textContent = result.reason;
        sub.style.color = 'var(--error)';
      }
      play.textContent = 'Play';
      for (const b of buttons) b.disabled = false;
    });

    row.append(label, sub, play);
    list.append(row);
  }
}

// ── Roster ─────────────────────────────────────────────────────────────────────────────────

async function refreshRoster() {
  const { agents, broken, problem } = await loadRoster();
  const target = el('roster');
  target.textContent = '';

  if (problem) {
    target.className = 'card bad';
    target.textContent = problem;
    return;
  }
  target.className = 'card';

  if (agents.length === 0) {
    target.textContent = 'none yet — record one from the toolbar button';
    return;
  }

  for (const agent of agents) {
    const row = document.createElement('div');
    // Everyone is shown lit here: this is a list of what exists, not of who is speaking.
    row.className = 'agent active';
    row.style.setProperty('--channel', channelFor(agent.name));

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = initialFor(agent.name);

    const text = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = agent.name;
    const kind = document.createElement('div');
    kind.className = 'kind';
    // A broken agent is listed, not hidden. It still routes, so being told beats finding out
    // when it is asked a question.
    kind.textContent = broken.includes(agent.id)
      ? 'needs re-recording — its recipe is missing'
      : 'Via browser';

    text.append(name, kind);
    row.append(avatar, text);
    target.append(row);
  }
}

// ── Start ──────────────────────────────────────────────────────────────────────────────────

// Each section independently, and loudly when one fails.
//
// **This was a bare sequence of awaits, and that is how the weights section shipped broken.**
// `markDone` was given an id that did not exist, threw on null, and took every later step with
// it — so the page sat on "checking…" with a button that appeared to do nothing and nothing in
// the console to say why. A setup page is a list of independent facts about a machine; one of
// them being unreadable is no reason to stop reporting the rest.
for (const [name, refresh] of Object.entries({
  microphone: refreshMic,
  'speech model': refreshModel,
  shortcut: refreshShortcut,
  'panel access': refreshPanelAccess,
  'voice engine': refreshEngine,
  weights: refreshWeights,
  voices: refreshVoices,
  roster: refreshRoster,
})) {
  try {
    await refresh();
  } catch (error) {
    console.error(`[openposse] setup: ${name} could not be read —`, error?.message ?? error);
  }
}

// Shortcuts are changed on another tab, so this page is stale the moment they leave it. Chrome
// has no event for a rebinding — re-reading on focus is the only way the status can be true
// when they come back, and coming back is exactly what they do.
window.addEventListener('focus', () => { refreshShortcut(); });
