// The steps that have to happen once, shared by Settings, its onboarding and the side panel.
//
// **Every status is read from Chrome, never from a stored "done" flag.** Onboarding can be
// closed half-way, the worker is killed after ~30 s idle, and Settings can change any of these
// later – so "how far has this person got" is answered fresh each time, from the things that are
// actually true. That is what makes resuming free: there is no cursor to save or get wrong.
//
// The one exception is the microphone, and it is not really one: `permissions.query` cannot tell
// "never asked" from "granted" from a popup or a panel, so the page that called `getUserMedia`
// records what happened (see `storage.js`). That record is a fact Chrome reported, not a tick.
//
// Nothing here opens a tab. The files that do – Settings and its onboarding – are the only ones
// `test/tabs.test.mjs` lets do it, and a shared module that could would widen that to every page
// importing it.

import { loadRoster, lassoFor, micGranted, setMicGranted } from './storage.js';
import { matchPattern } from './domain.js';
import { groupingOn, groupingState } from './grouping.js';

const SR = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
const LANGS = { langs: ['en-US'], processLocally: true };

// ── Microphone ─────────────────────────────────────────────────────────────────────────────

/** `denied` is the one state `permissions.query` is unambiguous about, and the one we cannot fix. */
export async function micBlocked() {
  try {
    return (await navigator.permissions.query({ name: 'microphone' })).state === 'denied';
  } catch (error) {
    console.warn('[openposse] could not query the microphone permission –', error?.message ?? error);
    return false;
  }
}

/** `granted`, `blocked` (only Chrome's site settings can fix it) or `ask`. */
export async function micState() {
  if (await micGranted()) return 'granted';
  return (await micBlocked()) ? 'blocked' : 'ask';
}

/**
 * Asks for the microphone, and records the answer. Needs a real tab: an offscreen document has
 * no UI to prompt in, and a side panel fails with `NotAllowedError` on macOS.
 *
 * Rejects with Chrome's own error, so the caller can say which of "dismissed", "blocked" and "no
 * microphone" it was.
 */
export async function askForMic() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Released at once. The *grant* is what persists; holding the device would light the
    // recording indicator for no reason and worry people.
    for (const track of stream.getTracks()) track.stop();
    // Recorded here because this is the only place that knows. Everywhere else has to infer
    // it from an API that answers `prompt` in three different situations – see `storage.js`.
    await setMicGranted(true);
  } catch (error) {
    await setMicGranted(false);
    throw error;
  }
}

/**
 * Calls `onChange` when Chrome's own record of the microphone permission changes – unblocking
 * it in the site settings, say – so a page can tick without being reloaded.
 */
export async function watchMicPermission(onChange) {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    status.addEventListener('change', onChange);
  } catch (error) {
    console.warn('[openposse] cannot watch the microphone permission –', error?.message ?? error);
  }
}

// ── Speech model ───────────────────────────────────────────────────────────────────────────

/**
 * `ready`, `downloadable`, `downloading`, `unavailable` (on-device recognition is switched off in
 * this Chrome, usually a field trial rather than anything the user did) or `unsupported` (this
 * browser has none at all). The last two cannot be fixed by pressing a button.
 */
export async function modelState() {
  if (!SR?.available) return 'unsupported';
  const state = await SR.available(LANGS);
  return state === 'available' ? 'ready' : state;
}

/** Downloads the local speech model. Rejects with the recogniser's error. */
export async function installModel() {
  await SR.install(LANGS);
}

// ── Pinned to the toolbar ──────────────────────────────────────────────────────────────────

/**
 * Whether OpenPosse is pinned. There is no change event for this, so a page asks again when it
 * regains focus. `null` when Chrome cannot say (an older version), which is not the same as no.
 */
export async function pinned() {
  try {
    return (await chrome.action.getUserSettings()).isOnToolbar === true;
  } catch (error) {
    console.warn('[openposse] cannot read whether the toolbar icon is pinned –', error?.message ?? error);
    return null;
  }
}

// ── The shortcut ───────────────────────────────────────────────────────────────────────────

/**
 * The key that summons OpenPosse, as Chrome writes it, or `''` with none assigned. Read every
 * time and never hardcoded: the binding is the user's, and they may have changed it.
 */
export async function shortcutKey() {
  const summon = (await chrome.commands.getAll()).find((c) => c.name === 'summon');
  return summon?.shortcut ?? '';
}

// ── The OpenPosse tab group ────────────────────────────────────────────────────────────────

/**
 * Whether the tab group question has an answer: grouping is on (the permission is held), or
 * onboarding recorded a no. Switching it on in Settings answers it too.
 */
export async function groupingAnswered() {
  return (await groupingOn()) || (await groupingState()).asked;
}

// ── The first assistant ────────────────────────────────────────────────────────────────────

/**
 * The roster's first assistant that can answer, as the roster is arranged, or `null` with none
 * yet. **One whose site is allowed**: the lassos that come with OpenPosse are in the roster from
 * the install, before anyone could allow their sites, and do not count until they are.
 */
export async function firstAssistant() {
  const { arranged } = await loadRoster();
  for (const agent of arranged) {
    const pattern = (await lassoFor(agent))?.domainPattern;
    if (pattern && await chrome.permissions.contains({ origins: [matchPattern(pattern)] })) return agent;
  }
  return null;
}

// ── Asking Settings to show onboarding ─────────────────────────────────────────────────────

/**
 * The session key a request to show onboarding is left under. Settings opens it when it finds
 * one, and clears it, so the request is for the next Settings to load or the one already open –
 * `openOptionsPage()` only brings an open one to the front, and could not say why.
 */
export const ONBOARDING_REQUEST = 'onboarding';

/** Leaves the request. For the install and the side panel's "Finish setting up", by the worker. */
export async function requestOnboarding() {
  await chrome.storage.session.set({ [ONBOARDING_REQUEST]: Date.now() });
}

// ── Where somebody has got to ──────────────────────────────────────────────────────────────

/**
 * Onboarding's steps, in order, each in the task that holds it. `optional` ones never hold
 * anybody up: skipping them is allowed, and "Finish setting up" does not nag about them.
 *
 * The shortcut comes first, by the owner's call of 2026-10-25: it is the one thing people use
 * every day, and it is already done for most, since the manifest suggests one.
 */
export const STEPS = [
  { id: 'welcome' },
  { id: 'shortcut', task: 'permissions' },
  { id: 'mic', task: 'permissions' },
  { id: 'pin', task: 'permissions', optional: true },
  // Before the first assistant, so its tab can be the first to join the group.
  { id: 'grouping', task: 'permissions' },
  { id: 'model', task: 'downloads' },
  // A neural voice, by the owner's call of 2026-10-26: the system voices are a fallback, not
  // where somebody should finish setting up. Phonon, Supertonic or Kokoro.
  { id: 'voice', task: 'downloads' },
  { id: 'assistant', task: 'lasso' },
  { id: 'done' },
];

/**
 * The three tasks onboarding is split into, by the owner's call of 2026-10-25: Chrome's
 * permissions and the simple toggles, the downloads (the speech model and a neural voice), and
 * the AI assistants – allowing the ones that come with OpenPosse, or lassoing one (renamed from
 * "Your first lasso" on 2026-10-26, when those started being added at install).
 */
export const TASKS = [
  { id: 'permissions', label: 'Permissions' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'lasso', label: 'Your AI assistants' },
];

/**
 * How far one task has got, as its tab says it: `{ done, of }`, counting its steps that are done.
 * A skipped optional step is not done, so it still counts against `of`.
 */
export function taskProgress(task, done) {
  const steps = STEPS.filter((step) => step.task === task);
  return { done: steps.filter((step) => done[step.id]).length, of: steps.length };
}

/** The task a step belongs to, or `null` for the welcome and the end. */
export const taskOf = (stepId) => STEPS.find((step) => step.id === stepId)?.task ?? null;

/**
 * Which steps are done, which one is next, and which task onboarding opens on (`null` for the
 * welcome screen), from what is true now.
 *
 * `facts` is `{ started, mic, model, voice, pin, shortcut, grouping, assistant, skipped }`:
 * `voice` is `ready` (Phonon, Supertonic agreed to, or Kokoro, downloaded), `missing`, or
 * `unsupported` (nothing could speak however much was downloaded – no longer reported since
 * Phonon, which needs no WebGPU, but still honoured); `started` is
 * whether "Let's get you set up" was pressed (or anything after it is already done, which
 * means it was, some other time), `grouping` whether the tab group question has an answer –
 * either one, since grouping is a choice rather than a requirement – and `skipped` the optional
 * steps passed over this time.
 *
 * Pure, so the rules are tested without a browser.
 */
export function progress(facts) {
  const { mic, model, voice, pin, shortcut, grouping, assistant, skipped = [] } = facts;
  // Not the model: Chrome may have it already, for its own captions, before anyone pressed anything.
  const later = mic === 'granted' || Boolean(assistant);
  const done = {
    welcome: Boolean(facts.started) || later,
    mic: mic === 'granted',
    model: model === 'ready',
    voice: voice === 'ready',
    pin: pin === true,
    shortcut: Boolean(shortcut),
    grouping: Boolean(grouping),
    assistant: Boolean(assistant),
  };
  // A speech model this Chrome cannot have may be passed over too: typing in the side panel still
  // works, and a card that can never tick would be the end of the page.
  // The same for a voice that cannot speak here, should that ever be reported again.
  const impossible = {
    model: model === 'unavailable' || model === 'unsupported',
    voice: voice === 'unsupported',
  };
  const skippable = (step) => step.optional || Boolean(impossible[step.id]);
  const passed = (step) => done[step.id] || (skippable(step) && skipped.includes(step.id));
  const current = STEPS.find((step) => step.id !== 'done' && !passed(step))?.id ?? 'done';
  done.done = current === 'done';
  // The task onboarding opens on: the first holding a step OpenPosse needs that can still be
  // done. An optional step never decides it, so an unpinned icon does not send somebody back to
  // the first task every time, and nor does a speech model or a voice this Chrome cannot have.
  const needed = STEPS.find((step) => step.task && !step.optional && !done[step.id]
    && !impossible[step.id]);
  const task = done.welcome ? needed?.task ?? TASKS.at(-1).id : null;
  // The tasks still holding such a step. Downloads keeps its Next until it is out of this list,
  // by the owner's call of 2026-10-26.
  const waiting = [...new Set(STEPS.filter((step) => step.task && !step.optional && !done[step.id]
    && !impossible[step.id]).map((step) => step.task))];
  return { done, current, task, waiting };
}

/**
 * Whether a step OpenPosse cannot work without is still to do, and can be. For the side panel's
 * "Finish setting up", which has its own card for the first assistant, so that is not counted.
 * Nor is a speech model this Chrome cannot have: offering to finish something that cannot be
 * finished is a link that never goes away.
 */
export function unfinished({ mic, model, shortcut }) {
  return mic !== 'granted' || model === 'downloadable' || model === 'downloading' || !shortcut;
}
