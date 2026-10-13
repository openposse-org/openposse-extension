// The Settings preview crosses four contexts, and a typo anywhere in it is silent.
//
// Settings → worker (`openposse.voice.preview`) → offscreen document (`openposse.speak`) →
// back out as `openposse.spoke`. Nothing on that path validates a field name: an extra key in
// the message is ignored, and a missing one lands on a default. So renaming `wanted` on one
// side gives a preview that plays the wrong voice and reports success, which is the exact shape
// this project keeps banning.
//
// **The contract is read out of `offscreen.js` rather than copied here**, because a copy is one
// more thing to update and the failure it is guarding against is precisely somebody updating one
// of two places. The source is the parameter list of the function that receives the message.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = (file) => join(here, '..', 'src', file);

/** Every message the stub saw, newest last. */
const sent = [];

globalThis.chrome = {
  runtime: {
    getURL: (path) => path,
    sendMessage: async (message) => { sent.push(message); return { ok: true }; },
  },
  storage: {
    // The stored pace, which is the point: a preview reads it rather than taking one from the
    // slider, so what you hear is what an answer will use.
    local: { get: async (key) => (key === 'voiceSpeed' ? { voiceSpeed: 1.35 } : {}) },
    session: { get: async () => ({}), set: async () => {} },
  },
  offscreen: {
    hasDocument: async () => true,
    createDocument: async () => {},
    Reason: { USER_MEDIA: 'USER_MEDIA', AUDIO_PLAYBACK: 'AUDIO_PLAYBACK' },
  },
};

const { previewVoice } = await import('../src/listening.js');

/** The names `speak()` destructures out of the message, straight from its signature. */
function receivedFields() {
  const text = readFileSync(src('offscreen.js'), 'utf8');
  const signature = /async function speak\(\{([^}]*)\}/.exec(text);
  assert.ok(signature, 'offscreen.js no longer declares `async function speak({ … })` – '
    + 'this test reads the contract from that signature, so update it rather than deleting this');
  return signature[1]
    .split(',')
    .map((part) => part.split(/[=:]/)[0].trim())
    .filter(Boolean);
}

async function preview(...args) {
  sent.length = 0;
  const result = await previewVoice(...args);
  return { result, message: sent.find((m) => m.kind === 'openposse.speak') ?? null };
}

test('the preview carries every field the offscreen document reads', async () => {
  const { message } = await preview('It\'s time. Gather your posse.', 'bf_emma');
  assert.ok(message, 'no openposse.speak was sent');

  // **This is the assertion worth having.** Renaming a parameter on either side fails here
  // rather than three contexts away as a voice that quietly is not the one you picked.
  for (const field of receivedFields()) {
    assert.ok(field in message, `the offscreen document reads \`${field}\` and nothing sends it`);
  }
});

test('a named voice travels as the override, not as the agent', async () => {
  const { message } = await preview('hello', 'bf_emma');
  // `wanted` is what overrides the roster's assignment. Sending it as `voice` would land on
  // nothing – `speak()` has no such parameter – and the preview would play whatever the roster
  // happened to assign, which is a wrong answer that sounds like a working one.
  assert.equal(message.wanted, 'bf_emma');
});

test('no named voice means the roster decides, which is a real answer', async () => {
  const { message } = await preview('hello');
  // Null rather than absent, and not a fallback id: with nobody named, the question being asked
  // is "what will my assistant sound like", and only the roster can answer that.
  assert.equal(message.wanted, null);
});

test('it is marked a preview, which is what keeps it out of a turn', async () => {
  const { message } = await preview('hello');
  // The worker skips the panel and the floor on this flag. Without it a preview drives the orb
  // as though an agent were answering, while `trace` measures it against whatever turn last ran.
  assert.equal(message.preview, true);
});

test('the pace comes from storage, not from the caller', async () => {
  const { message } = await preview('hello');
  // 1.35 is what the stub has stored. A preview that took a number from the slider would speak
  // at a pace nothing else uses, which is the one thing a pace preview must not do.
  assert.equal(message.speed, 1.35);
});

test('an empty sample refuses instead of speaking nothing', async () => {
  const { result, message } = await preview('   ');
  assert.equal(result.ok, false);
  assert.ok(result.reason, 'a refusal with no reason is the shape this project bans');
  assert.equal(message, null, 'nothing should reach the offscreen document');
});
