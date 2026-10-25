// The page a first install opens: one card at a time, each ticking itself off when Chrome says
// it is done, so nobody presses "Next" after doing the thing.
//
// **Nothing about how far somebody got is saved.** Every card's state is read fresh from Chrome
// (see `steps.js`), so closing the page half-way and coming back – from the side panel's "Finish
// setting up" – lands on the first card still to do, with no cursor to get out of step.
//
// **This is the one page besides Settings that may open a tab** (`test/tabs.test.mjs`), and only
// when it is clicked: a site tile opens that site, so a new user's first assistant is one click
// away, and "Change" opens Chrome's shortcuts page, which no link can reach. Nothing on a turn's
// path opens anything – the owner's rule – and this page is not on one.
//
// Settings is for changing these later, the tab group included.

import { icon } from './icons.js';
import {
  micState, askForMic, watchMicPermission, modelState, installModel, pinned, shortcutKey,
  groupingAnswered, firstAssistant, progress, STEPS,
} from './steps.js';
import { GROUPING, groupingOn, markGroupingAsked, turnGroupingOff } from './grouping.js';

const el = (id) => document.getElementById(id);

/**
 * The suggested sites, their plain front doors. One list, here, because vendors move their apps
 * (Notion's went to app.notion.com, which is where the shared Notion lasso works) and a tile
 * landing on a marketing page is a bad first minute: check each before a release.
 */
const SITES = [
  { name: 'Notion', url: 'https://app.notion.com/', colour: '#191919' },
  { name: 'HubSpot', url: 'https://app.hubspot.com/', colour: '#ff5c35' },
  { name: 'Claude', url: 'https://claude.ai/', colour: '#d97757' },
  { name: 'Gemini', url: 'https://gemini.google.com/', colour: '#1a73e8' },
  { name: 'ChatGPT', url: 'https://chatgpt.com/', colour: '#10a37f' },
  { name: 'Copilot', url: 'https://copilot.microsoft.com/', colour: '#0f6cbd' },
];

/** What this page knows that Chrome does not: "Get started" was pressed, a card was skipped. */
const local = { started: false, skipped: [], opened: null };
let facts = null;
let shown = { done: {}, current: 'welcome' };
/** The one timer watching a model download, while there is one. */
let watchingModel = null;

/**
 * The window this page is in, known before any click. `sidePanel.open()` must be the first thing
 * a click does – one await before it and Chrome refuses, because the gesture is spent – so it
 * cannot be looked up then.
 */
let windowId = null;
chrome.windows.getCurrent()
  .then((win) => { windowId = win.id; })
  .catch((error) => console.warn('[openposse] could not read this page’s window –', error?.message ?? error));

/** Says something under a card's buttons, in a tone, or clears it. */
function note(id, text, tone = '') {
  el(id).hidden = !text;
  el(id).textContent = text ?? '';
  el(id).dataset.tone = tone;
}

// ── Reading where things stand ─────────────────────────────────────────────────────────────

async function read() {
  const [mic, model, pin, shortcut, grouping, groupingIsOn, assistant] = await Promise.all([
    micState(), modelState(), pinned(), shortcutKey(), groupingAnswered(), groupingOn(), firstAssistant(),
  ]);
  return { ...local, mic, model, pin, shortcut, grouping, groupingIsOn, assistant };
}

async function refresh() {
  try {
    facts = await read();
  } catch (error) {
    // Named, and the page stays where it was: a failed read is not a reason to jump cards.
    console.warn('[openposse] could not read the setup steps –', error?.message ?? error);
    return;
  }
  const before = shown.current;
  shown = progress(facts);
  // A card somebody went back to stays open until the one in front moves on.
  if (shown.current !== before) local.opened = null;
  draw();
}

// ── Drawing ────────────────────────────────────────────────────────────────────────────────

const SUMMARY = {
  mic: () => ({ granted: 'allowed', blocked: 'blocked' })[facts.mic] ?? '',
  model: () => ({ ready: 'ready', downloading: 'downloading…' })[facts.model]
    ?? (local.skipped.includes('model') ? 'not available here' : ''),
  pin: () => (facts.pin ? 'pinned' : local.skipped.includes('pin') ? 'skipped' : ''),
  shortcut: () => facts.shortcut || 'none',
  grouping: () => (facts.grouping ? (facts.groupingIsOn ? 'on' : 'off') : ''),
  assistant: () => facts.assistant?.name ?? '',
};

function draw() {
  const order = STEPS.map((step) => step.id);
  const at = order.indexOf(shown.current);
  const open = local.opened ?? shown.current;

  for (const [index, id] of order.entries()) {
    const card = el(`card-${id}`);
    const done = Boolean(shown.done[id]) || (index < at && local.skipped.includes(id));
    const later = index > at && !done;
    card.classList.toggle('done', done);
    card.classList.toggle('later', later);
    card.classList.toggle('open', id === open);
    const line = card.querySelector('.line');
    line.disabled = later;
    line.setAttribute('aria-expanded', String(id === open));
    line.querySelector('.tick').replaceChildren(icon(done ? 'check' : 'circle', { size: done ? 14 : 6 }));
    const summary = SUMMARY[id] && el(`${id}-summary`);
    if (summary) summary.textContent = done || id === open ? SUMMARY[id]() : '';
  }

  el('dots').replaceChildren(...order.map((id, index) => {
    const dot = document.createElement('li');
    if (shown.done[id]) dot.className = 'done';
    else if (index === at) dot.className = 'current';
    return dot;
  }));

  drawMic();
  drawModel();
  drawShortcut();
  drawGrouping();
  drawDone();
}

/** Once answered, the switch shows what Chrome holds; until then it shows the suggested on. */
function drawGrouping() {
  if (facts.grouping) el('grouping-switch').setAttribute('aria-checked', String(facts.groupingIsOn));
}

function drawMic() {
  el('allow-mic').disabled = facts.mic === 'granted';
  if (facts.mic === 'blocked') {
    note('mic-note', 'Chrome has blocked the microphone for OpenPosse. Allow it in Chrome’s settings for this extension, and this card ticks when you do.', 'bad');
  } else if (facts.mic === 'granted') {
    note('mic-note', '');
  }
}

function drawModel() {
  const { model } = facts;
  const downloading = model === 'downloading';
  el('model-progress').hidden = !downloading;
  el('get-model').disabled = model === 'ready' || downloading;
  el('get-model').textContent = model === 'unavailable' || model === 'unsupported' ? 'Continue without voice' : 'Download';
  if (model === 'unsupported') {
    note('model-note', 'This browser has no on-device speech recognition, so OpenPosse can’t hear you here. You can still type your questions in the side panel.', 'bad');
  } else if (model === 'unavailable') {
    note('model-note', 'On-device speech recognition is switched off in this Chrome, which is usually Chrome’s choice rather than yours. You can still type your questions in the side panel.', 'bad');
  } else if (model === 'ready' || downloading) {
    note('model-note', '');
  }
  // The recogniser has no progress event, so a download is watched until it says ready. One
  // timer at a time: `draw` runs on every refresh, from several places.
  if (downloading && !watchingModel) {
    watchingModel = setTimeout(() => { watchingModel = null; refresh(); }, 2000);
  }
}

/** The key, as a keycap. */
function keycap(key) {
  const kbd = document.createElement('kbd');
  kbd.textContent = key;
  return kbd;
}

function drawShortcut() {
  const text = el('shortcut-text');
  text.replaceChildren(...(facts.shortcut
    ? ['Press ', keycap(facts.shortcut), ' to talk to an assistant. You can change it to any keys you like.']
    : ['No shortcut is assigned yet. Press Change and pick the keys you’d like.']));
}

function drawDone() {
  const name = facts.assistant?.name;
  const parts = [];
  if (facts.shortcut) parts.push('Press ', keycap(facts.shortcut), ' and say ');
  else parts.push('Open the side panel and say ');
  parts.push(name ? `“${name}, …”` : 'your assistant’s name', ' followed by your question.');
  el('done-text').replaceChildren(...parts);
}

// ── Each card's action ─────────────────────────────────────────────────────────────────────

for (const card of document.querySelectorAll('.card-step')) {
  // Going back: a done card opens again on a click, and the one in front is already open.
  card.querySelector('.line').addEventListener('click', () => {
    local.opened = card.dataset.step === shown.current ? null : card.dataset.step;
    draw();
  });
}

el('start').addEventListener('click', () => {
  local.started = true;
  refresh();
});

el('allow-mic').addEventListener('click', async () => {
  note('mic-note', 'Chrome is asking, above…');
  try {
    await askForMic();
    note('mic-note', '');
  } catch (error) {
    // Each of Chrome's answers says what to do about it, never "something went wrong".
    const why = {
      NotAllowedError: 'Chrome didn’t get a yes. Press Allow microphone and choose Allow.',
      NotFoundError: 'No microphone was found. Plug one in, then press Allow microphone again.',
      NotReadableError: 'Another app is holding the microphone. Close it, then try again.',
    }[error?.name] ?? `The microphone couldn’t be opened – ${error?.name ?? 'error'}: ${error?.message ?? error}`;
    note('mic-note', why, 'bad');
  }
  refresh();
});

el('get-model').addEventListener('click', async () => {
  if (facts.model === 'unavailable' || facts.model === 'unsupported') {
    local.skipped.push('model');
    refresh();
    return;
  }
  note('model-note', '');
  // Shown at once: the install call does not return until the download has finished.
  el('model-progress').hidden = false;
  el('get-model').disabled = true;
  try {
    await installModel();
  } catch (error) {
    note('model-note', `The download didn’t finish – ${error?.message ?? error}. Press Download to try again.`, 'bad');
  }
  refresh();
});

// The tab group: the switch is only the answer being chosen; Continue gives it. On, Continue asks
// Chrome for the permission as its first statement, because a gesture does not survive an
// await. Either answer ticks the card, and a declined prompt is a no, said as one.
el('grouping-switch').addEventListener('click', () => {
  const button = el('grouping-switch');
  button.setAttribute('aria-checked', String(button.getAttribute('aria-checked') !== 'true'));
});

el('grouping-continue').addEventListener('click', () => {
  const wanted = el('grouping-switch').getAttribute('aria-checked') === 'true';
  // Somebody who came back to this card and switched it off gets the tabs ungrouped too.
  const asking = wanted ? chrome.permissions.request(GROUPING)
    : facts?.groupingIsOn ? turnGroupingOff().then(() => false) : Promise.resolve(false);
  note('grouping-note', '');
  asking
    .then(async (granted) => {
      await markGroupingAsked();
      if (wanted && !granted) {
        el('grouping-switch').setAttribute('aria-checked', 'false');
        note('grouping-note', 'Chrome didn’t get a yes, so grouping is off. You can switch it on in Settings.');
      }
    })
    .catch((error) => note('grouping-note', `Grouping couldn’t be switched on – ${error?.message ?? error}`, 'bad'))
    .then(refresh);
});

el('skip-pin').addEventListener('click', () => {
  local.skipped.push('pin');
  refresh();
});

el('change-shortcut').addEventListener('click', () => {
  // A link cannot reach a `chrome://` page; a tab can.
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch((error) =>
    console.warn('[openposse] could not open Chrome’s shortcuts page –', error?.message ?? error));
});

/** Opens the side panel in this window. **The first statement of a click**, nothing before it. */
function openPanel() {
  if (windowId === null) {
    note('assistant-note', 'This page is still starting. Try again in a moment.', 'bad');
    return false;
  }
  chrome.sidePanel.open({ windowId }).catch((error) => {
    console.warn('[openposse] could not open the side panel –', error?.message ?? error);
    note('assistant-note', `The side panel didn’t open – ${error?.message ?? error}. Use the OpenPosse icon in the toolbar instead.`, 'bad');
  });
  return true;
}

el('tiles').replaceChildren(...SITES.map((site) => {
  const tile = document.createElement('button');
  tile.className = 'tile';
  tile.style.setProperty('--tile', site.colour);
  tile.setAttribute('aria-label', `Open ${site.name} in a new tab`);
  const mono = document.createElement('span');
  mono.className = 'mono';
  mono.textContent = site.name[0];
  mono.setAttribute('aria-hidden', 'true');
  tile.append(mono, site.name);
  tile.addEventListener('click', () => {
    // The panel first, while the click is still Chrome's idea of a gesture; then the site, in
    // front, in this window, where the panel takes over: sign in, then Lasso this tab. Opening
    // the tab grants nothing – access is still asked for, per site, by that button.
    if (!openPanel()) return;
    chrome.tabs.create({ url: site.url, windowId, active: true }).catch((error) => {
      console.warn(`[openposse] could not open ${site.name} –`, error?.message ?? error);
      note('assistant-note', `${site.name} didn’t open – ${error?.message ?? error}.`, 'bad');
    });
  });
  return tile;
}));

el('open-panel').addEventListener('click', () => openPanel());

el('better-voices').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('setup.html#step-weights') }).catch((error) =>
    console.warn('[openposse] could not open Settings –', error?.message ?? error));
});

// ── Ticking itself off ─────────────────────────────────────────────────────────────────────

// The first assistant, and a microphone granted from Settings in another tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.agents || changes.micGranted)) refresh();
});

// Grouping switched on or off in Settings, or its permission removed in chrome://extensions.
chrome.permissions.onAdded.addListener(refresh);
chrome.permissions.onRemoved.addListener(refresh);

// Unblocking the microphone in Chrome's settings. A grant Chrome now reports is confirmed the
// way Settings does it – `getUserMedia` succeeds without a prompt – so it is a fact, not a guess.
watchMicPermission(async (event) => {
  if (event.target.state === 'granted' && facts?.mic !== 'granted') {
    await askForMic().catch((error) =>
      console.warn('[openposse] microphone reported granted but did not open –', error?.name ?? error));
  }
  refresh();
});

// The shortcut changes on Chrome's own page and pinning has no event at all, so both are read
// again whenever this page comes back into view – and the pin every couple of seconds while that
// is the card in front, because pinning from the toolbar does not take the focus away.
window.addEventListener('focus', refresh);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (shown.current === 'pin' && !document.hidden) refresh(); }, 2000);

refresh();
