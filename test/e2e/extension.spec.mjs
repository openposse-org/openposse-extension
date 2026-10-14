// The extension, loaded and driven in a real browser. See browser.mjs for what every test
// shares, including the rule that a test fails if any page logged an error.
//
// What these cannot reach, and docs/testing.md checks by hand: the microphone and speech
// recognition, Kokoro, real vendors, Chrome's own Allow dialog, the side panel's frame and the
// global shortcut.

import { test, expect, addAcme, openPanel, ask, RECIPE, VENDOR_URL, ANSWER } from './browser.mjs';

test('every extension page opens without an error', async ({ context, extensionId }) => {
  // `offscreen.html` too, opened as a tab: Chrome's own offscreen document is not a page these
  // tests watch, so a module that throws as it loads there (it carries ONNX Runtime for
  // Supertonic) would otherwise only ever show up as a voice that never speaks.
  for (const name of ['setup.html', 'sidepanel.html', 'popup.html', 'offscreen.html']) {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/${name}`);
    // Long enough for each page's startup work to finish, so an error in it is caught too.
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveTitle(/OpenPosse/);
    await page.close();
  }
});

test('an assistant shared as a file is added from Settings', async ({ context, extensionId }) => {
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/setup.html`);

  await settings.fill('#import-text', RECIPE);
  await expect(settings.locator('#import-add')).toBeEnabled();
  await settings.click('#import-add');

  await expect(settings.locator('#import-status')).toHaveText('Added Acme.');
  await expect(settings.getByLabel('Rename Acme')).toHaveValue('Acme');
});

test('a typed question reaches the vendor, and its answer comes back to the panel', async ({ context, extensionId }) => {
  await addAcme(context, extensionId);
  const vendor = await context.newPage();
  await vendor.goto(VENDOR_URL);
  const panel = await openPanel(context, extensionId);

  await ask(panel, 'What is the pipeline total?');

  await expect(vendor.locator('[data-testid="question"]')).toHaveText('What is the pipeline total?');
  // The vendor writes its answer a word at a time, and the turn waits for it to settle.
  await expect(panel.locator('body')).toContainText(ANSWER, { timeout: 20_000 });
});

test('with no vendor tab open, a turn says so and opens nothing', async ({ context, extensionId }) => {
  await addAcme(context, extensionId);
  const panel = await openPanel(context, extensionId);
  const before = context.pages().length;

  await ask(panel, 'What is the pipeline total?');

  // OpenPosse only ever uses a tab the user already has open.
  // The product's sentence, named after the vendor – not the match pattern behind it.
  await expect(panel.locator('body')).toContainText('No Fixture tab is open.');
  expect(context.pages().length, 'no tab or window was opened').toBe(before);
});
