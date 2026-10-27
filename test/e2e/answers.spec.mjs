// Which element a recording names as the answer, on a chat page that wraps each answer in a
// turn with a hidden heading and a row of buttons, the way Claude's page does (2026-10-26).
// The lasso must name the answer alone, or the turn reads "Responded:", the buttons and the
// time aloud. A reply too short to tell from that furniture asks for a longer one instead.

import { test, expect, openPanel } from './browser.mjs';

const URL = 'https://fixture.test/chat';

/**
 * A chat page whose box is always there, answering after a moment. With `keep`, only that many
 * turns stay on the page, the oldest taken off as each answer arrives, as Copilot's does.
 */
const page = (answer, keep = 0) => `<!doctype html><html><head><style>
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
  .contents { display: contents; }
</style></head><body>
<div id="log"></div>
<textarea id="box"></textarea>
<button aria-label="Send message" id="send">Send</button>
<script>
let n = 0;
document.getElementById('send').addEventListener('click', () => {
  const question = document.getElementById('box').value;
  document.getElementById('box').value = '';
  n += 1;
  const text = ${JSON.stringify(answer)}.replace('N', n).replace('Q', question);
  const turn = document.createElement('div');
  turn.innerHTML = '<div data-turn-key="turn-' + n + '" aria-label="Message ' + n + ' of ' + n + '">'
    + '<h3 class="sr-only">Responded:</h3>'
    + '<div class="contents"><div data-answer-text><p>' + text + '</p></div></div>'
    + '<div role="toolbar" aria-label="Message actions"><button>Copy</button><button>Read aloud</button>'
    + '<button>Good answer</button><button>Bad answer</button><span>just now</span></div></div>';
  const log = document.getElementById('log');
  // With \`keep\`, from the check's own questions on (after the two recorded), an older answer
  // is also taken off and mounted again at once, its text empty for a moment, and the new
  // answer takes longer than a settle to arrive.
  const late = ${keep} > 0 && n > 2;
  const old = late && log.firstElementChild;
  if (old) {
    const again = old.cloneNode(true);
    const text = again.querySelector('[data-answer-text] p');
    const words = text.textContent;
    text.textContent = '';
    old.replaceWith(again);
    setTimeout(() => { text.textContent = words; }, 100);
  }
  setTimeout(() => {
    log.append(turn);
    while (${keep} > 0 && log.children.length > ${keep}) log.firstElementChild.remove();
  }, late ? 2000 : 300);
});
</script></body></html>`;

/** Lassos the chat page, says there is nothing to open, and asks two questions. */
async function lassoChat(context, extensionId, answer, keep = 0) {
  await context.route(URL, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: page(answer, keep) }));
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
    await chat.click('#send');
    // The recorder waits for the page to settle before it decides what the answer was.
    await chat.waitForTimeout(4000);
  }
  return panel;
}

test('a recorded answer is the answer alone, not the turn around it', async ({ context, extensionId }) => {
  const panel = await lassoChat(context, extensionId,
    'Here is answer N about Q, which runs well past forty characters so it counts.');

  await expect(panel.locator('#coach-say')).toContainText('Saved as', { timeout: 20_000 });
  const selectors = await panel.evaluate(async () => {
    const { agents = [] } = await chrome.storage.local.get('agents');
    const lassos = await chrome.storage.local.get(agents.map((a) => `lasso:${a.lassoID}`));
    return Object.values(lassos).map((lasso) => lasso.responseContainerSelector);
  });
  expect(selectors).toEqual(['div[data-answer-text]']);
});

test('an answer too short to find asks for a longer one', async ({ context, extensionId }) => {
  const panel = await lassoChat(context, extensionId, 'Hello N!');
  await expect(panel.locator('#coach-say')).toContainText('too short for us to find');
});

test('a page that takes older answers off as new ones arrive still has its answers found', async ({ context, extensionId }) => {
  // Two turns stay mounted: the check's own questions find two already there, and each new
  // answer takes the oldest off, so the count never rises past two.
  const panel = await lassoChat(context, extensionId,
    'Here is answer N about Q, which runs well past forty characters so it counts.', 2);
  await expect(panel.locator('#coach-say')).toContainText('Saved as', { timeout: 30_000 });
});
