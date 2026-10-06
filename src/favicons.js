// Site icons on the avatars, in place of the initial – a choice under Assistants in Settings, off
// until somebody makes it.
//
// **The icons come from Chrome's own favicon store, and nothing is fetched.** The `favicon`
// permission lets an extension read the icons Chrome kept while browsing. Chromium lets only its
// own History and New Tab pages fall back to Google's icon server, so a request from here is
// answered from this machine or not at all.
//
// **Holding that permission is the setting.** It is optional and asked for when the setting is
// turned on, because its warning – "Read the icons of the websites you visit" – is not one to put
// in front of everybody at install for the sake of a look. With no separate flag, the setting and
// the permission cannot disagree.
//
// **Only sites seen in a tab with an icon are looked up**, for two reasons. The store is keyed by
// host and a recipe holds only a pattern – `*.leanix.net` names no page anybody visits; their
// tenant does – so an open tab is where the real host comes from, and it is remembered so the icon
// outlives the tab. And **Chrome answers a site it has no icon for with its grey globe.** The
// `forceEmptyDefaultFavicon` option that should send nothing instead did not: a 30-agent mock
// roster came back as twenty-seven globes on 2026-10-05. Asking only about sites a tab has shown
// an icon for means that answer never comes, and everyone else keeps their initial.

import { matchPattern } from './domain.js';

export const ICONS = { permissions: ['favicon'] };

const KNOWN_KEY = 'iconSites';

// Per page: the loaded image, or null once its request failed. The panel redraws its roster on
// every turn change, and asking again each time would flash the initial before the icon.
const settled = new Map();

/**
 * Which page to ask the store about, from an open tab of the site and the origin remembered from
 * the last one: the tab's own URL if it is showing an icon, else that origin, else nothing.
 * `origin` is set when it is new and should be remembered.
 */
export function pickPage(tab, known) {
  if (tab?.url && tab.favIconUrl) {
    const { origin } = new URL(tab.url);
    return { page: tab.url, origin: origin === known ? null : origin };
  }
  return known ? { page: `${known}/`, origin: null } : null;
}

/**
 * The page each agent's icon is looked up by, keyed by agent id – or nothing while the setting is
 * off. `patterns` maps agent id to domain pattern. An agent left out keeps its initial.
 */
export async function iconPages(patterns) {
  try {
    if (!await chrome.permissions.contains(ICONS)) return {};
    // A roster reload is the moment to retry a request that failed last time.
    for (const [page, img] of settled) if (!img) settled.delete(page);

    const { [KNOWN_KEY]: known = {} } = await chrome.storage.local.get(KNOWN_KEY);
    const tabs = {};
    await Promise.all([...new Set(Object.values(patterns).filter(Boolean))].map(async (pattern) => {
      const open = await chrome.tabs.query({ url: matchPattern(pattern) });
      tabs[pattern] = open.find((tab) => tab.favIconUrl);
    }));

    const pages = {};
    const learned = {};
    for (const [id, pattern] of Object.entries(patterns)) {
      const pick = pattern ? pickPage(tabs[pattern], known[pattern]) : null;
      if (!pick) continue;
      if (pick.origin) learned[pattern] = pick.origin;
      pages[id] = pick.page;
    }
    if (Object.keys(learned).length) await remember(learned);
    return pages;
  } catch (error) {
    // Icons are decoration. Failing to find them must never cost the roster they sit in.
    console.warn('[openposse] no site icons this time –', error?.message ?? error);
    return {};
  }
}

/**
 * Adds newly seen sites to the remembered ones, re-reading the list under a lock. Several lookups
 * can run at once – vendor tabs restored together, or Load all in the panel's debug drawer – and
 * each used to write back the list as it read it at the start, so the last to finish erased what
 * the others had found. The lock is per extension origin, so the panel and Settings queue too.
 */
function remember(learned) {
  return navigator.locks.request(KNOWN_KEY, async () => {
    const { [KNOWN_KEY]: known = {} } = await chrome.storage.local.get(KNOWN_KEY);
    await chrome.storage.local.set({ [KNOWN_KEY]: { ...known, ...learned } });
  });
}

/** Puts an agent's site icon into its avatar, which keeps its initial if none arrives. */
export function putIcon(face, page) {
  if (!page) return;
  const loaded = settled.get(page);
  if (loaded) {
    face.replaceChildren(loaded.cloneNode());
    return;
  }
  if (loaded === null) return;

  const img = document.createElement('img');
  img.alt = '';
  img.addEventListener('load', () => {
    settled.set(page, img);
    face.replaceChildren(img.cloneNode());
  }, { once: true });
  // Every page asked about is one a tab has shown an icon for, so an error is the request failing,
  // not an absence. The event carries no reason to pass on; Chrome's own, if it gave one, is in
  // this page's console.
  img.addEventListener('error', () => {
    settled.set(page, null);
    console.warn('[openposse] a site icon Chrome has shown in a tab could not be read for its avatar');
  }, { once: true });

  const src = new URL(chrome.runtime.getURL('/_favicon/'));
  src.searchParams.set('pageUrl', page);
  src.searchParams.set('size', '32'); // drawn at 16px, so sharp on a 2× screen
  img.src = src.href;
}
