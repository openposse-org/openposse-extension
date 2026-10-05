// Which page an agent's site icon is looked up by. Chrome's favicon store is keyed by host and a
// recipe holds only a pattern, so a wrong pick here is an icon that never appears.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pickPage } from '../src/favicons.js';

test('an open tab gives the exact host, and a new one is remembered', () => {
  assert.deepEqual(pickPage('*.leanix.net', 'https://acme.leanix.net/landscape', undefined),
    { page: 'https://acme.leanix.net/landscape', origin: 'https://acme.leanix.net' });
});

test('a host already remembered is not written again', () => {
  assert.deepEqual(pickPage('*.notion.so', 'https://www.notion.so/q3', 'https://www.notion.so'),
    { page: 'https://www.notion.so/q3', origin: null });
});

test('with the tab closed, the remembered host stands in for it', () => {
  assert.deepEqual(pickPage('*.leanix.net', undefined, 'https://acme.leanix.net'),
    { page: 'https://acme.leanix.net/', origin: null });
});

test('a site never seen open falls back to its bare domain', () => {
  assert.deepEqual(pickPage('*.notion.so', undefined, undefined),
    { page: 'https://notion.so/', origin: null });
  assert.deepEqual(pickPage('localhost', undefined, undefined),
    { page: 'https://localhost/', origin: null });
});
