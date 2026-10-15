// The words in the assistant's tab title during a turn. See `src/title.js`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { STATES, SEPARATOR, original, withState } from '../src/title.js';

test('each state is a prefix, in the words the website shows', () => {
  assert.equal(withState('Q3 plan', 'typing'), 'typing… · Q3 plan');
  assert.equal(withState('Q3 plan', 'answering'), 'answering… · Q3 plan');
  assert.equal(withState('Q3 plan', 'done'), 'done · Q3 plan');
  // The hero's `badge` map in openposse-website's site/index.html uses these three words.
  assert.deepEqual(Object.values(STATES), ['typing…', 'answering…', 'done']);
});

test('applying a state again replaces the prefix rather than stacking it', () => {
  const typing = withState('Q3 plan', 'typing');
  assert.equal(withState(typing, 'answering'), 'answering… · Q3 plan');
  assert.equal(withState(withState(typing, 'answering'), 'done'), 'done · Q3 plan');
  assert.equal(withState(withState('Q3 plan', 'done'), 'done'), 'done · Q3 plan');
});

test('original removes one prefix and leaves every other title alone', () => {
  assert.equal(original('answering… · Q3 plan'), 'Q3 plan');
  assert.equal(original('Q3 plan'), 'Q3 plan');
  assert.equal(original(''), '');
  assert.equal(original(undefined), '');
  // A title that already contains the separator, or a word, is not ours.
  assert.equal(original('Roadmap · Notion'), 'Roadmap · Notion');
  assert.equal(original('done'), 'done');
  assert.equal(original('Done · Q3 plan'), 'Done · Q3 plan');
  // Only one: a page that put our word in its own title keeps it.
  assert.equal(original('done · done · Q3 plan'), 'done · Q3 plan');
});

test('the empty title survives a state and its removal', () => {
  assert.equal(withState('', 'typing'), `typing…${SEPARATOR}`);
  assert.equal(original(withState('', 'typing')), '');
});

test('an unknown state is refused rather than written', () => {
  assert.throws(() => withState('Q3 plan', 'thinking'), /no tab-title state called thinking/);
});
