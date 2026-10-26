// The lassos that come with OpenPosse, offered on their own sites.
//
// **Offered, never added.** The owner's call of 2026-10-26: a fresh install has an empty roster,
// and the side panel, on a site one of these is for, offers to add it. Adding it still goes
// through Chrome's own Allow for that one site, and then through the same import a shared file
// takes (`importShared` in the worker), so a built-in lasso is trusted exactly as far as a file
// pasted into Settings is. Nothing is fetched from anywhere: the files are part of the package,
// and a newer one arrives with a release.
//
// **The selectors stay in data.** `tools/build.mjs` copies `lassos/*.json` into the package as
// they are and writes `lassos/index.json` listing them, so no vendor's selectors are in any
// source file or bundle. A file the index does not list is not a built-in lasso, whatever its
// name, which is also what keeps the worker from being asked to read anything else.

import { unpack } from './share.js';

/** Where the build writes the list of files. */
export const INDEX = 'lassos/index.json';

/**
 * Whether a lasso's site covers a host, the way Chrome's `*.foo.com` does: the domain itself and
 * every subdomain of it. A pattern without a wildcard is that one host.
 */
export function covers(domainPattern, host) {
  const pattern = String(domainPattern ?? '').toLowerCase();
  const name = String(host ?? '').toLowerCase();
  if (!pattern || !name) return false;
  if (!pattern.startsWith('*.')) return name === pattern;
  const domain = pattern.slice(2);
  return name === domain || name.endsWith(`.${domain}`);
}

/**
 * The built-in lasso to offer on `host`, or null.
 *
 * Nothing is offered where an assistant already lives, by either test of **one site, one
 * assistant**: an agent whose site covers this host, or one with the same site as the built-in.
 * `patterns` is the roster's sites, one per agent.
 */
export function offerFor(builtIns, host, patterns) {
  const taken = (patterns ?? []).filter(Boolean);
  if (taken.some((pattern) => covers(pattern, host))) return null;
  const found = (builtIns ?? []).find((entry) => covers(entry.lasso.domainPattern, host));
  if (!found || taken.includes(found.lasso.domainPattern)) return null;
  return found;
}

/** The text of one packaged file, by the name the index gives it. */
async function readPackaged(path) {
  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) throw new Error(`${path} could not be read (${response.status})`);
  return response.text();
}

/** The files the index lists. A name that is not a plain `.json` filename is not one of them. */
export async function listed() {
  const files = JSON.parse(await readPackaged(INDEX));
  if (!Array.isArray(files)) throw new Error(`${INDEX} is not a list`);
  return files.filter((file) => typeof file === 'string' && /^[a-z0-9-]+\.json$/.test(file));
}

/** One built-in lasso's file as text, only if the index lists it. */
export async function builtInText(file) {
  if (!(await listed()).includes(file)) throw new Error(`${file} is not a lasso that comes with OpenPosse`);
  return readPackaged(`lassos/${file}`);
}

let cached = null;

/**
 * Every built-in lasso, unpacked as Settings would unpack it: `[{ file, id, name, lasso }]`.
 *
 * Read once per page, since the package does not change under it. A file that does not unpack is
 * left out and named in the console, rather than taking the others with it.
 */
export function builtInLassos() {
  cached ??= (async () => {
    const entries = await Promise.all((await listed()).map(async (file) => {
      const read = unpack(await readPackaged(`lassos/${file}`));
      if (!read.ok) {
        console.warn(`[openposse] the built-in lasso ${file} does not unpack –`, read.problems.join(' '));
        return null;
      }
      return { file, id: read.id, name: read.name, lasso: read.lasso };
    }));
    return entries.filter(Boolean);
  })().catch((error) => {
    cached = null;
    throw error;
  });
  return cached;
}
