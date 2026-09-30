// The three things that have to happen once, and the only page where two of them can.
//
// The microphone prompt and the speech-model download both need a real tab. An offscreen
// document has no UI to show a permission prompt in, and a side panel is documented as failing
// with `NotAllowedError: Permission dismissed` on macOS. This page exists for that reason, not
// for tidiness.

import { loadRoster, setMicGranted, micGranted } from './storage.js';
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
      ? 'blocked by Chrome – allow it in this extension’s site settings'
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
    // it from an API that answers `prompt` in three different situations – see `storage.js`.
    await setMicGranted(true);
    await refreshMic();
  } catch (error) {
    await setMicGranted(false);
    setStatus('mic-status', `${error.name} – ${error.message}`);
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
    setStatus('model-status', 'unavailable – on-device recognition is switched off in this Chrome');
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
  setStatus('panel-status', granted
    ? 'on – the panel appears on any page'
    : "off – the panel appears on assistants' pages only");
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

// ── Which engine speaks ────────────────────────────────────────────────────────────────────
//
// Reported rather than chosen. The decision is made from what the machine can actually do, and
// the value of showing it is that "why does it sound like that" has an answer – a person on a
// browser without WebGPU should be told so, not left to wonder.
//
// The offscreen document is the only context that can answer: WebGPU and the voice list both
// live there, and it is created on demand by the worker.

async function refreshEngine() {
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
  el('get-weights').textContent = extending ? 'Add them' : state === 'partial' ? 'Resume' : 'Download';
  // Says what is on disk, and nothing about whether it is being used – the engine line above
  // owns that, and this claiming "used whenever WebGPU is available" directly contradicted it
  // while the engine was still unbuilt. One fact, one place.
  setStatus('weights-status', done
    ? `installed – ${want} files, verified`
    : extending
      ? `${want - have} more voices available · ${mb(missingBytes)}`
      : state === 'partial'
        ? `${have} of ${want} files – interrupted`
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
    setStatus('weights-status', 'needs access to huggingface.co to download – not granted');
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
    // past here silently – the page says what happened and the console says it precisely.
    console.error('[openposse] weights download threw –', error?.message ?? error);
    setStatus('weights-status', `could not start: ${error?.message ?? error}`);
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
      : `${result.failed.length} of ${result.failed.length} failed – ${reasons.join(' · ')}`);
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
// them; one line lets them be compared, which is the actual question – "which of these should
// Ivan be" is a judgement nobody can make from six different sentences.
//
// Editable, because the right sample depends on what you are listening for. A default that
// suits prosody is no use to somebody checking how a voice handles their own product's
// vocabulary, and vice versa.
//
// This one runs long on purpose: several clauses, a colon, and shifts of pace that a short
// line cannot show. It also crosses HeadTTS's sentence split, so it exercises chunk chaining –
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

/**
 * The four accent groups, in the order they are offered.
 *
 * Fixed here rather than derived from `VOICES`, whose order is the *assignment* order and puts
 * the six original voices first so nobody's agent changes voice – see the note on `VOICES`.
 * Reading that order into the UI would produce four groups interleaved by history.
 */
const VOICE_GROUPS = ['British female', 'British male', 'American female', 'American male'];

/** Every voice in one accent group, by name, because that is how somebody scans 28 of them. */
const voicesIn = (accent) => VOICES
  .map(({ id }) => ({ id, ...describeVoice(id) }))
  .filter((v) => v.accent === accent)
  .sort((a, b) => a.name.localeCompare(b.name));

async function refreshVoices() {
  const ready = (await weightsStatus()).state === 'ready';
  el('voices-section').hidden = !ready;
  if (!ready) return;

  // Only on the first render, so re-rendering after a download does not discard something the
  // user has typed.
  if (!el('sample').value) el('sample').value = DEFAULT_SAMPLE;

  const list = el('voice-list');
  list.textContent = '';

  // Grouped, because 28 rows of "Play" with the accent repeated on every one is a wall. The
  // heading carries the accent, so the row's second line is free to carry a failure instead –
  // which is what it is really for.
  for (const accent of VOICE_GROUPS) {
    const voices = voicesIn(accent);
    if (voices.length === 0) continue;

    const heading = document.createElement('div');
    heading.className = 'voice-group';
    heading.textContent = accent;
    list.append(heading);

    for (const { id, name } of voices) renderVoice(list, id, name);
  }
}

/** One row of the try-it list: a name, a line for whatever goes wrong, and a Play button. */
function renderVoice(list, id, name) {
  const row = document.createElement('div');
  row.className = 'voice';

  const label = document.createElement('div');
  label.className = 'name';
  label.textContent = name;
  const sub = document.createElement('div');
  sub.className = 'accent';

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
    // The same breakdown the turn logs, because this page is where a voice gets judged and
    // "it played and I heard nothing" needs the same two numbers to be answerable here.
    const m = result.ms ?? {};
    console.info(`[openposse] voice ${id} · first word ${m.firstWord ?? '?'}ms · `
      + `synth ${m.synth ?? '?'}ms → ${m.audio ?? '?'}ms `
      + `audio in ${m.chunks ?? '?'} chunks at ${m.rate ?? '?'}Hz · peak ${m.peak ?? '?'} · `
      + `spoke ${m.play ?? '?'}ms${result.ok ? '' : ` · ${result.reason}`}`);
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
    target.textContent = 'none yet – record one from the toolbar button';
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

    // Named so the rail can give it a line of its own. The roster now sits in a 340px column
    // rather than the 620px one this row was laid out for, and the alternative – selecting it
    // as "the child with no class" – breaks silently the first time anyone adds one.
    const text = document.createElement('div');
    text.className = 'who';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = agent.name;
    const kind = document.createElement('div');
    kind.className = 'kind';
    // A broken agent is listed, not hidden. It still routes, so being told beats finding out
    // when it is asked a question.
    kind.textContent = broken.includes(agent.id)
      ? 'needs re-recording – its recipe is missing'
      : 'Via browser';

    text.append(name, kind);
    row.append(avatar, text);

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
    // **Only the voices that are actually downloaded**, because offering one that is not on
    // disk would fail at the first answer, three layers from anything that could explain it.
    // Empty is a real choice rather than an absence: it hands the agent back to the accent
    // heuristic, which keeps every agent sounding different as the roster grows.
    //
    // Grouped by accent now that there are 28 of them. A flat list of six was a list; a flat
    // list of 28 is a search, and the first thing anyone narrows by is whether they want a
    // British voice or an American one.
    const voice = document.createElement('select');
    voice.className = 'voice-pick';
    voice.setAttribute('aria-label', `Voice for ${agent.name}`);

    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Chosen for me';
    voice.append(auto);

    for (const accent of VOICE_GROUPS) {
      const group = document.createElement('optgroup');
      group.label = accent;
      for (const { id, name } of voicesIn(accent)) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = name;
        group.append(option);
      }
      voice.append(group);
    }
    voice.value = VOICES.some((v) => v.id === agent.voice) ? agent.voice : '';

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
      if (voice.value) speakWithKokoro(sample(), voice.value).catch(() => {});
    });

    // ── What it captured, re-recording, and removing ───────────────────────────────────
    const tools = document.createElement('div');
    tools.className = 'tools';

    const say = (message, bad = false) => {
      problemLine.textContent = message;
      problemLine.className = bad ? 'kind bad' : 'kind';
      problemLine.hidden = false;
    };

    // **See** – the recipe as the runtime will read it, not a reconstruction of it.
    const details = document.createElement('pre');
    details.className = 'recipe';
    details.hidden = true;

    const see = document.createElement('button');
    see.className = 'ghost';
    see.textContent = 'See';
    see.addEventListener('click', async () => {
      if (!details.hidden) { details.hidden = true; see.textContent = 'See'; return; }

      const result = await chrome.runtime
        .sendMessage({ kind: 'openposse.agent.recipe', agentId: agent.id })
        .catch((error) => ({ ok: false, reason: String(error?.message ?? error) }));

      if (!result?.ok || !result.recipe) {
        say(result?.reason ?? 'its recipe is missing', true);
        return;
      }
      details.textContent = describeRecipe(result.recipe);
      details.hidden = false;
      see.textContent = 'Hide';
    });

    // **Re-record** – same wizard, keeping this agent's name and voice.
    const again = document.createElement('button');
    again.className = 'ghost';
    again.textContent = 'Re-record';
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
    const remove = document.createElement('button');
    remove.className = 'ghost bad';
    remove.textContent = 'Delete';
    let armed = false;
    remove.addEventListener('click', async () => {
      if (!armed) {
        armed = true;
        remove.textContent = 'Sure?';
        // Disarms itself, so a stray click cannot leave a loaded button waiting for the next one.
        setTimeout(() => { armed = false; remove.textContent = 'Delete'; }, 4000);
        return;
      }
      const result = await chrome.runtime
        .sendMessage({ kind: 'openposse.agent.remove', agentId: agent.id })
        .catch((error) => ({ ok: false, reason: String(error?.message ?? error) }));

      if (!result?.ok) { say(result?.reason ?? 'could not delete', true); return; }
      await refreshRoster();
    });

    tools.append(see, again, remove);
    text.append(problemLine, details);
    row.append(rename, voice, tools);
    target.append(row);
  }
}

/**
 * A recipe as something a person can read.
 *
 * Every field, including the ones that are null: "there is no busy indicator" is a fact about
 * this recording worth seeing, and a list that silently omits what it does not have cannot be
 * used to check anything.
 */
function describeRecipe(recipe) {
  const rows = [
    ['site', recipe.domainPattern],
    ['opens with', recipe.openMethod === 'shortcut'
      ? [recipe.shortcut?.metaKey && '⌘', recipe.shortcut?.ctrlKey && '⌃',
        recipe.shortcut?.altKey && '⌥', recipe.shortcut?.shiftKey && '⇧',
        recipe.shortcut?.key?.toUpperCase()].filter(Boolean).join(' ')
      : recipe.openSelector],
    ['message box', recipe.inputSelector],
    ['sends with', recipe.submitMethod === 'enterKey' ? '↩ Enter' : recipe.submitSelector],
    ['answer appears', recipe.responseContainerSelector],
    ['knows when done', recipe.busySelector ?? '– none, so a timer is used'],
    ['quiet period', `${recipe.quietPeriodMs ?? 900} ms`],
    ['gives up after', `${Math.round((recipe.responseTimeoutMs ?? 60000) / 1000)} s`],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value ?? '–'}`).join('\n');
}

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
  voices: refreshVoices,
  roster: refreshRoster,
})) {
  try {
    await refresh();
  } catch (error) {
    console.error(`[openposse] setup: ${name} could not be read –`, error?.message ?? error);
  }
}

// Shortcuts are changed on another tab, so this page is stale the moment they leave it. Chrome
// has no event for a rebinding – re-reading on focus is the only way the status can be true
// when they come back, and coming back is exactly what they do.
window.addEventListener('focus', () => { refreshShortcut(); });
