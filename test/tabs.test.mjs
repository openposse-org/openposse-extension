// OpenPosse only uses tabs you already have open.
//
// It drives the tab you are signed into, and "show me" switches to that same tab. It never opens
// a vendor's site – not to ask, not to show an answer. That is a premise of the whole extension
// rather than a detail of one function, so it is checked against the source: a new
// `tabs.create` anywhere outside the allowlist below fails here, before anyone has to notice a
// stray Notion tab appearing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

import { pickTab } from '../src/tabs.js';

test('the tab in front in its window is used, else the first one open', () => {
  const a = { id: 1, active: false };
  const b = { id: 2, active: true };
  assert.equal(pickTab([a, b]), b);
  assert.equal(pickTab([a, { id: 3, active: false }]), a);
});

test('with nothing open there is no tab, rather than a new one', () => {
  assert.equal(pickTab([]), null);
  assert.equal(pickTab(undefined), null);
});

/**
 * The only files that may open a tab or a window, and what for. None of them is on a turn's path,
 * and none of them opens a page for a turn to use.
 */
const MAY_OPEN = new Map([
  // Its own links, Chrome's shortcuts page, the spike page, and "Load icons", which opens each
  // vendor's home page in a minimised window to read its icon, on a button press, then closes it.
  ['setup.js', 'the Settings page'],
  // The one exception to the rule, the owner's call of 2026-10-25: first-run onboarding may open
  // a site, and only when one of its six tiles is clicked. Also Chrome's shortcuts page and
  // Settings' Better voices. Nothing on a turn's path, and the page is never opened by a turn.
  ['welcome.js', 'the welcome page'],
]);

/**
 * Single calls allowed in a file that is otherwise held to the rule, written out in full. The
 * worker is on every turn's path, so it is not allowlisted: it may open the welcome page, by
 * that literal, on install and for the side panel's "Finish setting up", and nothing else.
 */
const MAY_CALL = new Map([
  ['service-worker.js', "chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') })"],
]);

const OPENS = [
  /\b(?:tabs|windows)\.create\s*\(/,
  /\btabs\.duplicate\s*\(/,
  /\btabs\.update\s*\([^)]*\burl\b/,
  /\bwindow\.open\s*\(/,
];

/** Comments say why a call is not made; only code counts. */
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('nothing outside Settings opens a tab or a window', () => {
  const src = new URL('../src/', import.meta.url);
  const offenders = readdirSync(src)
    .filter((file) => file.endsWith('.js') && !MAY_OPEN.has(file))
    .flatMap((file) => {
      const body = code(readFileSync(new URL(file, src), 'utf8')).replaceAll(MAY_CALL.get(file) ?? '\0', '');
      return OPENS.filter((pattern) => pattern.test(body)).map((pattern) => `${file}: ${pattern}`);
    });
  assert.deepEqual(offenders, [], 'only switch to a tab that is already open');
});

test('the single calls allowed are still there, word for word', () => {
  // Otherwise a reworded call would fail the test above for the wrong reason, or a removed one
  // would leave an exception nobody needs.
  for (const [file, call] of MAY_CALL) {
    const body = code(readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8'));
    assert.equal(body.split(call).length - 1, 1, `${file} makes \`${call}\` exactly once`);
  }
});
