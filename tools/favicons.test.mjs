// Which page an agent's site icon is looked up by. Chrome's favicon store is keyed by host while a
// recipe holds only a pattern, and Chrome answers a site it has no icon for with a grey globe – so
// a wrong pick here is either an icon that never appears or a globe where a letter should be.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pickPage } from '../src/favicons.js';

const tab = (url, favIconUrl = 'https://example.test/favicon.ico') => ({ url, favIconUrl });

test('an open tab showing an icon gives the exact host, and a new one is remembered', () => {
  assert.deepEqual(pickPage(tab('https://acme.leanix.net/landscape'), undefined),
    { page: 'https://acme.leanix.net/landscape', origin: 'https://acme.leanix.net' });
});

test('a host already remembered is not written again', () => {
  assert.deepEqual(pickPage(tab('https://www.notion.so/q3'), 'https://www.notion.so'),
    { page: 'https://www.notion.so/q3', origin: null });
});

test('with the tab closed, the remembered host stands in for it', () => {
  assert.deepEqual(pickPage(undefined, 'https://acme.leanix.net'),
    { page: 'https://acme.leanix.net/', origin: null });
});

test('a site never seen in a tab with an icon is not asked about, so it keeps its initial', () => {
  assert.equal(pickPage(undefined, undefined), null);
  assert.equal(pickPage(tab('https://www.notion.so/', ''), undefined), null);
});
