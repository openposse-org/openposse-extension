// The list Settings reads from openposse.org: which entries are offered, which are marked as
// already here, and that a file is only loaded when it is the lasso the list describes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CATALOG, fileURL, marked, mismatch, readCatalog } from '../src/catalog.js';
import { hashOf, pack, toFile } from '../src/share.js';

const lasso = {
  domainPattern: 'gemini.google.com', openMethod: 'alwaysOpen', inputSelector: 'div.ql-editor',
  submitMethod: 'click', submitSelector: 'button.send', responseContainerSelector: 'div.markdown',
};
const entry = (over = {}) => ({
  id: 'gemini', name: 'Emma', product: 'Gemini', site: 'gemini.google.com',
  file: 'openposse-gemini.json', recordedOn: '2026-10-28', hash: '0123456789ab', summary: '…', ...over,
});
const list = (...lassos) => JSON.stringify({ version: 1, generated: '2026-10-28', lassos });

test('the list is read from the bare domain, and each file beside it', () => {
  assert.equal(CATALOG, 'https://openposse.org/lassos/index.json');
  assert.equal(fileURL(entry()), 'https://openposse.org/lassos/openposse-gemini.json');
});

test('entries are offered with the fields Settings needs', () => {
  assert.deepEqual(readCatalog(list(entry())), [{
    id: 'gemini', name: 'Emma', product: 'Gemini', site: 'gemini.google.com',
    file: 'openposse-gemini.json', hash: '0123456789ab',
  }]);
});

test('Acme AI, the hooks demo, is never offered', () => {
  assert.deepEqual(readCatalog(list(entry({ id: 'acme-ai', name: 'Acme AI' }))), []);
});

test('an entry naming anything but a plain file beside the list is left out, not the rest', () => {
  const bad = ['../index.json', 'https://evil.example/x.json', 'sub/x.json', 'X.JSON', ''];
  const read = readCatalog(list(...bad.map((file) => entry({ file })), entry()));
  assert.deepEqual(read.map((e) => e.file), ['openposse-gemini.json']);
  assert.deepEqual(readCatalog(list(entry({ hash: 'nope' }), entry({ name: '' }))), []);
});

test('a list that is not a list says so', () => {
  assert.throws(() => readCatalog('<html>'), /could not be read/);
  assert.throws(() => readCatalog('{}'), /no lassos/);
});

test('a site that already has an assistant is marked, by the roster\'s own pattern', () => {
  const entries = readCatalog(list(entry(), entry({ id: 'chatgpt', site: 'chatgpt.com', file: 'openposse-chatgpt.json' })));
  const have = marked(entries, ['*.chatgpt.com', null]).map((e) => [e.id, e.have]);
  assert.deepEqual(have, [['gemini', false], ['chatgpt', true]]);
});

test('a file is loaded only when its lasso hashes to what the list says', async () => {
  const text = toFile(await pack({ name: 'Emma', lasso, id: 'gemini' }));
  assert.equal(await mismatch(entry({ hash: await hashOf(lasso) }), text), null);
  assert.match(await mismatch(entry(), text), /not the one its list describes/);
  assert.match(await mismatch(entry(), '{'), /doesn't look like/);
});

// The website's own list and files, when its repo is next to this one: every entry it offers
// must load. Skipped elsewhere, as the website's sync is.
test('the website\'s published lassos all load', async (t) => {
  const site = new URL('../../openposse-website/site/lassos/', import.meta.url);
  let index;
  try {
    index = await readFile(new URL('index.json', site), 'utf8');
  } catch (error) {
    t.skip(`no website repo beside this one (${error.code})`);
    return;
  }
  for (const found of readCatalog(index)) {
    assert.equal(await mismatch(found, await readFile(new URL(found.file, site), 'utf8')), null, found.file);
  }
});
