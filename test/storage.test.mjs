// `clampSpeed` is the only pure thing in `storage.js`, and it is the one that has to hold.
//
// The pace is a single number read by two engines with different tolerances: HeadTTS **refuses**
// anything outside 0.25–4 and says so, while `SpeechSynthesisUtterance.rate` silently clamps to
// its own range. So an unguarded value does not fail the same way twice – it throws on Kokoro
// and quietly does something else on the system voices, which is the shape this project keeps
// banning. Clamping at the storage boundary is what makes one stored number mean one thing.
//
// No chrome stub is needed: nothing in `storage.js` touches the API at module scope.

import test from 'node:test';
import assert from 'node:assert/strict';
import { clampSpeed } from '../src/storage.js';

test('a sane pace survives untouched', () => {
  assert.equal(clampSpeed(1), 1);
  assert.equal(clampSpeed(1.15), 1.15);
  assert.equal(clampSpeed(0.7), 0.7);
});

test('a pace outside the engines\' range is clamped rather than passed on', () => {
  // The numbers are HeadTTS's own bounds. Passing 99 through would throw inside the engine,
  // three layers from anything that could explain it.
  assert.equal(clampSpeed(99), 4);
  assert.equal(clampSpeed(0), 0.25);
  assert.equal(clampSpeed(-3), 0.25);
});

test('garbage reads as the default, not as zero', () => {
  // **This is the case worth having.** `Number(undefined)` is NaN, and a NaN reaching either
  // engine is a voice that does not speak – where the honest answer to an unreadable setting
  // is "nobody has chosen one, so use the default pace".
  assert.equal(clampSpeed(undefined), 1.3);
  assert.equal(clampSpeed(null), 1.3);
  assert.equal(clampSpeed('abc'), 1.3);
  assert.equal(clampSpeed(NaN), 1.3);
  assert.equal(clampSpeed({}), 1.3);
});

test('a numeric string is accepted, because that is what a range input gives you', () => {
  // `el('speed').value` is always a string. Treating it as garbage would make the slider
  // set the default on every drag.
  assert.equal(clampSpeed('1.25'), 1.25);
});
