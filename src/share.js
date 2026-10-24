// A lasso as something one person can send another.
//
// E8 made recording a user action. It benefits exactly one person: the one who did it. This is
// the distribution half – one person records Notion, everyone else installs the result.
//
// ── The file is written by a stranger ──
//
// That is the whole design constraint. A shared lasso carries a `domainPattern`, and that
// pattern becomes an **optional host permission**: the difference between "read leanix.net" and
// "read every commercial site in the United Kingdom" is one forged string in a text file.
//
// So the imported pattern is **never trusted and never used as given**. It is round-tripped
// through `patternForHost`, which is the same function that derived it during recording:
//
//   *.leanix.net  → probe `x.leanix.net` → patternForHost → *.leanix.net   ✓ accepted
//   *.co.uk       → probe `x.co.uk`      → patternForHost → *.x.co.uk      ✗ refused
//
// A pattern survives only if it is one the recorder itself could have produced. That needs no
// public-suffix list of its own, and it inherits every case `domain.js` already gets right,
// including the ones its tests pin.
//
// The second control is not in this file: the import flow always ends in a real
// `permissions.request()`, so Chrome names the domain and the person sees it before anything is
// granted. Neither control is worth much without the other.
//
// **Selectors are not sanitised, and this does not pretend otherwise.** On a domain the user has
// knowingly granted, a hostile lasso could type into the wrong box or read back the wrong
// element. Nothing leaves the machine either way, and the honest mitigation is that the file is
// readable and the site is named – which is why `pack` pretty-prints and the UI shows the JSON
// rather than hiding it behind a download.

import { patternForHost } from './domain.js';
import { productLabel } from './routing.js';

export const FORMAT = 'openposse.lasso';
export const VERSION = 1;

/**
 * The name the format had before lassos were called lassos, still read and never written.
 *
 * Files shared before the rename carry `openposse.recipe` and keep the content under `recipe`.
 * Nothing else about them differs, so refusing them would only break files people already have.
 */
const LEGACY_FORMAT = 'openposse.recipe';

/**
 * The fields the runtime genuinely reads, measured rather than assumed.
 *
 * Taken from what `content.js` and `service-worker.js` actually dereference, not from what
 * `finish()` happens to write. A lasso missing any of these is not a lasso, however complete
 * it looks – it is an agent that will route an utterance and then fail.
 */
const REQUIRED = ['domainPattern', 'inputSelector', 'submitMethod',
  'responseContainerSelector'];

/**
 * Whether the lasso says enough about opening the assistant.
 *
 * **`openMethod` is deliberately not in `REQUIRED`, and the first version had it there.** It
 * refused the LeanIX lasso this repo shipped until 2026-10-01 – captured from a live page in
 * September and driving the vendor correctly – because that recording predates the field. The
 * case it proved is now pinned by a fixture in `share.test.mjs`. `openAssistant` in
 * `content.js` branches on `openMethod === 'click'` and otherwise falls through to
 * `lasso.shortcut`, so an absent `openMethod` with a shortcut present is a working lasso.
 *
 * A validator stricter than the runtime it validates for rejects lassos that would have worked,
 * and says nothing true about them. So this checks the same pair the runtime checks.
 */
function opensSomehow(lasso) {
  if (lasso.openMethod === 'click') return isText(lasso.openSelector);
  if (lasso.openMethod === 'shortcut') return Boolean(lasso.shortcut);
  // No method named. The runtime takes the shortcut path, so a shortcut is what it needs.
  return Boolean(lasso.shortcut);
}

/** Fields that are this machine's business and must not travel. */
const LOCAL_ONLY = ['id', 'lassoID', 'agentName', 'voice', 'connection'];

const isText = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * Whether `pattern` is one the recorder could have derived.
 *
 * A wildcard is probed with a throwaway label rather than stripped, because stripping would
 * re-ask the question this is trying to answer. `patternForHost` decides, so a change there
 * changes this, which is the point of not writing a second rule.
 */
export function patternIsDerivable(pattern) {
  if (!isText(pattern)) return false;
  // A pattern is a host, not a URL. Anything carrying a scheme, a path, a port or a credential
  // is refused outright rather than parsed – `https://*/*` is the one that matters.
  if (/[:/?#@\s]/.test(pattern)) return false;
  if (pattern.startsWith('*.')) {
    const rest = pattern.slice(2);
    if (!isText(rest) || rest.includes('*')) return false;
    return patternForHost(`x.${rest}`) === pattern;
  }
  // A bare host: an IP literal, `localhost`, or a public suffix `patternForHost` refused to
  // wildcard. A `*` anywhere else in it is not a pattern the recorder has ever produced, and
  // a lone `*` round-trips to itself through `patternForHost` – so it is refused here instead.
  if (pattern.includes('*')) return false;
  return patternForHost(pattern) === pattern;
}

// ── Which lasso this is ───────────────────────────────────────────────────────────────────
//
// Three optional envelope fields, so a lasso can be told apart from an older or newer one of
// the same assistant once it has left the machine it was recorded on. See
// `docs/lasso-identity.md`.
//
// - `id`: the lineage, a slug such as `notion-ai`. Only the website hands one out; a recording
//   that was never published has none, and is matched by its site and name instead.
// - `recordedOn`: the day it was recorded, `YYYY-MM-DD`. Stored inside the lasso on this
//   machine and lifted into the envelope by `pack`.
// - `hash`: what the lasso does, as 12 hex characters. Always computed here and never taken
//   from a file, which is a stranger's claim.

const LINEAGE = /^[a-z0-9-]+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const lineageOf = (value) => (typeof value === 'string' && LINEAGE.test(value) ? value : null);
const dayOf = (value) => (typeof value === 'string' && DAY.test(value) ? value : null);

/** The lasso minus what is not its content: this machine's fields, and the date. */
function contentOf(lasso) {
  const content = { ...lasso };
  for (const key of LOCAL_ONLY) delete content[key];
  delete content.recordedOn;
  return content;
}

/**
 * JSON with keys sorted at every depth and no whitespace, so two files that say the same thing
 * hash the same however they were written. The website's sync mirrors this exactly; the test pins
 * a fixture's hash so the two cannot drift apart unnoticed.
 */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item ?? null)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The lasso's revision: SHA-256 over its canonical content, first 12 hex characters. The name,
 * the id and the date are left out, so renaming Ivan or publishing on another day changes nothing,
 * while one changed selector does.
 */
export async function hashOf(lasso) {
  const bytes = new TextEncoder().encode(canonical(contentOf(lasso)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A lasso as a plain object ready to be written to a file.
 *
 * `name` is a *suggestion*. The importer's roster may already hold a Notion, and `freeName`
 * settles that on the other side – so this carries what the sender called it without asserting
 * the recipient must use it.
 *
 * `id` is the agent's lineage, when it has one (it was imported from the website). The date
 * comes out of the lasso into the envelope, and the hash is always written.
 */
export async function pack({ name, lasso, id = null }) {
  const shared = { ...lasso };
  for (const key of LOCAL_ONLY) delete shared[key];
  const recordedOn = dayOf(shared.recordedOn);
  delete shared.recordedOn;

  const packed = { format: FORMAT, version: VERSION };
  if (lineageOf(id)) packed.id = id;
  packed.name = String(name ?? '').trim() || 'Assistant';
  if (recordedOn) packed.recordedOn = recordedOn;
  packed.hash = await hashOf(shared);
  packed.lasso = shared;
  return packed;
}

/** `pack`, as the text that goes in the file. Indented because it is meant to be read. */
export function toFile(packed) {
  return `${JSON.stringify(packed, null, 2)}\n`;
}

/** A filename a person can recognise in a downloads folder. */
export function filenameFor(name) {
  const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `openposse-${slug || 'assistant'}.json`;
}

/**
 * Reads a shared lasso, or says what is wrong with it in sentences.
 *
 * **Lenient about what it does not recognise, strict about what it must trust.** Sharer and
 * recipient may run different builds, so an unknown field is a routine
 * condition and is carried through untouched; a newer `version` is accepted with a note rather
 * than refused, because refusing would make every future addition a breaking change. Only a
 * missing load-bearing field, or a domain that could not have been derived, is fatal.
 *
 * The identity fields are optional and never fatal: an `id` or a date in the wrong shape is
 * dropped, and the file's `hash` is not returned at all, because `hashOf` is the only judge of
 * what a lasso says.
 *
 * @returns `{ ok: true, name, id, recordedOn, lasso, notes }` or `{ ok: false, problems }`
 */
export function unpack(text) {
  const problems = [];
  const notes = [];

  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch {
    return { ok: false, problems: ["That doesn't look like a shared AI assistant file."] };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, problems: ["That doesn't look like a shared AI assistant file."] };
  }
  const legacy = parsed.format === LEGACY_FORMAT;
  if (parsed.format !== FORMAT && !legacy) {
    return { ok: false, problems: ['This file was made by something else, not OpenPosse.'] };
  }

  const version = Number(parsed.version);
  if (!Number.isFinite(version) || version < 1) {
    return { ok: false, problems: ["This file doesn't say which version it is."] };
  }
  if (version > VERSION) {
    // Accepted deliberately. A future OpenPosse adding a field must not make its lassos
    // unreadable here, and the checks below still decide whether this one can actually be used.
    notes.push('This was shared by a newer version of OpenPosse. Anything it added is kept.');
  }

  const lasso = legacy ? parsed.recipe : parsed.lasso;
  if (!lasso || typeof lasso !== 'object' || Array.isArray(lasso)) {
    return { ok: false, problems: ['This file has no AI assistant in it.'] };
  }

  // The site first, because it is the one that decides what gets granted and the one worth
  // naming when it fails.
  if (!isText(lasso.domainPattern)) {
    problems.push("This file doesn't say which site the AI assistant lives on.");
  } else if (!patternIsDerivable(lasso.domainPattern)) {
    problems.push(`This asks for access to ${lasso.domainPattern}, which is wider than a `
      + 'single site. It has not been added.');
  }

  for (const field of REQUIRED) {
    if (field === 'domainPattern') continue;
    if (!isText(lasso[field])) problems.push(`Part of this lasso is missing (${field}).`);
  }

  // Opening, checked as the pair the runtime checks rather than as a field that must be present.
  if (!opensSomehow(lasso)) {
    problems.push(lasso.openMethod === 'click'
      ? 'This says it opens by clicking, but not what to click.'
      : "This doesn't say how to open the AI assistant.");
  }

  if (lasso.submitMethod === 'click' && !isText(lasso.submitSelector)) {
    problems.push("This says it sends with a button, but not which button.");
  }

  if (problems.length > 0) return { ok: false, problems };

  // The envelope's date first; a lasso carrying its own (a recording that was never packed)
  // second. Either way it leaves the lasso, which is where the caller puts it back.
  const { recordedOn: own, ...content } = lasso;
  return {
    ok: true,
    name: isText(parsed.name) ? parsed.name.trim() : 'Assistant',
    id: lineageOf(parsed.id),
    recordedOn: dayOf(parsed.recordedOn) ?? dayOf(own),
    lasso: content,
    notes,
  };
}

// ── Matching a file to an assistant already here ───────────────────────────────────────────

/**
 * The agent a shared file is a version of, or null. `entries` is `[{ agent, lasso }]`.
 *
 * **One site, one assistant** (the user's rule, 2026-10-16): a lasso for a site that already
 * has an assistant can only replace that assistant's lasso, never add a second. So the same site
 * comes first, whatever either is called. Failing that, the same lineage, which finds the agent
 * when the assistant has moved to a new address (Notion's did, to `app.notion.com`); replacing it
 * then moves the agent too, to a site nobody else has.
 */
export function matchFor(entries, { id, lasso }) {
  const list = entries ?? [];
  const site = list.find((entry) => entry.lasso?.domainPattern === lasso?.domainPattern);
  if (site) return site;
  if (!id) return null;
  return list.find((entry) => entry.agent?.origin?.id === id) ?? null;
}

// ── Dates, as people say them ──────────────────────────────────────────────────────────────

/** Today on this machine, `YYYY-MM-DD` – the day a person would say they recorded it. */
export function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** "1 October", or with `year`, "1 October 2026". Read as UTC, so the day never shifts. */
export function spokenDay(day, { year = false } = {}) {
  if (!dayOf(day)) return '';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'long', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));
}

/**
 * What a turn says when the assistant's page no longer has what the lasso looks for. Text only:
 * it names where a newer lasso might be and fetches nothing.
 *
 * `published` is whether the agent came from the website (it has an `id`), which decides where
 * to send the person: back to the site, or to record it again.
 */
export function staleness({ name, product, recordedOn, published }) {
  const page = product ? `${product}’s page` : 'its page';
  const date = spokenDay(recordedOn);
  const what = date
    ? `${name}’s lasso is from ${date} and ${page} has changed.`
    : `${name}’s lasso no longer matches ${page}, which has changed.`;
  return published
    ? `${what} There may be a newer one on openposse.org/lassos.`
    : `${what} Record it again from Settings.`;
}

// ── The preview, in a sentence ─────────────────────────────────────────────────────────────

/** Attributes that name an element by the words a person sees. */
const READABLE = ['aria-label', 'placeholder', 'data-placeholder', 'title', 'alt'];
/** Long enough for a button's words, short enough that a crafted one cannot read as a sentence. */
const LABEL_MAX = 40;

/**
 * The words a selector finds its element by, if it finds it by words: `aria-label="New\ chat"`
 * gives "New chat". Unescaped the way `CSS.escape` wrote them and cut short; empty for a
 * selector that names its element by an id or a test hook.
 *
 * **Only the element's own words, never an ancestor's** – `div[aria-label="Chat"] > button`
 * clicks a button inside the chat, and calling that click 'Chat' would be a small lie.
 */
export function labelIn(selector) {
  const text = String(selector ?? '');
  let found = null;
  for (const match of text.matchAll(/\[([\w-]+)[~|^$*]?="((?:[^"\\]|\\.)*)"\]/g)) {
    const rest = text.slice(match.index + match[0].length).replace(/\[[^\]]*\]|\([^)]*\)/g, '');
    if (READABLE.includes(match[1]) && !/[\s>+~]/.test(rest)) found = match[2];
  }
  if (found === null) return '';
  const words = found
    .replace(/\\([0-9a-fA-F]{1,6}) ?/g, (_, hex) => {
      const point = parseInt(hex, 16);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '\u{FFFD}';
    })
    .replace(/\\(.)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return words.length > LABEL_MAX ? `${words.slice(0, LABEL_MAX - 1).trimEnd()}…` : words;
}

/**
 * A lasso as one sentence a person can follow – what the assistant does on the page, in the
 * page's own words where the recording kept them. For the Add a shared assistant preview, which
 * listed the selectors themselves until 2026-10-06, and those were too technical for the person
 * deciding whether to add it.
 *
 * Every quoted word came from a stranger's file. `labelIn` cuts them short, and the site comes
 * from `domainPattern`, which `unpack` has already checked – so a label can make the sentence
 * odd, never change which site it names. Chrome's own prompt names that site again.
 *
 * With `recordedOn`, the sentence ends with the day it was recorded, so two versions of the same
 * assistant can be told apart before either is added.
 */
export function summarise(name, lasso, recordedOn = null) {
  const site = String(lasso.domainPattern ?? '').replace(/^\*\./, '') || 'its site';
  const product = productLabel(lasso.domainPattern) || site;
  const quoted = (words) => `‘${words}’`;

  const keys = lasso.shortcut ? [
    lasso.shortcut.metaKey && '⌘', lasso.shortcut.ctrlKey && '⌃',
    lasso.shortcut.altKey && '⌥', lasso.shortcut.shiftKey && '⇧',
    String(lasso.shortcut.key ?? '').toUpperCase(),
  ].filter(Boolean).join('') : '';
  const opener = labelIn(lasso.openSelector);
  // The same branch `content.js` takes: a click when it says click, the shortcut otherwise.
  const open = lasso.openMethod === 'click'
    ? (opener ? `clicks ${quoted(opener)}` : `opens ${product}’s AI assistant`)
    : (keys ? `presses ${keys}` : null);

  const box = labelIn(lasso.inputSelector);
  const type = box ? `types your question into ${quoted(box)}` : 'types your question';
  const send = lasso.submitMethod === 'enterKey' ? 'presses Enter' : 'clicks send';
  const read = lasso.busySelector
    ? `reads the answer once ${product} shows it has finished`
    : 'reads the answer once it stops changing';

  const when = spokenDay(recordedOn, { year: true });
  return `On ${site}, ${name} ${[open, type, send].filter(Boolean).join(', ')}, and ${read}`
    + `${when ? `, recorded ${when}` : ''}.`;
}
