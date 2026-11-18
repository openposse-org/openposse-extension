// Which control a recording names when the person presses it (2026-11-18). A send control
// drawn as an icon in a plain `div`, whose page swaps it for a Stop control as soon as it is
// released: the pointer lands on a shape of the icon, and by the time `click` fires the control
// it landed on is gone. The lasso must still name the control.

import { test, expect, openPanel, ask, LASSO, VENDOR_URL, ANSWER } from './browser.mjs';

const URL = 'https://fixture.test/icons';

const page = `<!doctype html><html><head><style>
  .send { display: inline-block; width: 32px; height: 32px; cursor: pointer; }
  .send svg { width: 32px; height: 32px; }
</style></head><body>
<div id="log"></div>
<textarea id="box"></textarea>
<div id="bar"></div>
<script>
const SEND = '<div class="send" aria-label="Send"><span><svg viewBox="0 0 32 32"><g><path d="M2 2 L30 16 L2 30 Z"/></g></svg></span></div>';
const STOP = '<div class="send" aria-label="Stop"><span><svg viewBox="0 0 32 32"><rect x="8" y="8" width="16" height="16"/></svg></span></div>';
const bar = document.getElementById('bar');
bar.innerHTML = SEND;
let n = 0;
function send() {
  const question = document.getElementById('box').value;
  document.getElementById('box').value = '';
  n += 1;
  setTimeout(() => {
    const p = document.createElement('p');
    p.setAttribute('data-answer', '');
    p.textContent = 'Here is answer ' + n + ' about ' + question + ', long enough to count as one.';
    document.getElementById('log').append(p);
    bar.innerHTML = SEND;
  }, 300);
}
// Pressed by a person: the page re-renders the control on release, the way chat pages swap
// Send for Stop, so the click that follows lands on the bar rather than on the control.
bar.addEventListener('pointerup', (event) => {
  if (!event.target.closest('[aria-label="Send"]')) return;
  bar.innerHTML = STOP;
  send();
});
// Pressed by a lasso: a synthetic click, with no pointer events.
bar.addEventListener('click', (event) => {
  if (event.detail === 0 && event.target.closest('[aria-label="Send"]')) send();
});
</script></body></html>`;

test('an icon-only control is named, not the shape the pointer landed on', async ({ context, extensionId }) => {
  await context.route(URL, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: page }));
  const chat = await context.newPage();
  await chat.goto(URL);
  const panel = await openPanel(context, extensionId);
  await panel.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.runtime.sendMessage({ kind: 'openposse.record', tabId: tab.id, pattern: '*.fixture.test' });
  }, URL);
  await chat.bringToFront();
  await panel.locator('#coach-always').click();
  for (const question of ['What is the weather like today', 'Tell me about the pipeline']) {
    await chat.click('#box');
    await chat.fill('#box', question);
    // On the triangle itself, the way a person presses an icon.
    await chat.locator('[aria-label="Send"] path').click();
    await chat.waitForTimeout(4000);
  }

  await expect(panel.locator('#coach-say')).toContainText('Saved as', { timeout: 20_000 });
  const lassos = await panel.evaluate(async () => {
    const { agents = [] } = await chrome.storage.local.get('agents');
    const stored = await chrome.storage.local.get(agents.map((a) => `lasso:${a.lassoID}`));
    return Object.values(stored).map(({ submitMethod, submitSelector }) => ({ submitMethod, submitSelector }));
  });
  expect(lassos).toEqual([{ submitMethod: 'click', submitSelector: 'div[aria-label="Send"]' }]);
});

// ── Opening behind a menu, fallbacks, and the bar on the page (2026-11-18) ──────────────────

const MENU_URL = 'https://fixture.test/menu';

/**
 * An assistant that opens from a menu: the menu button, then "Ask AI" in it, then the box. A
 * Help button beside the menu reveals nothing, so pressing it first must not become a step.
 */
const menuPage = `<!doctype html><html><body>
<button aria-label="Help" id="help">?</button>
<button aria-label="Assistant menu" aria-haspopup="menu" id="menu">AI</button>
<div id="slot"></div>
<div id="log"></div>
<script>
let n = 0;
document.getElementById('menu').addEventListener('click', () => {
  document.getElementById('slot').innerHTML = '<div role="menu"><button role="menuitem" aria-label="Ask AI">Ask AI</button></div>';
  document.querySelector('[aria-label="Ask AI"]').addEventListener('click', () => {
    document.getElementById('slot').innerHTML = '<textarea aria-label="Ask"></textarea>'
      + '<button data-testid="send" aria-label="Send">Send</button>';
    const box = document.querySelector('textarea');
    document.querySelector('[data-testid="send"]').addEventListener('click', () => {
      n += 1;
      const question = box.value;
      box.value = '';
      setTimeout(() => {
        const p = document.createElement('p');
        p.setAttribute('data-answer', '');
        p.textContent = 'Here is answer ' + n + ' about ' + question + ', long enough to count as one.';
        document.getElementById('log').append(p);
      }, 300);
    });
    box.focus();
  });
});
</script></body></html>`;

async function startMenu(context, extensionId) {
  await context.route(MENU_URL, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: menuPage }));
  const chat = await context.newPage();
  await chat.goto(MENU_URL);
  const panel = await openPanel(context, extensionId);
  await panel.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.runtime.sendMessage({ kind: 'openposse.record', tabId: tab.id, pattern: '*.fixture.test' });
  }, MENU_URL);
  await expect(panel.locator('#coach')).toBeVisible();
  await chat.bringToFront();
  return { chat, panel };
}

const storedLassos = (panel) => panel.evaluate(async () => {
  const { agents = [] } = await chrome.storage.local.get('agents');
  const stored = await chrome.storage.local.get(agents.map((a) => `lasso:${a.lassoID}`));
  return Object.values(stored);
});

test('an assistant behind a menu is lassoed as both clicks, and opens with both', async ({ context, extensionId }) => {
  const { chat, panel } = await startMenu(context, extensionId);
  // The bar says so on the page while the recording lasts.
  await expect(chat.locator('openposse-lasso-bar')).toBeVisible();

  await chat.click('#help');
  await chat.click('#menu');
  await chat.click('[aria-label="Ask AI"]');
  for (const question of ['What is the weather like today', 'Tell me about the pipeline']) {
    await chat.fill('textarea', question);
    await chat.click('[data-testid="send"]');
    await chat.waitForTimeout(4000);
  }

  await expect(panel.locator('#coach-say')).toContainText('Saved as', { timeout: 20_000 });
  await expect(chat.locator('openposse-lasso-bar')).toHaveCount(0);
  const [lasso] = await storedLassos(panel);
  expect(lasso).toMatchObject({
    openMethod: 'click',
    openSelector: '#menu',
    openSteps: ['#menu', 'button[aria-label="Ask\\ AI"]'],
    submitSelector: 'button[data-testid="send"]',
    // Each control's other names that found it alone, kept for when the first one goes.
    fallbacks: {
      open: ['button[aria-label="Assistant\\ menu"]'],
      submit: ['button[aria-label="Send"]'],
    },
  });

  // From a fresh page, where the assistant is shut: the menu, its item, then the question.
  await panel.click('#coach-name button[type="submit"]');
  await expect(panel.locator('#coach')).toBeHidden();
  await chat.reload();
  await panel.reload();
  await expect(panel.locator('#prompt')).toHaveAttribute('data-agent', /.+/);
  await panel.click('#type');
  await panel.fill('#prompt', 'What is on the board');
  await panel.press('#prompt', 'Enter');
  await expect(chat.locator('p[data-answer]').last()).toContainText('What is on the board', { timeout: 20_000 });
});

test('Stop on the bar in the page ends the lassoing, and nothing is saved', async ({ context, extensionId }) => {
  const { chat, panel } = await startMenu(context, extensionId);
  const bar = chat.locator('openposse-lasso-bar');
  await expect(bar).toBeVisible();
  // The bar's shadow root is closed, so its Stop button is pressed where it is drawn: at the
  // bar's right-hand end.
  const box = await bar.boundingBox();
  await chat.mouse.click(box.x + box.width - 22, box.y + box.height / 2);

  await expect(panel.locator('#coach')).toBeHidden();
  await expect(bar).toHaveCount(0);
  expect(await storedLassos(panel)).toEqual([]);
});

test('when the page renames what the lasso clicks, a recorded fallback still finds it', async ({ context, extensionId }) => {
  // The same out-of-date lasso as above, recorded with a second selector for the button
  // (2026-11-18). The first finds nothing now; the fallback does, and the turn goes through.
  const stale = JSON.parse(LASSO);
  stale.lasso.openSelector = 'button[data-testid="open-assistant-old"]';
  stale.lasso.fallbacks = { open: ['button[data-testid="open-assistant"]'] };
  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${extensionId}/setup.html`);
  expect(await settings.evaluate((text) => chrome.runtime.sendMessage({ kind: 'openposse.agent.import', text }),
    JSON.stringify(stale))).toMatchObject({ ok: true, name: 'Acme' });
  const vendor = await context.newPage();
  await vendor.goto(VENDOR_URL);
  const panel = await openPanel(context, extensionId);

  await ask(panel, 'What is the pipeline total?');

  await expect(panel.locator('body')).toContainText(ANSWER, { timeout: 20_000 });
});
