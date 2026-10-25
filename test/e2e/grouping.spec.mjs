// The OpenPosse tab group, against Chrome's real tabGroups API. See src/grouping.js.
//
// The extension holds `tabGroups` from the start here (`grouping: true` in browser.mjs), standing
// in for Chrome's Allow dialog, which automation cannot reach. What that leaves to the hand
// checks in docs/testing.md: the prompt itself, switching grouping off (a required permission
// cannot be given back), and a restart.

import { test, expect, addAcme, openPanel, ask, VENDOR_URL, ANSWER } from './browser.mjs';

test.use({ grouping: true });

/** Every tab group open now, and which group each fixture tab is in, read from Chrome. */
async function groups(panel) {
  return panel.evaluate(async () => ({
    groups: (await chrome.tabGroups.query({})).map(({ id, title, color, windowId }) => ({ id, title, color, windowId })),
    tabs: (await chrome.tabs.query({ url: 'https://fixture.test/*' }))
      .map(({ id, groupId, windowId, pinned }) => ({ id, groupId, windowId, pinned })),
  }));
}

/** Asks, and waits for the vendor to have written its answer in full. */
async function askAndWait(panel, vendor, question, nth) {
  // The text box stays open after the first question, and pressing its button again closes it.
  if (await panel.locator('#prompt').isVisible()) {
    await panel.fill('#prompt', question);
    await panel.press('#prompt', 'Enter');
  } else {
    await ask(panel, question);
  }
  await expect(vendor.locator('[data-testid="answer"]').nth(nth)).toContainText(ANSWER, { timeout: 20_000 });
}

test('a question puts the vendor tab in one OpenPosse group, and the next keeps it there', async ({ context, extensionId }) => {
  await addAcme(context, extensionId);
  const vendor = await context.newPage();
  await vendor.goto(VENDOR_URL);
  const panel = await openPanel(context, extensionId);

  await askAndWait(panel, vendor, 'What is the pipeline total?', 0);
  await expect.poll(async () => (await groups(panel)).groups).toEqual([
    expect.objectContaining({ title: 'OpenPosse', color: 'purple' }),
  ]);
  const first = await groups(panel);
  expect(first.tabs[0].groupId).toBe(first.groups[0].id);

  await askAndWait(panel, vendor, 'And last quarter?', 1);
  const second = await groups(panel);
  expect(second.groups, 'still one group').toHaveLength(1);
  expect(second.tabs[0].groupId).toBe(first.groups[0].id);
});

test('a tab dragged out of the group rejoins it on the next question', async ({ context, extensionId }) => {
  await addAcme(context, extensionId);
  const vendor = await context.newPage();
  await vendor.goto(VENDOR_URL);
  const panel = await openPanel(context, extensionId);
  await askAndWait(panel, vendor, 'What is the pipeline total?', 0);
  await expect.poll(async () => (await groups(panel)).tabs[0].groupId).not.toBe(-1);

  const tabId = (await groups(panel)).tabs[0].id;
  await panel.evaluate((id) => chrome.tabs.ungroup(id), tabId);
  await askAndWait(panel, vendor, 'And last quarter?', 1);

  await expect.poll(async () => {
    const now = await groups(panel);
    return now.groups.find((g) => g.id === now.tabs[0].groupId)?.title ?? null;
  }).toBe('OpenPosse');
});

test('a tab in a group of your own stays there', async ({ context, extensionId }) => {
  await addAcme(context, extensionId);
  const vendor = await context.newPage();
  await vendor.goto(VENDOR_URL);
  const panel = await openPanel(context, extensionId);
  const tabId = (await groups(panel)).tabs[0].id;
  const own = await panel.evaluate(async (id) => {
    const groupId = await chrome.tabs.group({ tabIds: [id] });
    await chrome.tabGroups.update(groupId, { title: 'Work' });
    return groupId;
  }, tabId);

  await askAndWait(panel, vendor, 'What is the pipeline total?', 0);

  const now = await groups(panel);
  expect(now.tabs[0].groupId).toBe(own);
  expect(now.groups.map((g) => g.title)).toEqual(['Work']);
});

test('a grouped tab is asked rather than the one in front', async ({ context, extensionId }) => {
  await addAcme(context, extensionId);
  const grouped = await context.newPage();
  await grouped.goto(VENDOR_URL);
  const panel = await openPanel(context, extensionId);
  await askAndWait(panel, grouped, 'What is the pipeline total?', 0);
  await expect.poll(async () => (await groups(panel)).tabs[0].groupId).not.toBe(-1);

  // A second, newer tab on the same site, in front of the grouped one.
  const loose = await context.newPage();
  await loose.goto(VENDOR_URL);
  await loose.bringToFront();
  await askAndWait(panel, grouped, 'And last quarter?', 1);

  await expect(loose.locator('[data-testid="question"]')).toHaveCount(0);
  await expect(grouped.locator('[data-testid="question"]')).toHaveCount(2);
});

test('a pinned tab is left ungrouped, and still answers', async ({ context, extensionId }) => {
  await addAcme(context, extensionId);
  const vendor = await context.newPage();
  await vendor.goto(VENDOR_URL);
  const panel = await openPanel(context, extensionId);
  const tabId = (await groups(panel)).tabs[0].id;
  await panel.evaluate((id) => chrome.tabs.update(id, { pinned: true }), tabId);

  await askAndWait(panel, vendor, 'What is the pipeline total?', 0);

  const now = await groups(panel);
  expect(now.tabs[0]).toMatchObject({ pinned: true, groupId: -1 });
  expect(now.groups).toEqual([]);
});

test('a renamed group is yours: its tab stays, and the next tab gets a fresh OpenPosse group', async ({ context, extensionId }) => {
  await addAcme(context, extensionId);
  const vendor = await context.newPage();
  await vendor.goto(VENDOR_URL);
  const panel = await openPanel(context, extensionId);
  await askAndWait(panel, vendor, 'What is the pipeline total?', 0);
  await expect.poll(async () => (await groups(panel)).groups.length).toBe(1);

  const { groups: [renamed] } = await groups(panel);
  await panel.evaluate((id) => chrome.tabGroups.update(id, { title: 'Mine' }), renamed.id);
  await askAndWait(panel, vendor, 'And last quarter?', 1);
  expect((await groups(panel)).tabs[0].groupId, 'left in the group that is theirs now').toBe(renamed.id);

  // Closed and opened again, the vendor's tab is new and joins a new OpenPosse group, not "Mine".
  await vendor.close();
  const again = await context.newPage();
  await again.goto(VENDOR_URL);
  await askAndWait(panel, again, 'And this quarter?', 0);
  await expect.poll(async () => {
    const now = await groups(panel);
    return now.groups.find((g) => g.id === now.tabs[0].groupId)?.title ?? null;
  }).toBe('OpenPosse');
});

test('a second window gets its own OpenPosse group', async ({ context, extensionId }) => {
  await addAcme(context, extensionId);
  const panel = await openPanel(context, extensionId);
  // A vendor tab in a window of its own, the only one on that site.
  // Opened blank and then navigated by Playwright, so its route serves the fake vendor: a window
  // that loads the address itself gets there before the route is in place, and shows an error page.
  const opened = context.waitForEvent('page');
  await panel.evaluate(() => chrome.windows.create({ url: 'about:blank' }));
  const vendor = await opened;
  await vendor.goto(VENDOR_URL);
  // And a tab already in a group in the first window, so there is one to wrongly reuse.
  const first = await context.newPage();
  await first.goto(`chrome-extension://${extensionId}/setup.html`);
  await panel.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: `chrome-extension://${chrome.runtime.id}/setup.html` });
    const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
    await chrome.tabGroups.update(groupId, { title: 'OpenPosse' });
  });

  await askAndWait(panel, vendor, 'What is the pipeline total?', 0);

  await expect.poll(async () => {
    const now = await groups(panel);
    const group = now.groups.find((g) => g.id === now.tabs[0].groupId);
    return group ? { title: group.title, sameWindow: group.windowId === now.tabs[0].windowId } : null;
  }).toEqual({ title: 'OpenPosse', sameWindow: true });
  expect((await groups(panel)).groups.filter((g) => g.title === 'OpenPosse')).toHaveLength(2);
});
