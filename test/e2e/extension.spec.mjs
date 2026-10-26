// The extension, loaded and driven in a real browser. See browser.mjs for what every test
// shares, including the rule that a test fails if any page logged an error.
//
// What these cannot reach, and docs/testing.md checks by hand: the microphone and speech
// recognition, Kokoro, real vendors, Chrome's own Allow dialog, the side panel's frame and the
// global shortcut.

import { test, expect, addAcme, openPanel, ask, LASSO, VENDOR_URL, ANSWER } from './browser.mjs';

test('every extension page opens without an error', async ({ context, extensionId }) => {
  // `offscreen.html` too, opened as a tab: Chrome's own offscreen document is not a page these
  // tests watch, so a module that throws as it loads there (it carries ONNX Runtime for
  // Supertonic) would otherwise only ever show up as a voice that never speaks.
  for (const name of ['setup.html', 'sidepanel.html', 'offscreen.html']) {
    // A step per page, so a failure names the page rather than leaving it to a timeout.
    await test.step(name, async () => {
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/${name}`);
      // Long enough for each page's startup work to finish, so an error in it is caught too.
      // Not Playwright's 'networkidle': on the macOS 26 runner image of 2026-10-21, setup.html
      // went 60s without reaching it in four runs of five, and was slow in the fifth, with every
      // request finished and none in flight. It loads in under half a second elsewhere.
      await page.waitForTimeout(1_000);
      await expect(page).toHaveTitle(/OpenPosse/);
      await page.close();
    });
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

  await settings.fill('#import-text', LASSO);
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

test("a typed question that starts with the assistant's name reaches the vendor without it", async ({ context, extensionId }) => {
  // People type the way they speak: "Matt, what is on this to-do list?" once reached the vendor
  // with "Matt," still in it, because the typed path went straight to the agent the box was
  // pointed at and never looked at how the sentence began.
  await addAcme(context, extensionId);
  const vendor = await context.newPage();
  await vendor.goto(VENDOR_URL);
  const panel = await openPanel(context, extensionId);

  await ask(panel, 'Acme, what is the pipeline total?');

  await expect(vendor.locator('[data-testid="question"]')).toHaveText('what is the pipeline total?');
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
  await settings.fill('#import-text', LASSO);
  await settings.click('#import-add');
  await expect(settings.locator('#import-status')).toHaveText('Added Acme.');

  await settings.fill('#import-text', LASSO);

  await expect(settings.locator('#import-status')).toHaveText('You already have this one, as Acme.');
  await expect(settings.locator('#import-add')).toBeDisabled();
  await expect(settings.locator('#import-choice')).toBeHidden();
});

test('a newer version of a shared assistant replaces its lasso and keeps the assistant', async ({ context, extensionId }) => {
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/setup.html`);
  await settings.fill('#import-text', LASSO);
  await settings.click('#import-add');
  await expect(settings.locator('#import-status')).toHaveText('Added Acme.');
  // A voice chosen after adding it, which a replacement must not take away.
  const roster = () => settings.evaluate(async () => {
    const { agents } = await chrome.storage.local.get('agents');
    const lassos = await chrome.storage.local.get(agents.map((a) => `lasso:${a.lassoID}`));
    return agents.map((a) => ({ ...a, lasso: lassos[`lasso:${a.lassoID}`] }));
  });
  await settings.evaluate(async () => {
    const { agents } = await chrome.storage.local.get('agents');
    await chrome.storage.local.set({ agents: agents.map((a) => ({ ...a, voice: 'bf_emma' })) });
  });
  const before = (await roster())[0];

  // Another name, the same site: one site has one assistant, whatever either is called.
  const newer = JSON.parse(LASSO);
  newer.name = 'Acme CRM';
  newer.recordedOn = '2026-10-16';
  newer.lasso.quietPeriodMs = 700;
  await settings.fill('#import-text', JSON.stringify(newer));

  await expect(settings.locator('#import-question'))
    .toHaveText('Acme already has a lasso for fixture.test. Replace it with this one, recorded 16 October?');
  await expect(settings.locator('#import-add')).toBeDisabled();
  await expect(settings.locator('#import-choice button')).toHaveText(['Replace']);
  // Asked directly to add it instead, the worker refuses too.
  expect(await settings.evaluate((text) => chrome.runtime.sendMessage({ kind: 'openposse.agent.import', text }),
    JSON.stringify(newer))).toEqual({
    ok: false, reason: 'Acme already has a lasso for fixture.test. Replace it instead.',
  });
  await settings.click('#import-replace');
  await expect(settings.locator('#import-status')).toHaveText('Replaced Acme’s lasso.');

  const after = await roster();
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ id: before.id, name: 'Acme', voice: 'bf_emma', channel: before.channel });
  expect(after[0].lasso).toMatchObject({ quietPeriodMs: 700, recordedOn: '2026-10-16' });
});

test('when the page no longer has what the lasso clicks, the turn says the lasso is out of date', async ({ context, extensionId }) => {
  // Acme as recorded before the fake vendor renamed its button.
  const stale = JSON.parse(LASSO);
  stale.lasso.openSelector = 'button[data-testid="open-assistant-old"]';
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/setup.html`);
  expect(await settings.evaluate((text) => chrome.runtime.sendMessage({ kind: 'openposse.agent.import', text }),
    JSON.stringify(stale))).toMatchObject({ ok: true, name: 'Acme' });
  const vendor = await context.newPage();
  await vendor.goto(VENDOR_URL);
  const panel = await openPanel(context, extensionId);

  await ask(panel, 'What is the pipeline total?');

  await expect(panel.locator('body')).toContainText(
    'Acme’s lasso no longer matches Fixture’s page, which has changed. Lasso it again from Settings.',
    { timeout: 10_000 });
});

// ── First run ──────────────────────────────────────────────────────────────────────────────

/**
 * The Settings tab the install opened, with the two things automation cannot do stubbed: Chrome's
 * microphone prompt, answered with a silent track, and the speech model, reported as `model`
 * without a download. Everything after them – recording the grant, ticking – is the real code.
 *
 * The install's request was taken when the tab first loaded, so the reload asks for onboarding
 * again, before the page's own script runs, the way the worker asks before opening Settings.
 */
async function onboarding(context, extensionId, { model = 'available', before } = {}) {
  const page = context.pages().find((p) => p.url() === `chrome-extension://${extensionId}/setup.html`);
  await page.addInitScript((state) => {
    navigator.mediaDevices.getUserMedia = async () => new AudioContext().createMediaStreamDestination().stream;
    const SR = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
    if (SR) SR.available = async () => state;
    chrome.storage.session.set({ onboarding: Date.now() });
  }, model);
  if (before) await page.addInitScript(before);
  await page.reload();
  await expect(page.locator('#onboarding')).toHaveAttribute('open', '');
  return page;
}

const tab = (page, name) => page.getByRole('tab', { name: new RegExp(name) });

test('onboarding opens on the welcome, then walks the three tasks, each step ticking itself', async ({ context, extensionId }) => {
  const page = await onboarding(context, extensionId);
  await expect(page.locator('#ob-welcome')).toBeVisible();
  await expect(page.locator('#ob-welcome h1')).toHaveText('Talk to the AI assistants you already use.');
  await page.click('#ob-start');

  // Permissions, with the shortcut first. It comes from Chrome, never from the page: the
  // manifest suggests one, so it ticks.
  await expect(tab(page, 'Permissions')).toHaveAttribute('aria-selected', 'true');
  const steps = page.locator('#ob-permissions > .step');
  await expect(steps).toHaveCount(4);
  await expect(steps.first()).toHaveAttribute('id', 'step-shortcut');
  const key = await page.evaluate(async () =>
    (await chrome.commands.getAll()).find((c) => c.name === 'summon')?.shortcut ?? '');
  expect(key, 'the manifest suggests a shortcut').not.toBe('');
  await expect(page.locator('#step-shortcut')).toHaveClass(/done/);
  await expect(page.locator('#shortcut-status')).toHaveText(key);

  // The microphone is Settings' own step, borrowed, and its own button.
  await page.click('#grant-mic');
  await expect(page.locator('#step-mic')).toHaveClass(/done/);
  await expect(page.locator('#mic-status')).toHaveText('granted');

  // Not pinned in a test browser; skipping says so, and is not the same as done.
  await page.click('#skip-pin');
  await expect(page.locator('#pin-status')).toHaveText('skipped');
  await expect(tab(page, 'Permissions')).toContainText('2 of 4 done');

  // The tab group shows what Chrome holds, off here, and "Not now" answers it without Chrome's
  // prompt, which automation cannot reach – ticking it there and then, not after Next.
  await expect(page.locator('#ob-grouping')).toHaveAttribute('aria-checked', 'false');
  await page.click('#ob-grouping-no');
  await expect(page.locator('#step-grouping')).toHaveClass(/done/);
  await expect(page.locator('#ob-grouping-no')).toBeHidden();
  await expect(tab(page, 'Permissions')).toContainText('3 of 4 done');
  await page.click('#ob-next');
  await expect(tab(page, 'Downloads')).toHaveAttribute('aria-selected', 'true');

  // The speech model is reported ready, so it ticks without a press; better voices are there too.
  await expect(page.locator('#ob-downloads > .step').first()).toHaveAttribute('id', 'step-model');
  await expect(page.locator('#step-model')).toHaveClass(/done/);
  await expect(page.locator('#ob-downloads #step-weights')).toBeVisible();
  // The test browser has no WebGPU, and the voice step says so, and that it may be skipped.
  await expect(page.locator('#ob-gpu')).toContainText('no WebGPU');

  await page.click('#ob-next');
  await expect(tab(page, 'Your first lasso')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#ob-tiles button')).toHaveCount(6);
  await expect(page.locator('#ob-next')).toHaveText('Done');

  // Next waits while Settings counts a download running, and says why.
  await page.evaluate(() => {
    document.documentElement.dataset.downloading = '1';
    document.getElementById('onboarding').dispatchEvent(new Event('downloads'));
  });
  await expect(page.locator('#ob-next')).toBeDisabled();
  await expect(page.locator('#ob-busy')).toContainText('keep this tab open');
  await page.evaluate(() => {
    document.documentElement.dataset.downloading = '0';
    document.getElementById('onboarding').dispatchEvent(new Event('downloads'));
  });
  await expect(page.locator('#ob-next')).toBeEnabled();

  // Back goes back, and from the first task to the welcome.
  await tab(page, 'Permissions').click();
  await expect(page.locator('#step-grouping')).toHaveClass(/done/);
  await page.click('#ob-back');
  await expect(page.locator('#ob-welcome')).toBeVisible();

  // Closing puts the borrowed steps back in the setup sheet, numbered as they were.
  await page.click('#ob-welcome .ob-close');
  await expect(page.locator('#onboarding')).not.toHaveAttribute('open', '');
  await expect(page.locator('#setup-sheet > .step')).toHaveCount(5);
  await expect(page.locator('#setup-sheet #step-shortcut .num')).toHaveText('3');

  // And the setup sheet is the way back.
  await page.click('#setup');
  await page.click('#open-onboarding');
  await expect(page.locator('#onboarding')).toHaveAttribute('open', '');
  expect(await page.evaluate(() => document.getElementById('setup-sheet').matches(':popover-open'))).toBe(false);
  await expect(page.locator('#ob-permissions #step-mic')).toHaveCount(1);
});

test('switching the tab group on asks Chrome there and then, and a no leaves it off', async ({ context, extensionId }) => {
  // Chrome's prompt is out of reach, so it answers no here, and says what it was asked for.
  const page = await onboarding(context, extensionId, {
    before: () => {
      window.__asked = [];
      chrome.permissions.request = async (what) => { window.__asked.push(what); return false; };
    },
  });
  await page.click('#ob-start');
  await page.click('#ob-grouping');
  await expect(page.locator('#step-grouping')).toHaveClass(/done/);
  expect(await page.evaluate(() => window.__asked)).toEqual([{ permissions: ['tabGroups'] }]);
  await expect(page.locator('#ob-grouping')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#ob-grouping-note')).toContainText('grouping is off');
  expect(await page.evaluate(() => chrome.permissions.contains({ permissions: ['tabGroups'] }))).toBe(false);
});

test('with WebGPU, Downloads waits for a neural voice as well as the speech model', async ({ context, extensionId }) => {
  // The test browser has no WebGPU, so it is given one; no voice is downloaded here.
  const page = await onboarding(context, extensionId, {
    before: () => { Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => ({}) } }); },
  });
  await page.click('#ob-start');
  await expect(tab(page, 'Downloads')).toContainText('1 of 2 done');
  await tab(page, 'Downloads').click();
  await expect(page.locator('#step-model')).toHaveClass(/done/);
  await expect(page.locator('#step-weights')).not.toHaveClass(/done/);
  await expect(page.locator('#step-weights h2 .kind')).toBeHidden();
  await expect(page.locator('#ob-gpu')).toHaveText('WebGPU available');
  // And nothing moves on to the first lasso until a voice is downloaded, Next or its tab.
  await expect(page.locator('#ob-next')).toBeDisabled();
  await expect(page.locator('#ob-busy')).toHaveText('Download a voice to go on.');
  await expect(tab(page, 'Your first lasso')).toBeDisabled();
});

test('a Chrome without on-device speech is told so in Downloads', async ({ context, extensionId }) => {
  const page = await onboarding(context, extensionId, { model: 'unavailable' });
  await page.click('#ob-start');
  await tab(page, 'Downloads').click();
  await expect(page.locator('#model-status')).toContainText('switched off in this Chrome');
});

test('a site tile opens that site in a new tab, and only on a click', async ({ context, extensionId }) => {
  // Served from here, so the test reaches no real vendor.
  await context.route('https://app.notion.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Notion</title>' }));
  const page = await onboarding(context, extensionId);
  await page.click('#ob-start');
  await tab(page, 'Your first lasso').click();
  const before = context.pages().length;

  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Open Notion in a new tab' }).click();
  const notion = await opened;
  await expect.poll(() => notion.url()).toBe('https://app.notion.com/');
  expect(context.pages().length).toBe(before + 1);
});

test('the first assistant ticks onboarding wherever it was added', async ({ context, extensionId }) => {
  const page = await onboarding(context, extensionId);
  await page.click('#ob-start');
  await tab(page, 'Your first lasso').click();
  await addAcme(context, extensionId);
  await expect(page.locator('#ob-assistant-status')).toContainText('Acme is ready');
  await expect(tab(page, 'Your first lasso')).toContainText('done');
});

test('an empty side panel offers the demo turn, and says where to go on a page it cannot lasso', async ({ context, extensionId }) => {
  const panel = await openPanel(context, extensionId);
  // The panel's own page is in front, which nothing can drive.
  await expect(panel.locator('#empty-text')).toHaveText('No AI assistants yet. Open the site where your AI assistant lives.');
  await expect(panel.locator('#empty-lasso')).toBeHidden();
  await expect(panel.locator('#empty-demo')).toBeVisible();
  // Setup is not finished in a fresh profile, so the way back to it is offered.
  await expect(panel.locator('#finish-setup')).toBeVisible();

  await addAcme(context, extensionId);
  await expect(panel.locator('#empty')).toBeHidden();
});

test('Finish setting up brings onboarding back over the Settings already open', async ({ context, extensionId }) => {
  const settings = context.pages().find((p) => p.url() === `chrome-extension://${extensionId}/setup.html`);
  await settings.click('#ob-welcome .ob-close');
  await expect(settings.locator('#onboarding')).not.toHaveAttribute('open', '');
  const count = () => context.pages().filter((p) => p.url() === settings.url()).length;
  const before = count();

  const panel = await openPanel(context, extensionId);
  await panel.click('#finish-setup');
  await expect(settings.locator('#onboarding')).toHaveAttribute('open', '');
  // `openOptionsPage()` brings the open one to the front rather than opening another.
  expect(count()).toBe(before);
});
