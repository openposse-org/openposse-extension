// Engine selection.
//
// None of this fails loudly. Choosing wrong gives you a product that sounds worse than it
// should on a capable machine, or one that stutters unusably on a machine that cannot keep up
// — and both are invisible on whatever laptop happens to be doing the development, which is
// precisely why they are tested rather than tried.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseEngine, describeEngine, assignKokoroVoices, KOKORO_VOICES, REASONS,
} from '../src/tts.js';

test('Kokoro needs WebGPU, the files, and an engine to read them', () => {
  const both = { hasWebGPU: true, hasKokoroAssets: true };
  assert.equal(chooseEngine({ ...both, implemented: true }).engine, 'kokoro');
  assert.equal(chooseEngine({ hasWebGPU: true, hasKokoroAssets: false, implemented: true }).engine, 'system');
  assert.equal(chooseEngine({ hasWebGPU: false, hasKokoroAssets: true, implemented: true }).engine, 'system');
});

test('downloaded weights with no engine to read them does not claim Kokoro', () => {
  // The lie this prevents. The weights became downloadable before the engine existed, so a
  // machine with WebGPU passed both gates and would have been told "Kokoro — neural voices,
  // running on this machine" — then failed to speak, reporting that the model was not
  // installed, which was untrue twice over.
  const choice = chooseEngine({ hasWebGPU: true, hasKokoroAssets: true, implemented: false });
  assert.equal(choice.engine, 'system');
  assert.equal(choice.reason, 'not-built');
  assert.match(describeEngine(choice), /downloaded, but the engine/);
});

test('the nearest obstacle is the one named', () => {
  // Someone without WebGPU should be told that, not told we have not finished building
  // something they could not have run anyway.
  assert.equal(
    chooseEngine({ hasWebGPU: false, hasKokoroAssets: true, implemented: false }).reason,
    'no-webgpu',
  );
});

test('WebGPU is a hard gate rather than a preference', () => {
  // Kokoro is ~3x real time on WebGPU and ~10x slower than that on the WASM fallback. That is
  // not degraded, it is unusable — and it would land hardest on the machines least able to
  // afford it. Falling back to system voices is the status quo, not a failure.
  const choice = chooseEngine({ hasWebGPU: false, hasKokoroAssets: true });
  assert.equal(choice.reason, 'no-webgpu');
  assert.match(describeEngine(choice), /too slow/);
});

test('each reason sends someone somewhere different', () => {
  // "Your machine cannot do this", "it can but the files are missing" and "you chose this" need
  // different actions. One generic "using system voices" would be true and useless.
  const reasons = ['no-webgpu', 'no-assets', 'not-built', 'preference', 'kokoro'];
  const said = reasons.map((r) => describeEngine({ reason: r }));
  assert.equal(new Set(said).size, reasons.length, 'every reason reads differently');
  for (const s of said) assert.ok(s.length > 10, s);
});

test('an explicit preference for system voices wins over everything', () => {
  const choice = chooseEngine({ hasWebGPU: true, hasKokoroAssets: true, preference: 'system' });
  assert.equal(choice.engine, 'system');
  assert.equal(choice.reason, 'preference');
});

test('nothing known means system voices', () => {
  // The default for a machine we have not measured yet. Being wrong this way costs quality;
  // being wrong the other way costs the feature working at all.
  assert.equal(chooseEngine().engine, 'system');
  assert.equal(chooseEngine({}).engine, 'system');
});

test('Kokoro voices are distinct per agent', () => {
  const agents = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const got = assignKokoroVoices(agents);
  assert.equal(new Set(got.values()).size, 3);
});

test('a British agent keeps a British voice across the engine change', () => {
  // Most of what makes an agent feel like the same agent is the accent. Ivan arrives from the
  // Mac app with an en-GB Eloquence identifier and should not become American.
  const agents = [{ id: 'ivan', voice: 'com.apple.eloquence.en-GB.Eddy' }];
  const chosen = assignKokoroVoices(agents).get('ivan');
  assert.equal(KOKORO_VOICES.find((v) => v.id === chosen).lang, 'en-GB');
});

test('an agent with no stored voice gets an American one', () => {
  const chosen = assignKokoroVoices([{ id: 'x', voice: null }]).get('x');
  assert.equal(KOKORO_VOICES.find((v) => v.id === chosen).lang, 'en-US');
});

test('more agents than voices collide rather than falling silent', () => {
  const two = [{ id: 'a', lang: 'en-US' }, { id: 'b', lang: 'en-GB' }];
  const agents = [{ id: '1' }, { id: '2' }, { id: '3' }];
  const got = assignKokoroVoices(agents, two);
  assert.equal(got.size, 3);
});

test('the voice list is the published Apache-2.0 set', () => {
  // 28 voices, which is what the plan's licence work was done against. A list that has quietly
  // grown means somebody added voices from somewhere else, and where they came from is the
  // whole question.
  assert.equal(KOKORO_VOICES.length, 28);
  assert.ok(KOKORO_VOICES.every((v) => /^[ab][fm]_[a-z]+$/.test(v.id)), 'naming is <accent><gender>_<name>');
  assert.ok(KOKORO_VOICES.some((v) => v.lang === 'en-GB'));
  assert.ok(KOKORO_VOICES.some((v) => v.lang === 'en-US'));
});

test('every reason has copy', () => {
  for (const key of Object.keys(REASONS)) {
    assert.ok(REASONS[key] && REASONS[key].length > 5, key);
  }
});
