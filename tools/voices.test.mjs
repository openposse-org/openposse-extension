// Voice resolution, without a speech engine.
//
// `SpeechSynthesisVoice` is read-only and shaped like its own literal, so this whole layer can
// be tested honestly against plain objects. Worth doing: the failures are silent by nature —
// an agent that gets the wrong voice still speaks, and a *remote* voice still speaks while
// posting what it was given to a server.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { localVoices, resolveVoice, assignVoices, leafName } from '../src/voices.js';

const voice = (name, lang, uri, localService = true) => ({ name, lang, voiceURI: uri, localService });

/** Roughly what Chrome on macOS reports, including the three that are not local. */
const MAC = [
  voice('Eddy (English (UK))', 'en-GB', 'com.apple.eloquence.en-GB.Eddy'),
  voice('Daniel', 'en-GB', 'com.apple.voice.compact.en-GB.Daniel'),
  voice('Samantha', 'en-US', 'com.apple.voice.compact.en-US.Samantha'),
  voice('Amélie', 'fr-CA', 'com.apple.voice.compact.fr-CA.Amelie'),
  voice('Google UK English Male', 'en-GB', 'Google UK English Male', false),
  voice('Google US English', 'en-US', 'Google US English', false),
];

test('remote voices are excluded, however plausible they look', () => {
  // The founding promise, and one of the three documented ways to break it. Google's voices sit
  // in the same array as Apple's and speak just as well — by sending the text to a server.
  const local = localVoices(MAC);
  assert.equal(local.length, 4);
  assert.ok(!local.some((v) => v.name.startsWith('Google')));
});

test('a voice that does not say whether it is local is treated as remote', () => {
  // `undefined` means the browser did not tell us. Treating unknown as local is the mistake
  // this exists to prevent: better no voice than one that posts what an agent said.
  const unknown = [{ name: 'Mystery', lang: 'en-GB', voiceURI: 'mystery' }];
  assert.deepEqual(localVoices(unknown), []);
});

test('an exact voice URI wins', () => {
  const got = resolveVoice('com.apple.voice.compact.en-US.Samantha', localVoices(MAC));
  assert.equal(got.name, 'Samantha');
});

test("a Mac identifier finds the same voice by its name", () => {
  // The case that makes a Mac-app import worth anything: the roster stores an Apple identifier
  // and the browser reports a human name, and they are the same voice.
  assert.equal(leafName('com.apple.eloquence.en-GB.Eddy'), 'eddy');
  const got = resolveVoice('com.apple.eloquence.en-GB.Eddy', localVoices(MAC));
  assert.equal(got.name, 'Eddy (English (UK))');
});

test('a voice that does not exist here falls back to the same language', () => {
  // Ivan's Eddy is an Apple Eloquence voice and exists on macOS alone. On Windows the roster
  // must still sound like a roster rather than like one default voice repeated.
  const windows = [
    voice('Microsoft George', 'en-GB', 'MSTTS_George'),
    voice('Microsoft Zira', 'en-US', 'MSTTS_Zira'),
    voice('Microsoft Hortense', 'fr-FR', 'MSTTS_Hortense'),
  ];
  const got = resolveVoice('com.apple.eloquence.en-GB.Eddy', windows);
  assert.equal(got.name, 'Microsoft George', 'should keep the region where it can');
});

test('region is preferred but not required', () => {
  const noGB = [voice('Samantha', 'en-US', 'sam'), voice('Amélie', 'fr-CA', 'amelie')];
  assert.equal(resolveVoice('com.apple.eloquence.en-GB.Eddy', noGB).name, 'Samantha');
});

test('nothing stored still gets a voice', () => {
  // An agent recorded in the extension has no Mac identifier at all.
  assert.ok(resolveVoice(null, localVoices(MAC)));
  assert.ok(resolveVoice(undefined, localVoices(MAC)));
});

test('no local voices at all resolves to nothing rather than to something remote', () => {
  assert.equal(resolveVoice('anything', []), null);
});

test('two agents never share a voice while the machine has spares', () => {
  // Agents are told apart by name and by voice. Two that sound identical have lost half of
  // that, and it is the half that works when nobody is looking at the screen.
  const agents = [
    { id: 'a', name: 'Ivan', voice: 'com.apple.eloquence.en-GB.Eddy' },
    { id: 'b', name: 'Andy', voice: 'com.apple.eloquence.en-GB.Eddy' },
    { id: 'c', name: 'Priya', voice: null },
  ];
  const assigned = assignVoices(agents, MAC);
  const uris = [...assigned.values()].map((v) => v.voiceURI);
  assert.equal(new Set(uris).size, 3, 'all three should differ');
  assert.equal(assigned.get('a').name, 'Eddy (English (UK))', 'the first keeps what it asked for');
});

test('more agents than voices collide rather than falling silent', () => {
  // Two agents sounding alike is worse than nothing — but only slightly, and an agent that
  // cannot speak at all is a feature that simply stopped working.
  const one = [voice('Only', 'en-GB', 'only')];
  const agents = [{ id: 'a', voice: null }, { id: 'b', voice: null }];
  const assigned = assignVoices(agents, one);
  assert.equal(assigned.size, 2);
  assert.equal(assigned.get('a').voiceURI, 'only');
  assert.equal(assigned.get('b').voiceURI, 'only');
});

test('an agent gets no voice when the machine has none', () => {
  assert.equal(assignVoices([{ id: 'a', voice: null }], []).size, 0);
});
