// The lassos on openposse.org, for Settings' "Get more from openposse.org" button.
//
// **Read only when the person presses the button, and only from here.** The owner's call of
// 2026-10-28: a new lasso can reach people without a release, from Settings, and onboarding
// stays as it is. The list is the website's `lassos/index.json`, generated from this repo's
// `lassos/` by the website's sync, and every file beside it is a shared file in the format
// Settings already takes.
//
// **A fetched file is a pasted file.** Picking one puts its text into "Add a shared AI
// assistant", so it gets the same preview, the same Chrome Allow for its one site, and the
// same check in the worker (`importShared`), which re-reads the bytes and trusts nothing this
// page says. On top of that, a file whose lasso does not hash to what the list says is
// refused, so a list and a file that disagree are never shown as the same lasso.

import { covers } from './builtin.js';
import { hashOf, unpack } from './share.js';

/** The list. Pinned: the bare domain, never a redirect. */
export const CATALOG = 'https://openposse.org/lassos/index.json';

/**
 * Lassos the website lists that Settings does not offer. Acme AI is the hooks demo's example
 * assistant, on openposse.org itself; it is left out of the package for the same reason
 * (`NOT_SHIPPED` in tools/build.mjs).
 */
const NOT_OFFERED = new Set(['acme-ai']);

const FILE = /^[a-z0-9-]+\.json$/;
const HASH = /^[0-9a-f]{12}$/;
const isText = (value) => typeof value === 'string' && value.trim() !== '';

/**
 * The lassos in the list's text that can be offered: `[{ id, name, product, site, file, hash }]`.
 *
 * An entry missing any of those, or naming a file that is not a plain name beside the list, is
 * left out rather than failing the rest. A list that is not a list at all is an error, said.
 */
export function readCatalog(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text ?? ''));
  } catch (error) {
    throw new Error(`the list on openposse.org could not be read (${error.message})`);
  }
  if (!Array.isArray(parsed?.lassos)) throw new Error('the list on openposse.org has no lassos in it');
  return parsed.lassos
    .filter((entry) => entry && isText(entry.id) && isText(entry.name) && isText(entry.site)
      && FILE.test(entry.file ?? '') && HASH.test(entry.hash ?? '') && !NOT_OFFERED.has(entry.id))
    .map(({ id, name, product, site, file, hash }) => ({
      id, name, product: isText(product) ? product : site, site, file, hash,
    }));
}

/**
 * Each entry with `have`: whether an assistant already lives on its site. `patterns` is the
 * roster's sites. One site, one assistant, so those are shown but cannot be loaded from here –
 * a newer version is still a file to paste, which offers Replace.
 */
export function marked(entries, patterns) {
  const taken = (patterns ?? []).filter(Boolean);
  return entries.map((entry) => ({ ...entry, have: taken.some((pattern) => covers(pattern, entry.site)) }));
}

/** Where one entry's file is: beside the list. */
export const fileURL = (entry) => new URL(entry.file, CATALOG).href;

/**
 * Whether a fetched file is the lasso the list says it is. Returns a reason, or null.
 *
 * `hashOf` is the one judge of what a lasso does, as everywhere else; the hash written in the
 * file is never consulted.
 */
export async function mismatch(entry, text) {
  const read = unpack(text);
  if (!read.ok) return read.problems.join(' ');
  if (await hashOf(read.lasso) !== entry.hash) {
    return `${entry.name}’s file on openposse.org is not the one its list describes, so it was not loaded.`;
  }
  return null;
}

/**
 * Reads one address on openposse.org as text. No cookies go with it and no redirect is
 * followed, so it is the pinned address or nothing.
 */
export async function fetchText(url) {
  const response = await fetch(url, { credentials: 'omit', redirect: 'error', cache: 'no-cache' });
  if (!response.ok) throw new Error(`openposse.org answered ${response.status}`);
  return response.text();
}
