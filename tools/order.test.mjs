// The roster's drawing order, kept apart from the stored list because voices are handed out by
// position in that list – see src/order.js. The test that matters most is the first one: drawing
// in a new order must never reorder what the voice assignment reads.

import test from 'node:test';
import assert from 'node:assert/strict';
import { inOrder, sortedIDs } from '../src/order.js';

const agent = (id, name = id) => ({ id, name });
const ids = (agents) => agents.map((a) => a.id);

test('drawing in an arranged order leaves the stored list alone', () => {
  const stored = [agent('a'), agent('b'), agent('c')];
  assert.deepEqual(ids(inOrder(stored, ['c', 'a', 'b'])), ['c', 'a', 'b']);
  assert.deepEqual(ids(stored), ['a', 'b', 'c']);
});

test('no saved order draws the roster as it was added', () => {
  const stored = [agent('a'), agent('b')];
  assert.deepEqual(ids(inOrder(stored, undefined)), ['a', 'b']);
  assert.deepEqual(ids(inOrder(stored, 'garbage')), ['a', 'b']);
});

test('an assistant added since the last arrangement goes last, in the order added', () => {
  const stored = [agent('a'), agent('b'), agent('new1'), agent('c'), agent('new2')];
  assert.deepEqual(ids(inOrder(stored, ['c', 'b', 'a'])), ['c', 'b', 'a', 'new1', 'new2']);
});

test('the id of a deleted assistant is skipped', () => {
  assert.deepEqual(ids(inOrder([agent('a'), agent('b')], ['gone', 'b', 'a'])), ['b', 'a']);
});

test('Name reads like a person would: case aside, numbers by value', () => {
  const stored = [agent('1', 'notion 10'), agent('2', 'Ivan'), agent('3', 'Notion 2'), agent('4', 'andy')];
  assert.deepEqual(sortedIDs(stored, 'name'), ['4', '2', '3', '1']);
});

test('Site groups assistants on the same product, then by name, and one without a site goes last', () => {
  const stored = [agent('1', 'Zed'), agent('2', 'Broken'), agent('3', 'Andy'), agent('4', 'Ivan')];
  const sites = { 1: 'Notion', 2: '', 3: 'LeanIX', 4: 'Notion' };
  assert.deepEqual(sortedIDs(stored, 'site', (a) => sites[a.id]), ['3', '4', '1', '2']);
});

test('Newest and Oldest go by the order assistants were added, not by name', () => {
  const stored = [agent('1', 'Zed'), agent('2', 'Andy'), agent('3', 'Mia')];
  assert.deepEqual(sortedIDs(stored, 'newest'), ['3', '2', '1']);
  assert.deepEqual(sortedIDs(stored, 'oldest'), ['1', '2', '3']);
});

test('an unknown sort is refused by name rather than leaving the list as it was', () => {
  assert.throws(() => sortedIDs([agent('a')], 'colour'), /"colour" is not one of the sorts/);
});
