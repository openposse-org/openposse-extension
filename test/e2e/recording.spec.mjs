// Lassoing, driven in a real browser: a whole recording on the fake vendor and naming it, the
// card's way out, a switch to another tab while it watches, and the lassoed tab closing. Real
// vendors are checked by hand (docs/testing.md).
//
// The panel's page is opened as a tab of its own (see `openPanel`), so bringing it to the front
// is itself a switch away from the vendor's tab, which is what the away tests use.

import { Buffer } from 'node:buffer';
import { test, expect, openPanel, LASSO, VENDOR_URL } from './browser.mjs';

/** Opens the fake vendor and the panel, and starts lassoing the vendor's tab from the panel. */
async function startLassoing(context, extensionId) {
  const vendor = await context.newPage();
  await vendor.goto(VENDOR_URL);
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
