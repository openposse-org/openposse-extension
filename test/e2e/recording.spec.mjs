// Lassoing, driven in a real browser: a whole recording on the fake vendor and naming it, the
// card's way out, a switch to another tab while it watches, and the lassoed tab closing. Real
// vendors are checked by hand (docs/testing.md).
//
// The panel's page is opened as a tab of its own (see `openPanel`), so bringing it to the front
// is itself a switch away from the vendor's tab, which is what the away tests use.

import { Buffer } from 'node:buffer';
import { test, expect, openPanel, LASSO, VENDOR_URL } from './browser.mjs';

/** Opens the fake vendor and the panel, and starts lassoing the vendor's tab from the panel. */
async function startLassoing(context, extensionId, url = VENDOR_URL) {
  const vendor = await context.newPage();
  await vendor.goto(url);
  const panel = await openPanel(context, extensionId);
  await panel.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}*` });
    await chrome.runtime.sendMessage({ kind: 'openposse.record', tabId: tab.id, pattern: '*.fixture.test' });
  }, VENDOR_URL);
  await expect(panel.locator('#coach')).toBeVisible();
  return { vendor, panel };
}

test('a finished lasso is named on the card, and Save and return goes back to the panel', async ({ context, extensionId }) => {
  const { vendor, panel } = await startLassoing(context, extensionId);
  await vendor.bringToFront();

  // Every step is listed before any is done, numbered and grey.
  const rows = panel.locator('#coach-list .row');
  await expect(rows).toHaveCount(5);
  await expect(panel.locator('#coach-list .num.done')).toHaveCount(0);

  // What a person does: open the assistant, then ask it two things.
  await vendor.click('[data-testid="open-assistant"]');
  for (const question of ['What is the pipeline total?', 'And the biggest deal?']) {
    await vendor.click('[data-testid="composer"]');
    await vendor.keyboard.type(question);
    await vendor.click('[data-testid="send"]');
    await expect(vendor.locator('[data-testid="send"]')).toBeVisible({ timeout: 10_000 });
  }

  // The check asks it two questions of its own before saving.
  const box = panel.locator('#coach-name-input');
  await expect(box).toBeVisible({ timeout: 30_000 });
  await expect(box).toHaveValue('Fixture');
  await expect(panel.locator('#coach-done')).toBeHidden();
  // All five settled, the busy row included though the fake vendor has no busy signal: the timer
  // it falls back to is an answer too, and its words say which.
  await expect(panel.locator('#coach-list .num.done')).toHaveCount(5);
  await expect(panel.locator('#coach-list .row').nth(4)).toContainText('using a timer');

  await box.fill('Ivan');
  await panel.click('#coach-name button[type="submit"]');
  await expect(panel.locator('#coach')).toBeHidden();
  await expect(panel.locator('#desk')).toBeVisible();
  const { agents } = await panel.evaluate(() => chrome.storage.local.get('agents'));
  expect(agents.map((a) => a.name)).toEqual(['Ivan']);
});

test('a lasso that fails its check says what happened, and can be copied though not saved', async ({ context, extensionId }) => {
  // Waits out the check's answer timeout, the recorder's 30-second minimum.
  test.setTimeout(120_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // At `?trusted` the fake vendor's Send ignores a click it did not get from a person.
  const { vendor, panel } = await startLassoing(context, extensionId, `${VENDOR_URL}?trusted`);
  await vendor.bringToFront();

  await vendor.click('[data-testid="open-assistant"]');
  for (const question of ['What is the pipeline total?', 'And the biggest deal?']) {
    await vendor.click('[data-testid="composer"]');
    await vendor.keyboard.type(question);
    await vendor.click('[data-testid="send"]');
    await expect(vendor.locator('[data-testid="send"]')).toBeVisible({ timeout: 10_000 });
  }

  await expect(panel.locator('#coach-step')).toHaveText('SETTING UP · DIDN’T WORK', { timeout: 90_000 });
  await expect(panel.locator('#coach-why')).toHaveText(/^What happened: .+\.$/);
  const copy = panel.locator('#coach-copy');
  await expect(copy).toBeVisible();
  await copy.click();
  await expect(copy).toHaveText('Copied');

  // What was copied is the file Settings adds, with the recorded selectors in it.
  const shared = JSON.parse(await panel.evaluate(() => navigator.clipboard.readText()));
  expect(shared.format).toBe('openposse.lasso');
  expect(shared.lasso.submitSelector).toBe('button[data-testid="send"]');
  const { agents = [] } = await panel.evaluate(() => chrome.storage.local.get('agents'));
  expect(agents).toEqual([]);
});

test('lassoing can be stopped from the card, and nothing is saved', async ({ context, extensionId }) => {
  const { vendor, panel } = await startLassoing(context, extensionId);
  await vendor.bringToFront();

  const close = panel.locator('#coach-close');
  await expect(close).toHaveAttribute('aria-label', 'Stop lassoing – nothing is saved');
  // Nothing has finished, so there is no Done yet.
  await expect(panel.locator('#coach-done')).toBeHidden();
  await close.click();

  await expect(panel.locator('#coach')).toBeHidden();
  await expect(panel.locator('#desk')).toBeVisible();
  const { agents = [] } = await panel.evaluate(() => chrome.storage.local.get('agents'));
  expect(agents).toEqual([]);
});

test('another tab in front is told where the recording is, and Back returns to it', async ({ context, extensionId }) => {
  const { vendor, panel } = await startLassoing(context, extensionId);
  // The panel's tab came last, so the vendor's is already behind it.
  const back = panel.locator('#coach-back');
  await expect(back).toBeVisible();
  await expect(panel.locator('#coach-say')).toContainText('watches the');
  await expect(panel.locator('#coach-say')).toContainText('Go back to it to carry on.');

  await back.click();
  await expect.poll(() => vendor.evaluate(() => document.visibilityState)).toBe('visible');
  await expect(back).toBeHidden();
  await expect(panel.locator('#coach-say')).toContainText('Open the AI assistant.');

  // And away again, by switching rather than by the button.
  await panel.bringToFront();
  await expect(back).toBeVisible();
});

test('closing the lassoed tab ends the recording, and Close leaves the card', async ({ context, extensionId }) => {
  const { vendor, panel } = await startLassoing(context, extensionId);
  await vendor.close();

  await expect(panel.locator('#coach-say')).toContainText('was closed, so there’s nothing left to watch');
  await expect(panel.locator('#coach-back')).toBeHidden();
  const close = panel.locator('#coach-close');
  await expect(close).toHaveAttribute('aria-label', 'Close');
  // Done, under the message, is the same way out.
  await expect(panel.locator('#coach-done')).toBeVisible();
  await panel.locator('#coach-done').click();
  await expect(panel.locator('#coach')).toBeHidden();
  await expect(panel.locator('#desk')).toBeVisible();
});

test('a message box that is always there can be said so, and the open step is done', async ({ context, extensionId }) => {
  const { vendor, panel } = await startLassoing(context, extensionId);
  await vendor.bringToFront();

  const always = panel.locator('#coach-always');
  await expect(always).toBeVisible();
  await always.click();

  await expect(always).toBeHidden();
  await expect(panel.locator('#coach-step')).toHaveText('SETTING UP · 2 OF 2');
  await expect(panel.locator('#coach-list')).toContainText('nothing to open – always on the page');

  // Hidden while another tab is in front, like the step it belongs to.
  await panel.bringToFront();
  await expect(always).toBeHidden();
});

test('a message box that already has focus is on the card from the start', async ({ context, extensionId }) => {
  // ChatGPT focuses its box on load. Arming adopts it at once, and those first captures used to
  // reach the worker before it was listening, so the card never showed the message box.
  const vendor = await context.newPage();
  await vendor.goto(VENDOR_URL);
  await vendor.click('button[data-testid="open-assistant"]');
  await vendor.focus('textarea[data-testid="composer"]');

  const panel = await openPanel(context, extensionId);
  await panel.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}*` });
    await chrome.runtime.sendMessage({ kind: 'openposse.record', tabId: tab.id, pattern: '*.fixture.test' });
  }, VENDOR_URL);
  await vendor.bringToFront();

  await expect(panel.locator('#coach-list')).toContainText('Message box');
  await expect(panel.locator('#coach-say')).toContainText('already open');
  await expect(panel.locator('#coach-always')).toBeVisible();
});

test('a picked file puts its name in the box', async ({ context, extensionId }) => {
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/setup.html`);

  await settings.locator('#import-file').setInputFiles({
    name: 'acme.openposse.json', mimeType: 'application/json', buffer: Buffer.from(LASSO),
  });

  await expect(settings.locator('#import-text')).toHaveValue('acme.openposse.json');
  await expect(settings.locator('#import-preview')).toBeVisible();
  await expect(settings.locator('#import-add')).toBeEnabled();

  // Focusing it selects the name, so a paste replaces it.
  await settings.focus('#import-text');
  const selected = await settings.locator('#import-text').evaluate((box) => box.value.slice(box.selectionStart, box.selectionEnd));
  expect(selected).toBe('acme.openposse.json');
});
