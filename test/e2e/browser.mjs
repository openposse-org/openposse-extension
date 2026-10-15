// What every browser test shares: the extension loaded into Playwright's Chromium, the fake
// vendor in test/fixtures/ served at https://fixture.test, and every page error collected.
//
// **A test fails if any page logged an error**, extension pages included. That is the check the
// unit tests cannot make: a bundle that throws while it loads passes ESLint and every pure-module
// test, and has already shipped once that way.
//
// Runs against `dist-e2e/`, which `npm run build:e2e` makes: a development build whose manifest
// grants the fake vendor's site, standing in for the Allow click automation cannot reach.

import { test as base, expect, chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const EXTENSION = fileURLToPath(new URL('../../dist-e2e', import.meta.url));
const VENDOR = await readFile(new URL('../fixtures/vendor.html', import.meta.url), 'utf8');

/** The fake vendor's assistant as a shared-recipe file, exactly as the Share button writes one. */
export const RECIPE = await readFile(new URL('../fixtures/fixture-crm.json', import.meta.url), 'utf8');
export const VENDOR_URL = 'https://fixture.test/';
/** The start of the one answer the fake vendor gives. */
export const ANSWER = 'The pipeline total is 4.2 million dollars';

export { expect };

export const test = base.extend({
  /** Every uncaught error, and every console error, from any page in the browser. */
  errors: async ({}, use) => { await use([]); },

  context: async ({ errors }, use) => {
    // A fresh profile per test, so no test sees another's assistants or settings.
    const context = await chromium.launchPersistentContext('', {
      // Playwright's own Chromium in its new headless mode, the one that loads extensions.
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    const watch = (page) => {
      page.on('pageerror', (error) => errors.push(`${page.url()}: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(`${page.url()}: ${message.text()}`);
      });
    };
    context.pages().forEach(watch);
    context.on('page', watch);
    // Served from here rather than a server, so nothing reaches the network.
    await context.route(`${VENDOR_URL}**`, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: VENDOR }));

    await use(context);
    await context.close();
    expect(errors, 'no page logged an error').toEqual([]);
  },

  extensionId: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    // A first install opens Settings. Waiting for it here keeps that tab from turning up partway
    // through a test that counts tabs, and fails every test if the install stops opening it.
    // Polled rather than awaited as an event, because a new tab can report `about:blank` before
    // it reaches its address.
    const settings = `chrome-extension://${id}/setup.html`;
    await expect.poll(() => context.pages().some((page) => page.url() === settings), {
      message: 'a first install opens Settings',
      timeout: 10_000,
    }).toBe(true);
    await use(id);
  },
});

/** Adds the fake vendor's assistant, Acme, through the message Settings' import sends. */
export async function addAcme(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/setup.html`);
  const result = await page.evaluate(
    (text) => chrome.runtime.sendMessage({ kind: 'openposse.agent.import', text }), RECIPE);
  expect(result).toMatchObject({ ok: true, name: 'Acme' });
  await page.close();
}

/**
 * Opens the side panel's page as an ordinary tab. The side panel itself is browser chrome,
 * which automation cannot reach; the page in it is the same either way.
 */
export async function openPanel(context, extensionId) {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return panel;
}

/** Types a question into the panel's text box and sends it, once the roster has loaded. */
export async function ask(panel, question) {
  await expect(panel.locator('#prompt')).toHaveAttribute('data-agent', 'Acme');
  await panel.click('#type');
  await panel.fill('#prompt', question);
  await panel.press('#prompt', 'Enter');
}
