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
  assignSupertonicVoices, SUPERTONIC_VOICES, genderOf, agreedToSupertonic, supertonicSpeed,
  SUPERTONIC_LANGUAGES, supertonicLanguage,
} from '../src/tts.js';
import { SUPERTONIC_LICENCE } from '../src/weights.js';
import { engineOf, languageOf } from '../src/storage.js';
import { readFile } from 'node:fs/promises';

/** An agreement as `setSupertonicAgreement` stores it. */
const AGREED = {
  licence: SUPERTONIC_LICENCE.name, version: SUPERTONIC_LICENCE.version, at: '2026-10-15T09:00:00Z',
};

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
  const reasons = [
    'no-webgpu', 'no-assets', 'no-agreement', 'not-built', 'preference', 'kokoro', 'supertonic',
  ];
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

test('a voice somebody chose is kept, and the rest fill in around it', () => {
  // **The failure this prevents is silent and delayed.** The assignment hands out distinct
  // voices so no two agents sound alike, and left to itself it would reassign on every roster
  // change — so the agent you deliberately gave a voice to acquires a different one because
  // somebody else was recorded, days later, with nothing to connect cause to effect.
  const agents = [
    { id: 'first', voice: null },
    { id: 'chosen', voice: 'bm_george' },
    { id: 'third', voice: null },
  ];

  const got = assignKokoroVoices(agents);
  assert.equal(got.get('chosen'), 'bm_george');
  // Still all different: an explicit choice is taken out of the pool rather than ignored by it.
  assert.equal(new Set(got.values()).size, 3);
  assert.notEqual(got.get('first'), 'bm_george');
  assert.notEqual(got.get('third'), 'bm_george');
});

test('a chosen voice survives an agent being added before it', () => {
  // The same rule stated as the thing a user would actually notice.
  const before = assignKokoroVoices([{ id: 'a', voice: 'bf_emma' }]).get('a');
  const after = assignKokoroVoices([
    { id: 'new', voice: null }, { id: 'a', voice: 'bf_emma' },
  ]).get('a');
  assert.equal(before, 'bf_emma');
  assert.equal(after, 'bf_emma');
});

test('a voice that is not installed is not handed out', () => {
  // All 28 ship today, so this guards a rule rather than a current fact — and the rule is what
  // was broken when they were six: the heuristic must stay inside the list it was handed, never
  // reaching for its own default. Assigning a voice that is not on disk fails at the first
  // answer, three layers from anything that could explain it.
  const installed = [{ id: 'bm_george', lang: 'en-GB' }, { id: 'af_heart', lang: 'en-US' }];
  const agents = [{ id: '1' }, { id: '2' }, { id: '3', voice: 'bf_isabella' }];

  for (const chosen of assignKokoroVoices(agents, installed).values()) {
    assert.ok(installed.some((v) => v.id === chosen), `${chosen} is not installed`);
  }
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
  //
  // This is now derived from `weights.js` rather than written out here, so what it really
  // guards is that nothing was added to the *download manifest* from outside the published set.
  // That is the same question asked one layer closer to where the answer would be wrong.
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

// ── Supertonic ────────────────────────────────────────────────────────────────────────────

test('the engine table: Supertonic when installed, Kokoro kept for existing installs', () => {
  const gpu = { hasWebGPU: true, agreement: AGREED };
  const pick = (installed) => chooseEngine({ ...gpu, ...installed }).engine;

  assert.equal(pick({ hasSupertonicAssets: true }), 'supertonic');
  // An existing install, updated: nothing about what it speaks with changes.
  assert.equal(pick({ hasKokoroAssets: true }), 'kokoro');
  assert.equal(pick({ hasSupertonicAssets: true, hasKokoroAssets: true }), 'supertonic');
  assert.equal(pick({}), 'system');
});

test('Kokoro is preferred only when both are installed', () => {
  const both = { hasWebGPU: true, agreement: AGREED, hasSupertonicAssets: true, hasKokoroAssets: true };
  assert.equal(chooseEngine({ ...both, preference: 'kokoro' }).engine, 'kokoro');
  assert.equal(chooseEngine({ ...both, preference: 'supertonic' }).engine, 'supertonic');
  assert.equal(chooseEngine({ ...both, preference: 'system' }).engine, 'system');

  // A preference for something that is not there falls to what is, rather than to silence.
  assert.equal(chooseEngine({ ...both, hasKokoroAssets: false, preference: 'kokoro' }).engine, 'supertonic');
});

test('Supertonic is never chosen without a stored agreement to its licence', () => {
  // The licence binds its use restrictions to whoever uses the model, and the agreement is how
  // they are bound. Weights that got onto disk some other way are weights without one.
  const installed = { hasWebGPU: true, hasSupertonicAssets: true };
  for (const agreement of [
    null,
    undefined,
    {},
    { ...AGREED, version: '2021-01-01' },             // a different version of the licence
    { ...AGREED, licence: 'Apache-2.0' },              // a different licence altogether
  ]) {
    const choice = chooseEngine({ ...installed, agreement });
    assert.equal(choice.engine, 'system', JSON.stringify(agreement));
    assert.equal(choice.reason, 'no-agreement', 'and says so, rather than "nothing installed"');
    // With Kokoro beside it, Kokoro answers instead of the system voices.
    assert.equal(chooseEngine({ ...installed, hasKokoroAssets: true, agreement }).engine, 'kokoro');
  }
  assert.equal(agreedToSupertonic(AGREED), true);
  assert.match(describeEngine({ reason: 'no-agreement' }), /use restrictions/);
});

test('WebGPU gates Supertonic as it gates Kokoro', () => {
  // Its best WebAssembly run measured 0.73× real time: an answer arriving at three quarters of
  // the speed it is spoken is not a conversation.
  const choice = chooseEngine({ hasWebGPU: false, hasSupertonicAssets: true, agreement: AGREED });
  assert.equal(choice.engine, 'system');
  assert.equal(choice.reason, 'no-webgpu');
});

test('an engine preference from anywhere else reads as automatic', () => {
  for (const known of ['auto', 'supertonic', 'kokoro', 'system']) assert.equal(engineOf(known), known);
  for (const unknown of [undefined, null, '', 'Kokoro', 'piper', 7]) assert.equal(engineOf(unknown), 'auto');
});

test('a voice id says its gender, whichever engine it belongs to', () => {
  assert.equal(genderOf('af_heart'), 'female');
  assert.equal(genderOf('bm_george'), 'male');
  assert.equal(genderOf('F3'), 'female');
  assert.equal(genderOf('M5'), 'male');
  // A system voice's identifier says nothing about gender, and must not be guessed at.
  for (const silent of ['com.apple.eloquence.en-GB.Eddy', 'Fiona', 'F', 'M10', null, undefined]) {
    assert.equal(genderOf(silent), null, String(silent));
  }
  assert.equal(SUPERTONIC_VOICES.filter((v) => v.gender === 'female').length, 5);
  assert.equal(SUPERTONIC_VOICES.filter((v) => v.gender === 'male').length, 5);
});

test("an agent keeps its Kokoro voice's gender when Supertonic takes over", () => {
  // Whether the Kokoro voice was chosen or assigned: Kokoro is what most people heard first.
  const agents = [
    { id: 'chose-male', voice: 'am_michael' },
    { id: 'chose-female', voice: 'bf_emma' },
    { id: 'assigned', voice: null },
  ];
  const kokoro = assignKokoroVoices(agents);
  const supertonic = assignSupertonicVoices(agents);
  for (const { id } of agents) {
    assert.equal(genderOf(supertonic.get(id)), genderOf(kokoro.get(id)), id);
  }
  assert.equal(new Set(supertonic.values()).size, agents.length, 'and all different');
});

test('a Supertonic voice somebody chose is kept, and survives agents added before it', () => {
  const before = assignSupertonicVoices([{ id: 'a', voice: 'M4' }]).get('a');
  const after = assignSupertonicVoices([
    { id: 'new', voice: null }, { id: 'other', voice: 'am_adam' }, { id: 'a', voice: 'M4' },
  ]);
  assert.equal(before, 'M4');
  assert.equal(after.get('a'), 'M4');
  assert.ok([...after].every(([id, voice]) => id === 'a' || voice !== 'M4'), 'nobody else gets it');
});

test("an agent moved back to Kokoro keeps its Supertonic voice's gender", () => {
  const agents = [{ id: 'a', voice: 'F2' }, { id: 'b', voice: 'M1' }];
  const kokoro = assignKokoroVoices(agents);
  assert.equal(genderOf(kokoro.get('a')), 'female');
  assert.equal(genderOf(kokoro.get('b')), 'male');
});

test("Supertonic runs at 1.2/1.3 of the pace, keeping that ratio as the slider moves", () => {
  // Set by ear: at the default pace of 1.3 Kokoro sounded right at 1.3 and Supertonic at 1.2,
  // where 1 is Supertonic's own speed of 1.05.
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);
  close(supertonicSpeed(1.3), 1.05 * 1.2);
  close(supertonicSpeed(2.6) / supertonicSpeed(1.3), 2);
  close(supertonicSpeed(1), 1.05 * (1.2 / 1.3));
});

test("Supertonic's language list is the vendored helper's, less its `na`", async () => {
  // The helper imports ONNX Runtime, so the list is copied rather than imported. Read from the
  // helper's own source, so a copy that drifts fails here rather than as an unspoken answer.
  const source = await readFile(new URL('../src/supertonic/helper.js', import.meta.url), 'utf8');
  const line = /export const AVAILABLE_LANGS = \[([^\]]*)\]/.exec(source)?.[1];
  assert.ok(line, 'the helper still declares AVAILABLE_LANGS');
  const helper = [...line.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).filter((code) => code !== 'na');
  assert.deepEqual(SUPERTONIC_LANGUAGES, helper);
  assert.equal(SUPERTONIC_LANGUAGES.length, 31);
});

test('an answer language Supertonic does not have is read as English', () => {
  assert.equal(supertonicLanguage('de'), 'de');
  assert.equal(supertonicLanguage('ja'), 'ja');
  for (const other of ['na', 'xx', 'zh', '', null, undefined, 'DE']) {
    assert.equal(supertonicLanguage(other), 'en', String(other));
  }
  assert.equal(languageOf('fr'), 'fr');
  for (const odd of [undefined, null, '', 'French', 7, 'fr-FR']) assert.equal(languageOf(odd), 'en', String(odd));
});

test('ten Supertonic voices are all used before any repeats, and then they repeat', () => {
  const agents = Array.from({ length: 12 }, (_, i) => ({ id: `agent-${i}`, voice: null }));
  const got = assignSupertonicVoices(agents);
  assert.equal(got.size, 12, 'nobody is left without a voice');
  assert.equal(new Set(agents.slice(0, 10).map((a) => got.get(a.id))).size, 10);
  assert.ok(SUPERTONIC_VOICES.some((v) => v.id === got.get('agent-11')));
});
