// The three things that have to happen once, and the only page where two of them can.
//
// The microphone prompt and the speech-model download both need a real tab. An offscreen
// document has no UI to show a permission prompt in, and a side panel is documented as failing
// with `NotAllowedError: Permission dismissed` on macOS. This page exists for that reason, not
// for tidiness.

import { loadRoster, importFromMacApp, setMicGranted, micGranted } from './storage.js';
import { channelFor, initialFor } from './channels.js';

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

// ── 3. Import ──────────────────────────────────────────────────────────────────────────────

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

await refreshMic();
await refreshModel();
await refreshRoster();
