// Where somebody has got to in setting up, worked out from what is true now.
//
// Onboarding has no saved cursor: it can be closed half-way, and Settings can change any step
// later, so each open asks Chrome again and `progress` turns the answers into "these are done,
// open this task". These are the rules that decide what a returning person sees first.

import test from 'node:test';
import assert from 'node:assert/strict';
import { progress, unfinished, taskProgress, taskOf, STEPS, TASKS } from '../src/steps.js';

const NOTHING = { started: false, mic: 'ask', model: 'downloadable', voice: 'missing', pin: false, shortcut: '', assistant: null };
const ALL = { started: true, mic: 'granted', model: 'ready', voice: 'ready', pin: true, shortcut: '⌥V', grouping: true, assistant: { name: 'Ivan' } };

test('a first open starts at the welcome screen, before any task', () => {
  const { done, current, task } = progress(NOTHING);
  assert.equal(current, 'welcome');
  assert.equal(task, null);
  assert.equal(Object.values(done).some(Boolean), false);
});

test('a speech model Chrome already had does not skip the welcome screen', () => {
  assert.equal(progress({ ...NOTHING, model: 'ready' }).current, 'welcome');
});

test('"Let\'s get you set up" opens Permissions, at the shortcut', () => {
  const { current, task } = progress({ ...NOTHING, started: true });
  assert.equal(current, 'shortcut');
  assert.equal(task, 'permissions');
});

test('the shortcut the manifest suggests is already done, so the microphone is next', () => {
  assert.equal(progress({ ...NOTHING, started: true, shortcut: '⌥V' }).current, 'mic');
});

test('coming back after the microphone resumes without the welcome screen', () => {
  // Nothing was saved about having pressed the button: a granted microphone says so.
  const { done, current } = progress({ ...NOTHING, mic: 'granted', shortcut: '⌥V' });
  assert.equal(done.welcome, true);
  assert.equal(current, 'pin');
});

test('a blocked microphone is not done, and is where it stops', () => {
  assert.equal(progress({ ...NOTHING, started: true, shortcut: '⌥V', mic: 'blocked' }).current, 'mic');
});

test('an unpinned icon holds up the next step until it is skipped', () => {
  const at = { ...NOTHING, started: true, mic: 'granted', model: 'ready', shortcut: '⌥V' };
  assert.equal(progress(at).current, 'pin');
  assert.equal(progress({ ...at, skipped: ['pin'] }).current, 'grouping');
  assert.equal(progress({ ...at, pin: true }).current, 'grouping');
  // Skipping is not the same as doing it.
  assert.equal(progress({ ...at, skipped: ['pin'] }).done.pin, false);
});

test('but never decides which task opens', () => {
  // Everything needed in Permissions is done, so a returning person goes straight to Downloads.
  const at = { ...NOTHING, mic: 'granted', shortcut: '⌥V', grouping: true };
  assert.equal(progress(at).current, 'pin');
  assert.equal(progress(at).task, 'downloads');
});

test('only optional steps can be skipped', () => {
  const at = { ...NOTHING, started: true, shortcut: '⌥V' };
  assert.equal(progress({ ...at, skipped: ['mic', 'model'] }).current, 'mic');
});

test('a speech model this Chrome cannot have can be passed over, and only then', () => {
  const at = { ...NOTHING, started: true, mic: 'granted', voice: 'ready', shortcut: '⌥V', grouping: true, skipped: ['pin', 'model'] };
  assert.equal(progress({ ...at, model: 'unavailable' }).current, 'assistant');
  assert.equal(progress({ ...at, model: 'unsupported' }).current, 'assistant');
  assert.equal(progress({ ...at, model: 'downloadable' }).current, 'model');
  // And it does not hold Downloads open on the next visit.
  assert.equal(progress({ ...at, skipped: [], model: 'unavailable' }).task, 'lasso');
});

test('either answer to the tab group ticks it, and then come the downloads', () => {
  // `grouping` is "answered": on, or a recorded no. Leaving grouping off is not a step undone.
  const at = { ...NOTHING, started: true, mic: 'granted', pin: true, shortcut: '⌥V' };
  assert.equal(progress(at).current, 'grouping');
  assert.equal(progress({ ...at, grouping: true }).current, 'model');
  assert.equal(progress({ ...at, grouping: true }).done.grouping, true);
  assert.equal(progress({ ...at, skipped: ['grouping'] }).current, 'grouping', 'it is answered, not skipped');
  assert.equal(progress({ ...at, grouping: true }).task, 'downloads');
});

test('Downloads wants a neural voice as well as the speech model', () => {
  // Supertonic or Kokoro, by the owner's call: the speech model alone does not finish it.
  const at = { ...NOTHING, started: true, mic: 'granted', pin: true, shortcut: '⌥V', grouping: true, model: 'ready' };
  assert.equal(progress(at).current, 'voice');
  assert.equal(progress(at).task, 'downloads');
  assert.deepEqual(taskProgress('downloads', progress(at).done), { done: 1, of: 2 });
  assert.equal(progress({ ...at, voice: 'ready' }).current, 'assistant');
  assert.equal(progress({ ...at, skipped: ['voice'] }).current, 'voice', 'not skippable while one could speak');
  // Without WebGPU neither could speak, so it is passed over and never holds Downloads open.
  assert.equal(progress({ ...at, voice: 'unsupported', skipped: ['voice'] }).current, 'assistant');
  assert.equal(progress({ ...at, voice: 'unsupported' }).task, 'lasso');
});

test('with every step done it ends on the first lasso', () => {
  const { done, current, task } = progress(ALL);
  assert.equal(current, 'done');
  assert.equal(task, 'lasso');
  assert.deepEqual(STEPS.filter((s) => !done[s.id]).map((s) => s.id), []);
});

test('an assistant recorded elsewhere still counts', () => {
  // Somebody who lassoed from the panel before finishing here should not be sent back to it.
  const { done, current } = progress({ ...ALL, assistant: { name: 'Ivan' }, pin: false, skipped: ['pin'] });
  assert.equal(done.assistant, true);
  assert.equal(current, 'done');
});

test('each task counts its own steps, in the order the tabs show them', () => {
  assert.deepEqual(TASKS.map((t) => t.id), ['permissions', 'downloads', 'lasso']);
  const { done } = progress({ ...NOTHING, started: true, shortcut: '⌥V' });
  assert.deepEqual(taskProgress('permissions', done), { done: 1, of: 4 });
  assert.deepEqual(taskProgress('downloads', done), { done: 0, of: 2 });
  assert.deepEqual(taskProgress('lasso', progress(ALL).done), { done: 1, of: 1 });
  // The shortcut is first in Permissions, by the owner's call.
  assert.equal(STEPS.find((s) => s.task === 'permissions').id, 'shortcut');
  assert.equal(taskOf('model'), 'downloads');
  assert.equal(taskOf('welcome'), null);
});

test('"Finish setting up" is offered only for something that can be finished', () => {
  const ready = { mic: 'granted', model: 'ready', shortcut: '⌥V' };
  assert.equal(unfinished(ready), false);
  assert.equal(unfinished({ ...ready, mic: 'ask' }), true);
  assert.equal(unfinished({ ...ready, mic: 'blocked' }), true);
  assert.equal(unfinished({ ...ready, model: 'downloadable' }), true);
  assert.equal(unfinished({ ...ready, shortcut: '' }), true);
  // A Chrome without on-device speech cannot be fixed by finishing anything.
  assert.equal(unfinished({ ...ready, model: 'unavailable' }), false);
  assert.equal(unfinished({ ...ready, model: 'unsupported' }), false);
});
