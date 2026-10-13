// A recipe as something one person can send another.
//
// E8 made recording a user action. It benefits exactly one person: the one who did it. This is
// the distribution half – one person records Notion, everyone else installs the result.
//
// ── The file is written by a stranger ──
//
// That is the whole design constraint. A shared recipe carries a `domainPattern`, and that
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
// knowingly granted, a hostile recipe could type into the wrong box or read back the wrong
// element. Nothing leaves the machine either way, and the honest mitigation is that the file is
// readable and the site is named – which is why `pack` pretty-prints and the UI shows the JSON
// rather than hiding it behind a download.

import { patternForHost } from './domain.js';
import { productLabel } from './routing.js';

export const FORMAT = 'openposse.recipe';
export const VERSION = 1;

/**
 * The fields the runtime genuinely reads, measured rather than assumed.
 *
 * Taken from what `content.js` and `service-worker.js` actually dereference, not from what
 * `finish()` happens to write. A recipe missing any of these is not a recipe, however complete
 * it looks – it is an agent that will route an utterance and then fail.
 */
const REQUIRED = ['domainPattern', 'inputSelector', 'submitMethod',
  'responseContainerSelector'];

/**
 * Whether the recipe says enough about opening the assistant.
 *
 * **`openMethod` is deliberately not in `REQUIRED`, and the first version had it there.** It
 * refused the LeanIX recipe this repo shipped until 2026-10-01 – captured from a live page in
 * September and driving the vendor correctly – because that recording predates the field. The
 * case it proved is now pinned by a fixture in `share.test.mjs`. `openAssistant` in
 * `content.js` branches on `openMethod === 'click'` and otherwise falls through to
 * `recipe.shortcut`, so an absent `openMethod` with a shortcut present is a working recipe.
 *
 * A validator stricter than the runtime it validates for rejects recipes that would have worked,
 * and says nothing true about them. So this checks the same pair the runtime checks.
 */
function opensSomehow(recipe) {
  if (recipe.openMethod === 'click') return isText(recipe.openSelector);
  if (recipe.openMethod === 'shortcut') return Boolean(recipe.shortcut);
  // No method named. The runtime takes the shortcut path, so a shortcut is what it needs.
  return Boolean(recipe.shortcut);
}

/** Fields that are this machine's business and must not travel. */
const LOCAL_ONLY = ['id', 'recipeID', 'agentName', 'voice', 'connection'];

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

/**
 * A recipe as a plain object ready to be written to a file.
 *
 * `name` is a *suggestion*. The importer's roster may already hold a Notion, and `freeName`
 * settles that on the other side – so this carries what the sender called it without asserting
 * the recipient must use it.
 */
export function pack({ name, recipe }) {
  const shared = { ...recipe };
  for (const key of LOCAL_ONLY) delete shared[key];
  return { format: FORMAT, version: VERSION, name: String(name ?? '').trim() || 'Assistant', recipe: shared };
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
 * Reads a shared recipe, or says what is wrong with it in sentences.
 *
 * **Lenient about what it does not recognise, strict about what it must trust.** Per
 * `extension/CLAUDE.md`, the two sides version independently, so an unknown field is a routine
 * condition and is carried through untouched; a newer `version` is accepted with a note rather
 * than refused, because refusing would make every future addition a breaking change. Only a
 * missing load-bearing field, or a domain that could not have been derived, is fatal.
 *
 * @returns `{ ok: true, name, recipe, notes }` or `{ ok: false, problems }`
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
  if (parsed.format !== FORMAT) {
    return { ok: false, problems: ['This file was made by something else, not OpenPosse.'] };
  }

  const version = Number(parsed.version);
  if (!Number.isFinite(version) || version < 1) {
    return { ok: false, problems: ["This file doesn't say which version it is."] };
  }
  if (version > VERSION) {
    // Accepted deliberately. A future OpenPosse adding a field must not make its recipes
    // unreadable here, and the checks below still decide whether this one can actually be used.
    notes.push('This was shared by a newer version of OpenPosse. Anything it added is kept.');
  }

  const recipe = parsed.recipe;
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
    return { ok: false, problems: ['This file has no AI assistant in it.'] };
  }

  // The site first, because it is the one that decides what gets granted and the one worth
  // naming when it fails.
  if (!isText(recipe.domainPattern)) {
    problems.push("This file doesn't say which site the AI assistant lives on.");
  } else if (!patternIsDerivable(recipe.domainPattern)) {
    problems.push(`This asks for access to ${recipe.domainPattern}, which is wider than a `
      + 'single site. It has not been added.');
  }

  for (const field of REQUIRED) {
    if (field === 'domainPattern') continue;
    if (!isText(recipe[field])) problems.push(`Part of this recipe is missing (${field}).`);
  }

  // Opening, checked as the pair the runtime checks rather than as a field that must be present.
  if (!opensSomehow(recipe)) {
    problems.push(recipe.openMethod === 'click'
      ? 'This says it opens by clicking, but not what to click.'
      : "This doesn't say how to open the AI assistant.");
  }

  if (recipe.submitMethod === 'click' && !isText(recipe.submitSelector)) {
    problems.push("This says it sends with a button, but not which button.");
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    name: isText(parsed.name) ? parsed.name.trim() : 'Assistant',
    recipe,
    notes,
  };
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
 * A recipe as one sentence a person can follow – what the assistant does on the page, in the
 * page's own words where the recording kept them. For the Add a shared assistant preview, which
 * listed the selectors themselves until 2026-10-06, and those were too technical for the person
 * deciding whether to add it.
 *
 * Every quoted word came from a stranger's file. `labelIn` cuts them short, and the site comes
 * from `domainPattern`, which `unpack` has already checked – so a label can make the sentence
 * odd, never change which site it names. Chrome's own prompt names that site again.
 */
export function summarise(name, recipe) {
  const site = String(recipe.domainPattern ?? '').replace(/^\*\./, '') || 'its site';
  const product = productLabel(recipe.domainPattern) || site;
  const quoted = (words) => `‘${words}’`;

  const keys = recipe.shortcut ? [
    recipe.shortcut.metaKey && '⌘', recipe.shortcut.ctrlKey && '⌃',
    recipe.shortcut.altKey && '⌥', recipe.shortcut.shiftKey && '⇧',
    String(recipe.shortcut.key ?? '').toUpperCase(),
  ].filter(Boolean).join('') : '';
  const opener = labelIn(recipe.openSelector);
  // The same branch `content.js` takes: a click when it says click, the shortcut otherwise.
  const open = recipe.openMethod === 'click'
    ? (opener ? `clicks ${quoted(opener)}` : `opens ${product}’s AI assistant`)
    : (keys ? `presses ${keys}` : null);

  const box = labelIn(recipe.inputSelector);
  const type = box ? `types your question into ${quoted(box)}` : 'types your question';
  const send = recipe.submitMethod === 'enterKey' ? 'presses Enter' : 'clicks send';
  const read = recipe.busySelector
    ? `reads the answer once ${product} shows it has finished`
    : 'reads the answer once it stops changing';

  return `On ${site}, ${name} ${[open, type, send].filter(Boolean).join(', ')}, and ${read}.`;
}
