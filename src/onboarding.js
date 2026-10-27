// Onboarding: a modal over Settings with a welcome, then three tasks – Chrome's permissions and
// the simple toggles, the downloads, and the AI assistants – that can be moved between freely.
//
// **In Settings, not a page of its own,** by the owner's call of 2026-10-25. The microphone
// prompt needs a tab (a side panel's fails with `NotAllowedError: Permission dismissed`, measured
// on macOS the same day), and Settings is the tab that already has the shortcut, microphone,
// speech model and voice steps working. Those steps are **moved** in from the setup sheet while
// the modal is open and put back when it closes, so each has one control and one set of rules;
// what is new here is the pin, the tab group, the assistants, and the way between them.
//
// **Nothing about how far somebody got is saved.** Every step is read fresh from Chrome (see
// `steps.js`), so closing half-way and coming back – from the side panel's "Finish setting up" –
// opens on the first task with something still to do.
//
// **It opens no tab.** It had six site tiles that did until 2026-10-26, when the lassos that come
// with OpenPosse started being added at install; the last task allows their sites instead.

import {
  micState, modelState, pinned, shortcutKey, groupingAnswered, firstAssistant,
  progress, taskProgress, TASKS, ONBOARDING_REQUEST,
} from './steps.js';
import { GROUPING, groupingOn, markGroupingAsked, turnGroupingOff } from './grouping.js';
import { icon } from './icons.js';
import { hasWebGPU, agreedToSupertonic } from './tts.js';
import { KOKORO, SUPERTONIC, PHONON } from './weights.js';
import { engineSettings, loadRoster, lassoFor } from './storage.js';
import { matchPattern } from './domain.js';
import { productLabel } from './routing.js';
import { channelOf, initialFor } from './channels.js';

const el = (id) => document.getElementById(id);
const dialog = el('onboarding');

/** The setup sheet's steps each task borrows, in the order they come, ahead of its own. */
const BORROWED = {
  permissions: ['step-shortcut', 'step-mic'],
  downloads: ['step-model', 'step-weights'],
};

/** What only this modal knows: the welcome was passed, the pin was skipped, the task in front. */
const local = { started: false, skipped: [], task: null };
let facts = null;
let shown = progress({ mic: 'ask', model: 'downloadable' });
/** Where each borrowed step came from, so closing puts it back. */
const homes = [];
let polling = null;

/**
 * The window this page is in, known before any click. `sidePanel.open()` must be the first thing
 * a click does – one await before it and Chrome refuses, because the gesture is spent – so it
 * cannot be looked up then.
 */
let windowId = null;
chrome.windows.getCurrent()
  .then((win) => { windowId = win.id; })
  .catch((error) => console.warn('[openposse] could not read this page’s window –', error?.message ?? error));

/** A step's status chip, in the setup sheet's tones – see setup.html. */
function chip(id, text, tone = '') {
  el(id).textContent = text;
  el(id).dataset.tone = tone;
}

/** Says something under a task, in a tone, or clears it. */
function note(id, text, tone = '') {
  el(id).hidden = !text;
  el(id).textContent = text ?? '';
  el(id).dataset.tone = tone;
}

// ── Borrowing the sheet's steps ────────────────────────────────────────────────────────────

function borrow() {
  for (const [task, ids] of Object.entries(BORROWED)) {
    const panel = el(`ob-${task}`);
    const first = panel.firstElementChild;
    for (const [index, id] of ids.entries()) {
      const step = el(id);
      const mark = document.createComment(`${id} is in onboarding`);
      step.replaceWith(mark);
      const num = step.querySelector('.num');
      homes.push({ step, mark, num, was: num.textContent });
      num.textContent = String(index + 1);
      panel.insertBefore(step, first);
    }
  }
}

function giveBack() {
  for (const { step, mark, num, was } of homes.splice(0)) {
    num.textContent = was;
    mark.replaceWith(step);
  }
}

// ── Reading where things stand ─────────────────────────────────────────────────────────────

async function read() {
  gpu ??= hasWebGPU();
  const [mic, model, voice, pin, shortcut, grouping, groupingIsOn, assistant, roster, webgpu] = await Promise.all([
    micState(), modelState(), voiceState(), pinned(), shortcutKey(), groupingAnswered(), groupingOn(),
    firstAssistant(), rosterAccess(), gpu,
  ]);
  return { mic, model, voice, pin, shortcut, grouping, groupingIsOn, assistant, roster, webgpu };
}

/**
 * The roster, each with its site and whether that site is allowed: `[{ agent, site, allowed }]`.
 * The lassos that come with OpenPosse are added at install, before anyone could allow anything,
 * so on a first run this is them, waiting.
 */
async function rosterAccess() {
  const { arranged } = await loadRoster();
  return Promise.all(arranged.map(async (agent) => {
    const site = (await lassoFor(agent))?.domainPattern ?? null;
    const allowed = Boolean(site) && await chrome.permissions.contains({ origins: [matchPattern(site)] });
    return { agent, site, allowed };
  }));
}

/** WebGPU does not come and go while the page is open, so it is asked once. */
let gpu = null;

/**
 * Whether a neural voice can speak: `ready` for Phonon downloaded, or with WebGPU for Supertonic
 * downloaded and agreed to or Kokoro downloaded – the same test the engine choice makes – and
 * `missing` otherwise. Never `unsupported` any more: Phonon runs without WebGPU, so every machine
 * can finish this step. Read here rather than in steps.js, which the worker loads, and has no use
 * for weights.
 */
async function voiceState() {
  gpu ??= hasWebGPU();
  const [webgpu, phonon, supertonic, kokoro, { agreement }] = await Promise.all([
    gpu, PHONON.status(), SUPERTONIC.status(), KOKORO.status(), engineSettings(),
  ]);
  const gpuSpeaks = (supertonic.state === 'ready' && agreedToSupertonic(agreement)) || kokoro.state === 'ready';
  return phonon.state === 'ready' || (webgpu && gpuSpeaks) ? 'ready' : 'missing';
}

async function refresh() {
  if (!dialog.open) return;
  try {
    facts = await read();
  } catch (error) {
    // Named, and the modal stays where it was: a failed read is not a reason to move.
    console.warn('[openposse] could not read the setup steps –', error?.message ?? error);
    return;
  }
  shown = progress({ ...local, ...facts });
  draw();
  // The borrowed steps' own chips are setup.js's, and were left saying "not downloaded yet"
  // while this read "ready" – the owner's report of 2026-10-25. So Settings reads them again too.
  dialog.dispatchEvent(new Event('recheck'));
}

// ── Drawing ────────────────────────────────────────────────────────────────────────────────

function draw() {
  const welcome = local.task === null;
  el('ob-welcome').hidden = !welcome;
  el('ob-tasks').hidden = welcome;
  if (welcome) return;

  const at = TASKS.findIndex((task) => task.id === local.task);
  el('ob-tabs').replaceChildren(...TASKS.map((task, index) => {
    const { done, of } = taskProgress(task.id, shown.done);
    const finished = done === of;
    const tab = document.createElement('button');
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(index === at));
    tab.setAttribute('aria-controls', `ob-${task.id}`);
    tab.classList.toggle('done', finished && index !== at);
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.replaceChildren(finished && index !== at ? icon('check', { size: 12 }) : String(index + 1));
    const words = document.createElement('span');
    words.className = 'words';
    const name = document.createElement('span');
    name.textContent = task.label;
    const status = document.createElement('span');
    status.textContent = finished ? 'done' : done === 0 ? 'not started' : `${done} of ${of} done`;
    words.append(name, status);
    tab.append(badge, words);
    // The assistants come after the downloads, by the tab as much as by Next.
    tab.disabled = task.id === 'lasso' && shown.waiting?.includes('downloads');
    tab.addEventListener('click', () => go(task.id));
    return tab;
  }));
  for (const task of TASKS) el(`ob-${task.id}`).hidden = task.id !== local.task;
  el('ob-next').textContent = at === TASKS.length - 1 ? 'Done' : 'Next';
  drawDownloading();

  drawPin();
  drawGrouping();
  drawAssistant();
  drawGpu();
}

/**
 * Whether this Chrome has WebGPU, said where it matters, by the owner's ask of 2026-10-26. Since
 * Phonon it decides which downloads will speak rather than whether any can: Phonon does without.
 */
function drawGpu() {
  if (!facts) return;
  if (!facts.webgpu) {
    chip('ob-gpu', 'no WebGPU in this Chrome – Phonon will still speak; Supertonic and Kokoro won’t', 'warn');
  } else {
    chip('ob-gpu', 'WebGPU available', 'good');
  }
}

/**
 * Next waits while a download runs, by the owner's call of 2026-10-25, so nobody moves on
 * thinking it is done. The count is setup.js's, on the root element, since it starts them.
 * On Downloads it also waits until the speech model and a voice are there (2026-10-26); the
 * first lasso's tab waits with it, and "Finish later" always closes.
 */
function drawDownloading() {
  const busy = Number(document.documentElement.dataset.downloading ?? 0) > 0;
  const owed = local.task === 'downloads' && shown.waiting?.includes('downloads');
  el('ob-next').disabled = busy || owed;
  note('ob-busy', busy ? 'Downloading – keep this tab open until it finishes.'
    : owed ? `Download ${shown.done.model ? 'a voice' : 'the speech model'} to go on.` : '');
}

function drawPin() {
  const skipped = local.skipped.includes('pin');
  if (facts.pin) chip('pin-status', 'pinned', 'good');
  else if (facts.pin === null) chip('pin-status', 'Chrome can’t say whether it is pinned');
  else chip('pin-status', skipped ? 'skipped' : 'not pinned');
  el('step-pin').classList.toggle('done', facts.pin === true);
  el('skip-pin').hidden = facts.pin === true || skipped;
}

/**
 * The switch shows what Chrome holds, always. The step ticks once the question has an answer:
 * on, or a no from "Not now" or from switching it off.
 */
function drawGrouping() {
  el('ob-grouping').setAttribute('aria-checked', String(facts.groupingIsOn));
  el('step-grouping').classList.toggle('done', Boolean(facts.grouping));
  el('ob-grouping-no').hidden = Boolean(facts.grouping);
}

/**
 * The assistants already here and whether each is allowed, with one Allow all for the rest – one
 * Chrome dialog naming every site. Read from Chrome each time, like the steps.
 */
function drawRoster() {
  const roster = facts.roster ?? [];
  el('ob-builtins').hidden = roster.length === 0;
  el('ob-builtin-list').replaceChildren(...roster.map(({ agent, site, allowed }) => {
    const row = document.createElement('li');
    const mono = document.createElement('span');
    mono.className = 'mono';
    mono.style.setProperty('--tile', channelOf(agent));
    mono.textContent = initialFor(agent.name);
    mono.setAttribute('aria-hidden', 'true');
    const who = document.createElement('span');
    who.className = 'who';
    const name = document.createElement('span');
    name.textContent = agent.name;
    const where = document.createElement('span');
    where.textContent = [productLabel(site), site?.replace(/^\*\./, '')].filter(Boolean).join(' · ');
    who.append(name, where);
    const state = document.createElement('span');
    state.className = 'status tech chip';
    state.textContent = allowed ? 'allowed' : 'not allowed yet';
    state.dataset.tone = allowed ? 'good' : 'warn';
    row.append(mono, who, state);
    return row;
  }));
  const waiting = waitingSites();
  el('ob-allow').hidden = waiting.length === 0;
  el('ob-allow').textContent = waiting.length > 1 ? `Allow all ${waiting.length} sites` : 'Allow it';
}

/** The sites still waiting for their Allow, each once – read in the click, so nothing is awaited. */
const waitingSites = () => [...new Set((facts?.roster ?? [])
  .filter(({ site, allowed }) => site && !allowed).map(({ site }) => site))];

el('ob-allow').addEventListener('click', () => {
  const sites = waitingSites();
  if (sites.length === 0) return;
  note('ob-lasso-note', '');
  // First statement, nothing awaited before it: Chrome's own dialog, naming every site.
  chrome.permissions.request({ origins: sites.map(matchPattern) })
    .then((granted) => {
      if (!granted) note('ob-lasso-note', 'Chrome didn’t get a yes, so they wait. You can allow them here or in Settings.');
    })
    .catch((error) => note('ob-lasso-note', `Chrome refused the request – ${error?.message ?? error}`, 'bad'))
    .then(refresh);
});

function drawAssistant() {
  drawRoster();
  const name = facts.assistant?.name;
  if (name) {
    const how = facts.shortcut ? `press ${facts.shortcut} and say “${name}, …”` : `say “${name}, …” in the side panel`;
    chip('ob-assistant-status', `${name} is ready – ${how}`, 'good');
  } else {
    chip('ob-assistant-status', facts.roster?.length
      ? 'none allowed yet – this ticks itself when you allow one, or lasso one'
      : 'no assistants yet – this ticks itself when you lasso one');
  }
}

// ── Moving between tasks ───────────────────────────────────────────────────────────────────

/** Shows a task. */
function go(task) {
  local.task = task;
  draw();
  el(`ob-${task}`).scrollTop = 0;
}

el('ob-start').addEventListener('click', () => {
  local.started = true;
  shown = progress({ ...local, ...facts });
  go(shown.task ?? TASKS[0].id);
});

el('ob-back').addEventListener('click', () => {
  const at = TASKS.findIndex((task) => task.id === local.task);
  if (at === 0) {
    local.task = null;
    draw();
  } else {
    go(TASKS[at - 1].id);
  }
});

el('ob-next').addEventListener('click', () => {
  const at = TASKS.findIndex((task) => task.id === local.task);
  if (at === TASKS.length - 1) dialog.close();
  else go(TASKS[at + 1].id);
});

el('ob-later').addEventListener('click', () => dialog.close());
for (const button of dialog.querySelectorAll('.ob-close')) button.addEventListener('click', () => dialog.close());

// ── The steps that are this modal's own ────────────────────────────────────────────────────

el('skip-pin').addEventListener('click', () => {
  local.skipped.push('pin');
  refresh();
});

// Settings' switch: on asks Chrome there and then, as **the first statement of the click**,
// because a gesture does not survive an await; off ungroups the tabs. Until 2026-10-25 it was
// a suggested on that leaving the task asked about, which left the step unticked while you
// looked at it and put Chrome's prompt after Next – the owner's report the same day. Either
// answer ticks the step, a declined prompt included, since that is a no.
el('ob-grouping').addEventListener('click', () => {
  const on = facts?.groupingIsOn;
  const change = on ? turnGroupingOff() : chrome.permissions.request(GROUPING);
  note('ob-grouping-note', '');
  change
    .then(async (granted) => {
      await markGroupingAsked();
      if (!on && !granted) note('ob-grouping-note', 'Chrome didn’t get a yes, so grouping is off. You can switch it on here or in Settings.');
    })
    .catch((error) => note('ob-grouping-note', `The tab group wasn’t changed – ${error?.message ?? error}`, 'bad'))
    .then(refresh);
});

el('ob-grouping-no').addEventListener('click', () => {
  markGroupingAsked()
    .catch((error) => console.warn('[openposse] could not record the tab group answer –', error?.message ?? error))
    .then(refresh);
});

/** Opens the side panel in this window. **The first statement of a click**, nothing before it. */
function openPanel() {
  if (windowId === null) {
    note('ob-lasso-note', 'This page is still starting. Try again in a moment.', 'bad');
    return false;
  }
  chrome.sidePanel.open({ windowId }).catch((error) => {
    console.warn('[openposse] could not open the side panel –', error?.message ?? error);
    note('ob-lasso-note', `The side panel didn’t open – ${error?.message ?? error}. Use the OpenPosse icon in the toolbar instead.`, 'bad');
  });
  return true;
}

el('ob-open-panel').addEventListener('click', () => openPanel());

// ── Opening and closing ────────────────────────────────────────────────────────────────────

/**
 * Shows onboarding, on the welcome the first time and on the first task with something still to
 * do after that. The setup sheet is shut first, since its steps are about to be borrowed.
 */
export async function openOnboarding() {
  if (dialog.open) return;
  const sheet = el('setup-sheet');
  if (sheet.matches(':popover-open')) sheet.hidePopover();
  borrow();
  local.skipped = [];
  try {
    facts = await read();
  } catch (error) {
    console.warn('[openposse] could not read the setup steps –', error?.message ?? error);
    facts = { mic: 'ask', model: 'downloadable', voice: 'missing', pin: false, shortcut: '', grouping: false, assistant: null };
  }
  shown = progress({ ...local, ...facts });
  local.task = shown.task;
  dialog.showModal();
  draw();
  // The pin has no event, the microphone can be unblocked in Chrome's settings, and a download
  // finishes when it finishes, so the tabs' counts are read again while the modal is up.
  polling = setInterval(() => { if (!document.hidden) refresh(); }, 1500);
}

dialog.addEventListener('downloads', () => { if (dialog.open && local.task) drawDownloading(); });

dialog.addEventListener('close', () => {
  clearInterval(polling);
  polling = null;
  giveBack();
});

// The first assistant, lassoed in the panel beside this tab, and a microphone granted here.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.agents || changes.micGranted || changes.grouping)) refresh();
});
chrome.permissions.onAdded.addListener(refresh);
chrome.permissions.onRemoved.addListener(refresh);
window.addEventListener('focus', refresh);

// ── Being asked to show it ─────────────────────────────────────────────────────────────────

/** Whether the install or the side panel asked for onboarding, clearing the request if so. */
export async function takeOnboardingRequest() {
  try {
    const asked = (await chrome.storage.session.get(ONBOARDING_REQUEST))[ONBOARDING_REQUEST];
    if (!asked) return false;
    await chrome.storage.session.remove(ONBOARDING_REQUEST);
    return true;
  } catch (error) {
    console.warn('[openposse] could not read whether onboarding was asked for –', error?.message ?? error);
    return false;
  }
}

/** For a Settings tab already open: `openOptionsPage()` only brings it to the front. */
export function watchOnboardingRequests() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !changes[ONBOARDING_REQUEST]?.newValue) return;
    takeOnboardingRequest().then((asked) => { if (asked) openOnboarding(); });
  });
}
