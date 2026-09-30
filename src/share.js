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

export const FORMAT = 'openposse.recipe';
export const VERSION = 1;

/**
 * The fields the runtime genuinely reads, measured rather than assumed.
 *
 * Taken from what `content.js` and `service-worker.js` actually dereference, not from what
 * `finish()` happens to write. A recipe missing any of these is not a recipe, however complete
 * it looks – it is an agent that will route an utterance and then fail.
 */
const REQUIRED = ['domainPattern', 'openMethod', 'inputSelector', 'submitMethod',
  'responseContainerSelector'];

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
    return { ok: false, problems: ["That doesn't look like a shared assistant file."] };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, problems: ["That doesn't look like a shared assistant file."] };
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
    return { ok: false, problems: ['This file has no assistant in it.'] };
  }

  // The site first, because it is the one that decides what gets granted and the one worth
  // naming when it fails.
  if (!isText(recipe.domainPattern)) {
    problems.push("This file doesn't say which site the assistant lives on.");
  } else if (!patternIsDerivable(recipe.domainPattern)) {
    problems.push(`This asks for access to ${recipe.domainPattern}, which is wider than a `
      + 'single site. It has not been added.');
  }

  for (const field of REQUIRED) {
    if (field === 'domainPattern') continue;
    if (!isText(recipe[field])) problems.push(`Part of this recipe is missing (${field}).`);
  }

  // The two conditional pairs. A recipe claiming to open by clicking without saying what to
  // click is the drifted-selector failure arriving before anyone has used it once.
  if (recipe.openMethod === 'click' && !isText(recipe.openSelector)) {
    problems.push("This says it opens by clicking, but not what to click.");
  }
  if (recipe.openMethod === 'shortcut' && !recipe.shortcut) {
    problems.push('This says it opens with a keyboard shortcut, but not which one.');
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
