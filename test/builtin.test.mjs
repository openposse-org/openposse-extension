// The lassos that come with OpenPosse: which site one is offered on, and that nothing is offered
// where an assistant already lives. The files themselves are checked by share.test.mjs, which
// unpacks every one in lassos/ as Settings would.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { covers, offerFor } from '../src/builtin.js';
import { unpack } from '../src/share.js';

const entry = (file, domainPattern) => ({ file, id: null, name: file, lasso: { domainPattern } });
const BUILT_INS = [
  entry('openposse-chatgpt.json', '*.chatgpt.com'),
  entry('openposse-gemini.json', 'gemini.google.com'),
];

test('a wildcard covers its domain and every subdomain, and nothing that only ends the same', () => {
  assert.equal(covers('*.chatgpt.com', 'chatgpt.com'), true);
  assert.equal(covers('*.chatgpt.com', 'www.chatgpt.com'), true);
  assert.equal(covers('*.notion.com', 'app.notion.com'), true);
  assert.equal(covers('*.chatgpt.com', 'notchatgpt.com'), false);
  assert.equal(covers('*.chatgpt.com', 'chatgpt.com.evil.example'), false);
});

test('an exact site covers that host alone', () => {
  // The umbrella domains keep their exact host, so Gemini's lasso is never offered on Gmail.
  assert.equal(covers('gemini.google.com', 'gemini.google.com'), true);
  assert.equal(covers('gemini.google.com', 'mail.google.com'), false);
  assert.equal(covers('gemini.google.com', 'x.gemini.google.com'), false);
});

test('the lasso for the site in front is offered', () => {
  assert.equal(offerFor(BUILT_INS, 'chatgpt.com', [])?.file, 'openposse-chatgpt.json');
  assert.equal(offerFor(BUILT_INS, 'gemini.google.com', [])?.file, 'openposse-gemini.json');
  assert.equal(offerFor(BUILT_INS, 'mail.google.com', []), null);
  assert.equal(offerFor(BUILT_INS, 'app.notion.com', []), null);
  assert.equal(offerFor([], 'chatgpt.com', []), null);
});

test('nothing is offered where an assistant already lives', () => {
  // One site, one assistant: the user's own recording of the site wins over the built-in.
  assert.equal(offerFor(BUILT_INS, 'chatgpt.com', ['*.chatgpt.com']), null);
  assert.equal(offerFor(BUILT_INS, 'chatgpt.com', ['chatgpt.com']), null);
  // An assistant elsewhere does not stop it.
  assert.equal(offerFor(BUILT_INS, 'chatgpt.com', ['*.notion.com', undefined])?.file, 'openposse-chatgpt.json');
});

test('every lasso in lassos/ is offered on the site it was recorded on', async () => {
  const dir = new URL('../lassos/', import.meta.url);
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json'));
  const entries = await Promise.all(files.map(async (file) => {
    const read = unpack(await readFile(new URL(file, dir), 'utf8'));
    assert.ok(read.ok, `${file} unpacks`);
    // The build's index admits plain lowercase names only; a file named otherwise would never ship.
    assert.match(file, /^[a-z0-9-]+\.json$/, `${file} has a name the index admits`);
    return { file, id: read.id, name: read.name, lasso: read.lasso };
  }));
  for (const { file, lasso } of entries) {
    const host = lasso.domainPattern.replace(/^\*\./, '');
    assert.equal(offerFor(entries, host, [])?.file, file, `${file} is offered on ${host}`);
  }
});
