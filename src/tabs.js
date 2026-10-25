// Finding a vendor's tab – and only ever finding it.
//
// **OpenPosse never opens a vendor's site.** It drives the tab you already have, signed in as you,
// and "show me" switches to that same tab. A fresh one would be the assistant with none of the
// conversation in it, possibly signed in as nobody, and an extension opening sites by itself is
// the behaviour people uninstall extensions for. When no tab is open, the turn says so and stops.
//
// So this file returns a tab that exists or nothing, and asking and showing both come through
// it – which also means "show me" lands on the tab the question was asked in, by construction
// rather than by two copies of the same rule agreeing. `test/tabs.test.mjs` fails if any file
// on a turn's path creates a tab or a window.

//
// With grouping on, a tab in an OpenPosse group is preferred – a preference, not a fence: when
// none of the vendor's tabs is grouped, any open one is used, as before. See `grouping.js`.

import { matchPattern } from './domain.js';
import { ourGroupIds } from './grouping.js';

/**
 * A tab in one of `ours` (OpenPosse group ids) if there is one, then the tab in front in its
 * window, else the first one open. Pure, so it can be tested.
 */
export function pickTab(tabs, ours = new Set()) {
  const grouped = tabs?.filter((tab) => ours.has(tab.groupId)) ?? [];
  const from = grouped.length ? grouped : tabs;
  return from?.find((tab) => tab.active) ?? from?.[0] ?? null;
}

/** The vendor's open tab, or null. Never opens one. */
export async function vendorTab(domainPattern) {
  if (!domainPattern) return null;
  const [tabs, ours] = await Promise.all([
    chrome.tabs.query({ url: matchPattern(domainPattern) }),
    ourGroupIds().catch((error) => {
      // Grouping is a preference: without the group ids, any open tab still answers.
      console.warn('[openposse] could not read the OpenPosse tab groups –', error?.message ?? error);
      return new Set();
    }),
  ]);
  return pickTab(tabs, ours);
}
