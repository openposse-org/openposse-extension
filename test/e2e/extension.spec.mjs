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

test("Supertonic's download waits for its use restrictions to be agreed to", async ({ context, extensionId }) => {
  // The licence binds its restrictions to everyone who uses the model, and the box is where that
  // happens, so nothing may fetch the weights before it is ticked. No network: nothing is downloaded.
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/setup.html`);
  const download = settings.locator('#get-supertonic');
  const box = settings.locator('#agree-supertonic');
  const stored = () => settings.evaluate(
    async () => (await chrome.storage.local.get('supertonicAgreement')).supertonicAgreement ?? null);

  await expect(settings.locator('#supertonic-status')).toHaveText(/not downloaded/);
  await expect(download).toBeDisabled();

  await box.check();
  await expect(download).toBeEnabled();
  await expect.poll(stored).toMatchObject({ licence: 'BigScience Open RAIL-M', version: '2022-08-18' });

  // Unticking withdraws it.
  await box.uncheck();
  await expect(download).toBeDisabled();
  await expect.poll(stored).toBeNull();

  // The full licence the agreement links to is in the package.
  const href = await settings.locator('.terms a').getAttribute('href');
  const text = await settings.evaluate(async (path) => (await fetch(path)).text(), href);
  expect(text).toContain('BigScience Open RAIL-M License');
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

/**
 * Every title the vendor page shows from now on, in order, kept on the page as `__titles`. A
 * recorder rather than a poll, because `typing…` lasts only as long as typing does.
 *
 * With `rename`, the page renames itself once, the moment it first shows `answering…`, the way
 * Notion renames a tab after navigating.
 */
async function recordTitles(page, { rename = null } = {}) {
  await page.evaluate((rename) => {
    const titles = [document.title];
    window.__titles = titles;
    let renamed = false;
    new MutationObserver(() => {
      if (titles.at(-1) !== document.title) titles.push(document.title);
      if (rename && !renamed && document.title.startsWith('answering…')) {
        renamed = true;
        document.title = rename;
      }
    }).observe(document.head, { childList: true, subtree: true, characterData: true });
  }, rename);
  return () => page.evaluate(() => window.__titles);
}

test("the vendor tab's title says what it is doing during a turn", async ({ context, extensionId }) => {
  await addAcme(context, extensionId);
  const vendor = await context.newPage();
  await vendor.goto(VENDOR_URL);
  const titles = await recordTitles(vendor);
  const panel = await openPanel(context, extensionId);

  await ask(panel, 'What is the pipeline total?');

  await expect(panel.locator('body')).toContainText(ANSWER, { timeout: 20_000 });
  await expect.poll(titles, { timeout: 5_000 }).toContain('done · Fixture CRM');
  expect((await titles()).slice(0, 4)).toEqual([
    'Fixture CRM', 'typing… · Fixture CRM', 'answering… · Fixture CRM', 'done · Fixture CRM',
  ]);
});

test("a turn that fails gives the vendor tab its own title back", async ({ context, extensionId }) => {
  await addAcme(context, extensionId);
  const vendor = await context.newPage();
  await vendor.goto(VENDOR_URL);
  // No send button: the question is typed, then the turn fails.
  await vendor.evaluate(() => document.querySelector('[data-testid="send"]').remove());
  const titles = await recordTitles(vendor);
  const panel = await openPanel(context, extensionId);

  await ask(panel, 'What is the pipeline total?');

  await expect(panel.locator('body')).toContainText('send button not found', { timeout: 10_000 });
  await expect.poll(titles, { timeout: 5_000 })
    .toEqual(['Fixture CRM', 'typing… · Fixture CRM', 'Fixture CRM']);
});

test('a page that renames itself mid-turn keeps its new title', async ({ context, extensionId }) => {
  await addAcme(context, extensionId);
  const vendor = await context.newPage();
  await vendor.goto(VENDOR_URL);
  const titles = await recordTitles(vendor, { rename: 'Pipeline review' });
  const panel = await openPanel(context, extensionId);

  await ask(panel, 'What is the pipeline total?');

  await expect(panel.locator('body')).toContainText(ANSWER, { timeout: 20_000 });
  await expect.poll(titles, { timeout: 5_000 }).toContain('done · Pipeline review');
  expect(await titles()).toContain('answering… · Pipeline review');
});

test('the same shared file twice is recognised, not added again', async ({ context, extensionId }) => {
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/setup.html`);
  await settings.fill('#import-text', RECIPE);
  await settings.click('#import-add');
  await expect(settings.locator('#import-status')).toHaveText('Added Acme.');

  await settings.fill('#import-text', RECIPE);

  await expect(settings.locator('#import-status')).toHaveText('You already have this one, as Acme.');
  await expect(settings.locator('#import-add')).toBeDisabled();
  await expect(settings.locator('#import-choice')).toBeHidden();
});

test('a newer version of a shared assistant replaces its recipe and keeps the assistant', async ({ context, extensionId }) => {
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/setup.html`);
  await settings.fill('#import-text', RECIPE);
  await settings.click('#import-add');
  await expect(settings.locator('#import-status')).toHaveText('Added Acme.');
  // A voice chosen after adding it, which a replacement must not take away.
  const roster = () => settings.evaluate(async () => {
    const { agents } = await chrome.storage.local.get('agents');
    const recipes = await chrome.storage.local.get(agents.map((a) => `recipe:${a.recipeID}`));
    return agents.map((a) => ({ ...a, recipe: recipes[`recipe:${a.recipeID}`] }));
  });
  await settings.evaluate(async () => {
    const { agents } = await chrome.storage.local.get('agents');
    await chrome.storage.local.set({ agents: agents.map((a) => ({ ...a, voice: 'bf_emma' })) });
  });
  const before = (await roster())[0];

  // Another name, the same site: one site has one assistant, whatever either is called.
  const newer = JSON.parse(RECIPE);
  newer.name = 'Acme CRM';
  newer.recordedOn = '2026-10-16';
  newer.recipe.quietPeriodMs = 700;
  await settings.fill('#import-text', JSON.stringify(newer));

  await expect(settings.locator('#import-question'))
    .toHaveText('Acme already has a recipe for fixture.test. Replace it with this one, recorded 16 October?');
  await expect(settings.locator('#import-add')).toBeDisabled();
  await expect(settings.locator('#import-choice button')).toHaveText(['Replace']);
  // Asked directly to add it instead, the worker refuses too.
  expect(await settings.evaluate((text) => chrome.runtime.sendMessage({ kind: 'openposse.agent.import', text }),
    JSON.stringify(newer))).toEqual({
    ok: false, reason: 'Acme already has a recipe for fixture.test. Replace it instead.',
  });
  await settings.click('#import-replace');
  await expect(settings.locator('#import-status')).toHaveText('Replaced Acme’s recipe.');

  const after = await roster();
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ id: before.id, name: 'Acme', voice: 'bf_emma', channel: before.channel });
  expect(after[0].recipe).toMatchObject({ quietPeriodMs: 700, recordedOn: '2026-10-16' });
});

test('when the page no longer has what the recipe clicks, the turn says the recipe is out of date', async ({ context, extensionId }) => {
  // Acme as recorded before the fake vendor renamed its button.
  const stale = JSON.parse(RECIPE);
  stale.recipe.openSelector = 'button[data-testid="open-assistant-old"]';
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/setup.html`);
  expect(await settings.evaluate((text) => chrome.runtime.sendMessage({ kind: 'openposse.agent.import', text }),
    JSON.stringify(stale))).toMatchObject({ ok: true, name: 'Acme' });
  const vendor = await context.newPage();
  await vendor.goto(VENDOR_URL);
  const panel = await openPanel(context, extensionId);

  await ask(panel, 'What is the pipeline total?');

  await expect(panel.locator('body')).toContainText(
    'Acme’s recipe no longer matches Fixture’s page, which has changed. Record it again from Settings.',
    { timeout: 10_000 });
});
