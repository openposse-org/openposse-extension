// The shared player: scheduling on the audio clock, finishing on both conditions, and the
// silence check. Two engines speak through it, so its rules are tested here rather than
// through either of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { play, peak, SILENT_PEAK } from '../src/player.js';

/** The contexts made, newest last, so a test can drive the one its player is using. */
const contexts = [];

/** Just enough of Web Audio for the player: a clock to set by hand, and sources to end by hand. */
class FakeAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.sources = [];
    this.destination = {};
    contexts.push(this);
  }

  createAnalyser() {
    return { fftSize: 0, connect() {}, getFloatTimeDomainData: (samples) => samples.fill(0) };
  }

  createBufferSource() {
    const source = {
      buffer: null,
      onended: null,
      connect() {},
      start: (at) => { source.at = at; },
      stop: () => { source.stopped = true; },
    };
    this.sources.push(source);
    return source;
  }

  suspend() { this.state = 'suspended'; return Promise.resolve(); }

  resume() { this.state = 'running'; return Promise.resolve(); }

  close() { this.state = 'closed'; return Promise.resolve(); }
}

globalThis.AudioContext = FakeAudioContext;

const buffer = (duration) => ({ duration });

/** Fails rather than hangs when something never settles. */
const within = (promise, ms = 1000) => Promise.race([
  promise,
  new Promise((_, reject) => { setTimeout(() => reject(new Error(`not settled in ${ms} ms`)), ms); }),
]);

/** Whether a promise has settled, without waiting for it to. */
async function settled(promise) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  return done;
}

test('peak reads every channel of every buffer', () => {
  const stereo = {
    numberOfChannels: 2,
    getChannelData: (channel) => Float32Array.from(channel ? [0.1, -0.7] : [0.2]),
  };
  const quiet = { numberOfChannels: 1, getChannelData: () => Float32Array.from([0.05]) };
  assert.equal(peak([quiet, stereo]), 0.7, 'the loud sample is in the second channel of the second buffer');
  assert.equal(peak([]), 0);

  // NaN reaches the encoder as zeros, which is what the silence check is for.
  const zeros = { numberOfChannels: 1, getChannelData: () => new Float32Array(4) };
  assert.ok(peak([zeros]) < SILENT_PEAK);
});

test('chunks are scheduled back to back on the audio clock', async () => {
  const player = play(() => {});
  const ctx = contexts.at(-1);

  player.push(buffer(1.5));
  player.push(buffer(2));
  assert.deepEqual(ctx.sources.map((s) => s.at), [0, 1.5], 'the second starts as the first ends');

  // Synthesis lost the race: the speakers drained at 3.5 and the clock is now at 10. The next
  // chunk starts now rather than in the past.
  ctx.currentTime = 10;
  player.push(buffer(1));
  assert.equal(ctx.sources[2].at, 10);

  player.stop();
});

test('finishing waits for nothing playing and nothing more to come', async () => {
  const ended = [];
  const levels = [];
  const player = play((level) => levels.push(level), { onEnd: (p) => ended.push(p) });
  const ctx = contexts.at(-1);

  player.push(buffer(1));
  ctx.sources[0].onended();
  assert.equal(ended.length, 0, 'the speakers drained between sentences, and more is coming');

  player.push(buffer(1));
  const done = player.finish();
  assert.equal(await settled(done), false, 'the last chunk has arrived but has not been heard');

  ctx.sources[1].onended();
  assert.deepEqual(await within(done), { ok: true });
  assert.deepEqual(ended, [player], 'the engine is told once');
  assert.equal(levels.at(-1), 0, 'the orb is left still');
  assert.equal(ctx.state, 'closed');
});

test('stopping silences what is queued and reports a cancel, once', async () => {
  const ended = [];
  const player = play(() => {}, { onEnd: (p) => ended.push(p) });
  const ctx = contexts.at(-1);

  player.push(buffer(1));
  player.push(buffer(1));
  const done = player.finish();
  player.stop();
  player.stop();

  assert.deepEqual(await within(done), { ok: false, reason: 'cancelled' });
  assert.ok(ctx.sources.every((s) => s.stopped), 'every source was stopped');
  assert.equal(ended.length, 1);

  // Late arrivals from a synthesis that had not noticed yet are dropped, not scheduled.
  player.push(buffer(1));
  assert.equal(ctx.sources.length, 2);
});

test('a player made while the voice is held starts held', async () => {
  // A pause can arrive during the model load, before there is a player to hold.
  const player = play(() => {}, { held: true });
  const ctx = contexts.at(-1);
  assert.equal(ctx.state, 'suspended');

  player.resume();
  assert.equal(ctx.state, 'running');
  player.pause();
  assert.equal(ctx.state, 'suspended');
  player.stop();
});
