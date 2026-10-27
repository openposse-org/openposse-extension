// The extension, loaded and driven in a real browser. See browser.mjs for what every test
// shares, including the rule that a test fails if any page logged an error.
//
// What these cannot reach, and docs/testing.md checks by hand: the microphone and speech
// recognition, Kokoro, real vendors, Chrome's own Allow dialog, the side panel's frame and the
// global shortcut.

import { test, expect, addAcme, openPanel, ask, LASSO, VENDOR_URL, ANSWER } from './browser.mjs';
import { PHONON } from '../../src/weights.js';

/**
 * Puts a stand-in for every Phonon file in its cache, so the page reads Phonon as installed. Not
 * the real weights, which the test browser cannot fetch: what this checks is what the page does
 * with an installed voice, not the voice.
 */
async function fakePhonon(page) {
  await page.evaluate(async ({ cache, urls }) => {
    const store = await caches.open(cache);
    for (const url of urls) await store.put(url, new Response('stand-in'));
  }, { cache: PHONON.cache, urls: PHONON.files.map((f) => f.url) });
}

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

test('Phonon is offered first, needs no agreement, and answers once installed, WebGPU or not', async ({ context, extensionId }) => {
  // The test browser has no WebGPU, which is the case Phonon exists for: Supertonic and Kokoro
  // would not speak here, Phonon does.
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/setup.html`);
  const models = settings.locator('#step-weights .model');
  await expect(models.first()).toHaveAttribute('id', 'phonon-model');
  await expect(settings.locator('#phonon-status')).toHaveText(/not downloaded · 66 MB/);
  await expect(settings.locator('#get-phonon')).toBeEnabled();

  await fakePhonon(settings);
  await settings.reload();
  await expect(settings.locator('#phonon-status')).toHaveText(`installed – ${PHONON.files.length} files, verified`);
  await expect(settings.locator('#engine')).toHaveText(/^Phonon – neural voices/);
  await expect(settings.locator('#step-weights')).toHaveClass(/done/);
  // Its voices, by accent, in place of the system voices.
  await expect(settings.locator('#voices-section')).toBeVisible();
  await expect(settings.locator('#voice-list')).toContainText('Harper');
  await expect(settings.locator('#voice-list')).toContainText('Edwin');
  // One engine that can speak is nothing to choose between.
  await expect(settings.locator('#engine-choice')).toBeHidden();
});

test("Phonon's vendored runtime starts its worker and WebAssembly from the package", async ({ context, extensionId }) => {
  // Everything short of real weights: the module imports from the extension, the worker starts,
  // the WebAssembly compiles under the page's CSP and reads files from blob: URLs, and only then
  // are the stand-in files refused. A wrong path or a blocked worker fails earlier, and differently.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/setup.html`);
  const outcome = await page.evaluate(async () => {
    const vendor = (path) => chrome.runtime.getURL(`vendor/phonon/${path}`);
    const { PhononTTS } = await import(vendor('index.js'));
    const blob = URL.createObjectURL(new Blob(['not a model']));
    try {
      await PhononTTS.load({
        lang: 'en', quant: 'q8', cache: false, device: 'cpu', threads: 1,
        model: { weights: { q8: blob }, tokenizer: blob, config: blob, voices: {} },
        workerUrl: vendor('worker.js'),
        wasmUrl: vendor('wasm/phonon_tts_bg.wasm'),
        simdWasmUrl: vendor('wasm/phonon_tts_simd_bg.wasm'),
      });
      return 'loaded';
    } catch (error) {
      return String(error?.message ?? error);
    }
  });
  // A positive check, not a list of failures it is not: the stand-in got as far as being parsed.
  expect(outcome).toMatch(/^cannot parse config\.json/);
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

test('an answer whose element the page replaces mid-answer comes back whole', async ({ context, extensionId }) => {
  // Claude's page did this, and only its first word, "Not", reached the panel and was spoken.
  await addAcme(context, extensionId);
  const vendor = await context.newPage();
  await vendor.goto(`${VENDOR_URL}?swap`);
  const panel = await openPanel(context, extensionId);

  await ask(panel, 'What is the pipeline total?');

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
 * without a download. WebGPU is taken away too, so every runner sees the same onboarding. Everything after them – recording the grant, ticking – is the real code.
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
    // No WebGPU unless a test gives it one. Headless Chromium has none on Linux and Windows, but
    // on the macOS runners it gets a real adapter, and Downloads then waits for a voice.
    Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
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
  // The test browser has no WebGPU, and the voice step says so – and that Phonon speaks without it,
  // so a voice is still needed to go on.
  await expect(page.locator('#ob-gpu')).toContainText('no WebGPU in this Chrome – Phonon will still speak');
  await expect(page.locator('#ob-next')).toBeDisabled();
  await expect(page.locator('#ob-busy')).toHaveText('Download a voice to go on.');
  await fakePhonon(page);
  await expect(page.locator('#ob-next')).toBeEnabled();

  await page.click('#ob-next');
  await expect(tab(page, 'Your AI assistants')).toHaveAttribute('aria-selected', 'true');
  // With the install's assistants taken out by the harness, there is nothing to allow yet.
  await expect(page.locator('#ob-builtins')).toBeHidden();
  await expect(page.locator('#ob-open-panel')).toBeVisible();
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
  await expect(tab(page, 'Your AI assistants')).toBeDisabled();
});

test('a Chrome without on-device speech is told so in Downloads', async ({ context, extensionId }) => {
  const page = await onboarding(context, extensionId, { model: 'unavailable' });
  await page.click('#ob-start');
  await tab(page, 'Downloads').click();
  await expect(page.locator('#model-status')).toContainText('switched off in this Chrome');
});

test('the first assistant ticks onboarding wherever it was added', async ({ context, extensionId }) => {
  const page = await onboarding(context, extensionId);
  await page.click('#ob-start');
  // A voice is needed to reach the last task, and Phonon can be had without WebGPU.
  await fakePhonon(page);
  await expect(tab(page, 'Your AI assistants')).toBeEnabled();
  await tab(page, 'Your AI assistants').click();
  await addAcme(context, extensionId);
  await expect(page.locator('#ob-assistant-status')).toContainText('Acme is ready');
  await expect(tab(page, 'Your AI assistants')).toContainText('done');
});

test.describe('the lassos that come with OpenPosse, added at install', () => {
  test.use({ builtIns: true });

  /** The roster's names, in order. */
  const names = (page) => page.evaluate(async () => {
    const { agents = [] } = await chrome.storage.local.get('agents');
    return agents.map((agent) => agent.name);
  });

  test('every one is in the roster, and those not allowed wait in Settings with an Allow', async ({ context, extensionId }) => {
    const settings = context.pages().find((p) => p.url() === `chrome-extension://${extensionId}/setup.html`);
    // Those in lassos/, in the order of their files, less the website's demo vendor.
    expect(await names(settings)).toEqual(['Sam', 'Sofia', 'Peter']);

    await settings.click('#ob-welcome .ob-close');
    // None of their sites is allowed: an install cannot ask.
    const waiting = settings.locator('#roster .agent', { has: settings.locator('.kind.warn') });
    await expect(waiting).toHaveCount(3);
    await expect(settings.locator('#roster .agent', { hasText: 'ChatGPT' }).locator('.kind.warn'))
      .toHaveText('ChatGPT · not allowed yet');
    await expect(settings.getByRole('button', { name: 'Allow chatgpt.com' })).toBeVisible();
    await expect(settings.locator('#allow-all')).toHaveText('Allow all 3 sites');
  });

  test('onboarding lists them, with one Allow all, and does not tick until one is allowed', async ({ context, extensionId }) => {
    const page = await onboarding(context, extensionId);
    await page.click('#ob-start');
    await fakePhonon(page);
    await expect(tab(page, 'Your AI assistants')).toBeEnabled();
    await tab(page, 'Your AI assistants').click();
    await expect(page.locator('#ob-builtin-list li')).toHaveCount(3);
    await expect(page.locator('#ob-builtin-list li', { hasText: 'not allowed yet' })).toHaveCount(3);
    await expect(page.locator('#ob-allow')).toHaveText('Allow all 3 sites');
    await expect(page.locator('#ob-assistant-status')).toContainText('none allowed yet');
    await expect(tab(page, 'Your AI assistants')).toContainText('not started');

    // One that is allowed – the fake vendor's, whose site this build grants – ticks it.
    await addAcme(context, extensionId);
    await expect(page.locator('#ob-builtin-list li')).toHaveCount(4);
    await expect(page.locator('#ob-assistant-status')).toContainText('Acme is ready');
  });

  test('a question to one not allowed yet says so, rather than that no tab is open', async ({ context, extensionId }) => {
    const panel = await openPanel(context, extensionId);
    await expect(panel.locator('#prompt')).toHaveAttribute('data-agent', 'Sam');
    await panel.click('#type');
    await panel.fill('#prompt', 'What is new?');
    await panel.press('#prompt', 'Enter');
    await expect(panel.locator('body')).toContainText('Sam needs access to chatgpt.com – allow it in Settings.');
  });
});

test('on a site whose lasso comes with OpenPosse and no assistant, the panel offers it', async ({ context, extensionId }) => {
  // Deleted from the roster – which the harness has done to all three – it is offered back on its
  // site. Served from here, so the test reaches no real ChatGPT.
  await context.route('https://chatgpt.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>ChatGPT</title>' }));
  const vendor = await context.newPage();
  await vendor.goto('https://chatgpt.com/');
  const panel = await openPanel(context, extensionId);
  // The panel's own page is in front until the vendor's is; then it reads the vendor's tab.
  await vendor.bringToFront();

  await expect(panel.locator('#builtin')).toBeVisible();
  await expect(panel.locator('#builtin-text')).toHaveText('OpenPosse comes with a lasso for ChatGPT.');
  await expect(panel.locator('#builtin-add')).toHaveText('Add ChatGPT');
  // The offer has its own Lasso it myself, so the empty card is not shown under it.
  await expect(panel.locator('#empty')).toBeHidden();
});

test('the worker adds only a lasso the package lists', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/setup.html`);
  const answer = await page.evaluate(
    () => chrome.runtime.sendMessage({ kind: 'openposse.agent.builtin', file: '../manifest.json' }));
  expect(answer).toEqual({ ok: false, reason: '../manifest.json is not a lasso that comes with OpenPosse' });
});

test('an empty side panel says where to go, and how to lasso there, on a page it cannot lasso', async ({ context, extensionId }) => {
  const panel = await openPanel(context, extensionId);
  // The panel's own page is in front, which nothing can drive.
  await expect(panel.locator('#empty-text')).toHaveText(
    'No AI assistants yet. Open the site where your AI assistant lives, then press Lasso this tab here to record it.');
  await expect(panel.locator('#empty-lasso')).toBeHidden();
  // The demo turn is the play button over the orb, not a second button in the card.
  await expect(panel.locator('#empty-demo')).toHaveCount(0);
  await expect(panel.locator('#demo')).toBeVisible();
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

test('a microphone the offscreen document is refused is no longer reported as granted', async ({ context, extensionId }) => {
  // "Allow this time" ends with its tab, and the recorder then hears Chrome dismiss its prompt.
  // The worker is told, and setup's record goes, so the panel and onboarding ask again.
  const panel = await openPanel(context, extensionId);
  await panel.evaluate(() => chrome.storage.local.set({ micGranted: true }));
  await panel.evaluate(() => chrome.runtime.sendMessage({ kind: 'openposse.mic.lost', reason: 'Permission dismissed' }));
  await expect.poll(() => panel.evaluate(async () => (await chrome.storage.local.get('micGranted')).micGranted)).toBe(false);
});
