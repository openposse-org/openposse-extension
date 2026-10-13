// Finding a vendor's tab – and only ever finding it.
//
// **OpenPosse never opens a vendor's site.** It drives the tab you already have, signed in as you,
// and "show me" switches to that same tab. A fresh one would be the assistant with none of the
// conversation in it, possibly signed in as nobody, and an extension opening sites by itself is
// the behaviour people uninstall extensions for. When no tab is open, the turn says so and stops.
//
// So this file returns a tab that exists or nothing, and asking and showing both come through
// it – which also means "show me" lands on the tab the question was asked in, by construction
// rather than by two copies of the same rule agreeing. `tools/tabs.test.mjs` fails if any file
// on a turn's path creates a tab or a window.

import { matchPattern } from './domain.js';

/** The tab in front in its window, else the first one open. Pure, so it can be tested. */
export function pickTab(tabs) {
  return tabs?.find((tab) => tab.active) ?? tabs?.[0] ?? null;
}

/** The vendor's open tab, or null. Never opens one. */
export async function vendorTab(domainPattern) {
  if (!domainPattern) return null;
  return pickTab(await chrome.tabs.query({ url: matchPattern(domainPattern) }));
}
