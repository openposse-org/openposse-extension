// Which control a recording names when the person presses it (2026-11-18). A send control
// drawn as an icon in a plain `div`, whose page swaps it for a Stop control as soon as it is
// released: the pointer lands on a shape of the icon, and by the time `click` fires the control
// it landed on is gone. The lasso must still name the control.

import { test, expect, openPanel } from './browser.mjs';

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
