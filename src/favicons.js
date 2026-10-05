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
// **The store is keyed by host, and a recipe holds only a pattern.** `*.leanix.net` names no page
// anybody visits; their tenant does. An open tab of the vendor gives the real host, which is
// remembered so the icon outlives the tab. A site Chrome has no icon for keeps its initial.

import { matchPattern } from './domain.js';

export const ICONS = { permissions: ['favicon'] };

const KNOWN_KEY = 'iconSites';

// Per page: the loaded image, or null once Chrome has said it has none. The panel redraws its
// roster on every turn change, and asking again each time would flash the initial before the icon.
const settled = new Map();

/**
 * Which page to ask the store about, for one pattern: an open tab's own URL, else the origin
 * remembered from the last one seen, else the pattern's bare domain – a guess, right for any site
 * visited at its bare domain. `origin` is set when it is new and should be remembered.
 */
export function pickPage(pattern, tabUrl, known) {
  if (tabUrl) {
    const { origin } = new URL(tabUrl);
    return { page: tabUrl, origin: origin === known ? null : origin };
  }
  return { page: known ? `${known}/` : `https://${pattern.replace(/^\*\./, '')}/`, origin: null };
}

/**
 * The page each agent's icon is looked up by, keyed by agent id – or nothing while the setting is
 * off. `patterns` maps agent id to domain pattern. `expected` marks a page taken from an open tab
 * that is showing an icon, so Chrome certainly has one for it.
 */
export async function iconPages(patterns) {
  try {
    if (!await chrome.permissions.contains(ICONS)) return {};
    // A roster reload is the moment to try again for sites that had no icon last time.
    for (const [page, img] of settled) if (!img) settled.delete(page);

    const { [KNOWN_KEY]: known = {} } = await chrome.storage.local.get(KNOWN_KEY);
    const tabs = {};
    await Promise.all([...new Set(Object.values(patterns).filter(Boolean))].map(async (pattern) => {
      const open = await chrome.tabs.query({ url: matchPattern(pattern) });
      tabs[pattern] = open.find((tab) => tab.favIconUrl) ?? open[0];
    }));

    const pages = {};
    let learned = false;
    for (const [id, pattern] of Object.entries(patterns)) {
      if (!pattern) continue;
      const tab = tabs[pattern];
      const { page, origin } = pickPage(pattern, tab?.url, known[pattern]);
      if (origin) {
        known[pattern] = origin;
        learned = true;
      }
      pages[id] = { page, expected: Boolean(tab?.favIconUrl) };
    }
    if (learned) await chrome.storage.local.set({ [KNOWN_KEY]: known });
    return pages;
  } catch (error) {
    // Icons are decoration. Failing to find them must never cost the roster they sit in.
    console.warn('[openposse] no site icons this time –', error?.message ?? error);
    return {};
  }
}

/** Puts an agent's site icon into its avatar, which keeps its initial when there is none. */
export function putIcon(face, entry) {
  if (!entry) return;
  const loaded = settled.get(entry.page);
  if (loaded) {
    face.replaceChildren(loaded.cloneNode());
    return;
  }
  if (loaded === null) return;

  const img = document.createElement('img');
  img.alt = '';
  img.addEventListener('load', () => {
    settled.set(entry.page, img);
    face.replaceChildren(img.cloneNode());
  }, { once: true });
  // **An error is how Chrome says it has no icon.** `forceEmptyDefaultFavicon` asks for nothing
  // back instead of its grey globe, so for a site never visited, keeping the initial is the whole
  // handling. It is a fault only when an open tab of the site shows an icon and none came here.
  img.addEventListener('error', () => {
    settled.set(entry.page, null);
    if (entry.expected) {
      console.warn('[openposse] an open tab of this site shows an icon, but none was served to its avatar');
    }
  }, { once: true });

  const src = new URL(chrome.runtime.getURL('/_favicon/'));
  src.searchParams.set('pageUrl', entry.page);
  src.searchParams.set('size', '32'); // drawn at 16px, so sharp on a 2× screen
  src.searchParams.set('forceEmptyDefaultFavicon', '1');
  img.src = src.href;
}
