// Where somebody has got to in setting up, worked out from what is true now.
//
// The welcome page has no saved cursor: it can be closed half-way, and Settings can change any
// step later, so each open asks Chrome again and `progress` turns the answers into "these are
// done, show this one". These are the rules that decide what a returning person sees first.

import test from 'node:test';
import assert from 'node:assert/strict';
import { progress, unfinished, STEPS } from '../src/steps.js';

const NOTHING = { started: false, mic: 'ask', model: 'downloadable', pin: false, shortcut: '', assistant: null };
const ALL = { started: true, mic: 'granted', model: 'ready', pin: true, shortcut: '⌘⇧9', assistant: { name: 'Ivan' } };

test('a first open starts at the welcome card', () => {
  const { done, current } = progress(NOTHING);
  assert.equal(current, 'welcome');
  assert.equal(Object.values(done).some(Boolean), false);
});

test('"Get started" moves on to the microphone', () => {
  assert.equal(progress({ ...NOTHING, started: true }).current, 'mic');
});

test('coming back after the microphone resumes at the model, without the welcome card', () => {
  // Nothing was saved about having pressed "Get started": a granted microphone says so.
  const { done, current } = progress({ ...NOTHING, mic: 'granted' });
  assert.equal(done.welcome, true);
  assert.equal(current, 'model');
});

test('a blocked microphone is not done, and is where it stops', () => {
  assert.equal(progress({ ...NOTHING, started: true, mic: 'blocked' }).current, 'mic');
});

test('an unpinned icon holds things up until it is skipped', () => {
  const at = { ...NOTHING, started: true, mic: 'granted', model: 'ready' };
  assert.equal(progress(at).current, 'pin');
  assert.equal(progress({ ...at, skipped: ['pin'] }).current, 'shortcut');
  assert.equal(progress({ ...at, pin: true }).current, 'shortcut');
  // Skipping is not the same as doing it.
  assert.equal(progress({ ...at, skipped: ['pin'] }).done.pin, false);
});

test('only optional steps can be skipped', () => {
  const at = { ...NOTHING, started: true };
  assert.equal(progress({ ...at, skipped: ['mic', 'model'] }).current, 'mic');
});

test('a speech model this Chrome cannot have can be passed over, and only then', () => {
  const at = { ...NOTHING, started: true, mic: 'granted', skipped: ['model'] };
  assert.equal(progress({ ...at, model: 'unavailable' }).current, 'pin');
  assert.equal(progress({ ...at, model: 'unsupported' }).current, 'pin');
  assert.equal(progress({ ...at, model: 'downloadable' }).current, 'model');
});

test('an assigned shortcut ticks itself, so the next card is the first assistant', () => {
  const at = { ...NOTHING, started: true, mic: 'granted', model: 'ready', pin: true, shortcut: '⌘⇧9' };
  assert.equal(progress(at).current, 'assistant');
});

test('with every step done the page ends on the last card', () => {
  const { done, current } = progress(ALL);
  assert.equal(current, 'done');
  assert.deepEqual(STEPS.filter((s) => !done[s.id]).map((s) => s.id), []);
});

test('an assistant recorded elsewhere still counts', () => {
  // Somebody who lassoed from the panel before finishing here should not be sent back to card 7.
  const { done, current } = progress({ ...ALL, assistant: { name: 'Ivan' }, pin: false, skipped: ['pin'] });
  assert.equal(done.assistant, true);
  assert.equal(current, 'done');
});

test('"Finish setting up" is offered only for something that can be finished', () => {
  const ready = { mic: 'granted', model: 'ready', shortcut: '⌘⇧9' };
  assert.equal(unfinished(ready), false);
  assert.equal(unfinished({ ...ready, mic: 'ask' }), true);
  assert.equal(unfinished({ ...ready, mic: 'blocked' }), true);
  assert.equal(unfinished({ ...ready, model: 'downloadable' }), true);
  assert.equal(unfinished({ ...ready, shortcut: '' }), true);
  // A Chrome without on-device speech cannot be fixed by finishing anything.
  assert.equal(unfinished({ ...ready, model: 'unavailable' }), false);
  assert.equal(unfinished({ ...ready, model: 'unsupported' }), false);
});
