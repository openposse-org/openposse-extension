// What gets said out loud.
//
// The sentence splitter is the part worth testing hard. Every case below is a real string an
// assistant produces, and a naive `split('.')` mangles most of them — truncating an answer
// mid-number or mid-abbreviation, which does not read as a summary, it reads as a crash.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  needsShortening, firstSentence, spokenForm, SPEAK_WHOLE_BELOW,
} from '../src/saying.js';

const long = (n) => `${'This is a sentence about applications. '.repeat(n)}`.trim();

test('short answers are spoken whole', () => {
  const answer = 'Fourteen of your 131 applications are marked end of life.';
  assert.equal(needsShortening(answer), false);
  assert.deepEqual(spokenForm(answer), { text: answer, shortened: false });
});

test('one very long sentence still counts as long', () => {
  // The reason the threshold is characters and not sentences: a single 600-character sentence
  // is exactly as tiring to listen to as four short ones, and counting sentences lets it past.
  const answer = `The migration covers ${'many applications and services and teams '.repeat(15)}and nothing else`;
  assert.equal(answer.split('.').length, 1);
  assert.equal(needsShortening(answer), true);
});

test('a long answer is spoken as its first sentence, and says where the rest is', () => {
  // A truncation read aloud with no warning sounds like the assistant stopped mid-answer. That
  // sentence is the difference between a limitation and a bug.
  const answer = `Fourteen applications are end of life. ${long(15)}`;
  assert.ok(answer.length > SPEAK_WHOLE_BELOW);
  const { text, shortened } = spokenForm(answer);
  assert.equal(text, 'Fourteen applications are end of life. The rest is on screen.');
  assert.equal(shortened, true);
});

test('it does not promise more when there is barely more', () => {
  // A long answer that is almost entirely its first sentence does not need to be announced as
  // incomplete — saying "the rest is on screen" about eight remaining words is noise.
  const answer = `${'A single long opening sentence that runs on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on and on'}. Short tail.`;
  const { text } = spokenForm(answer);
  assert.ok(!text.includes('The rest is on screen'), text);
});

test('a decimal point does not end a sentence', () => {
  assert.equal(firstSentence('Revenue grew 3.5 percent last quarter. Then it fell.'),
    'Revenue grew 3.5 percent last quarter.');
});

test('a domain does not end a sentence', () => {
  assert.equal(firstSentence('The page is on notion.so somewhere. Look there.'),
    'The page is on notion.so somewhere.');
});

test('common abbreviations do not end a sentence', () => {
  assert.equal(firstSentence('Ask Dr. Smith about it. She knows.'), 'Ask Dr. Smith about it.');
  assert.equal(firstSentence('Use a linter, e.g. ESLint, on it. It helps.'),
    'Use a linter, e.g. ESLint, on it.');
});

test('initials do not end a sentence', () => {
  assert.equal(firstSentence('It was written by J. R. Hartley. He would know.'),
    'It was written by J. R. Hartley.');
});

test('question and exclamation marks end a sentence outright', () => {
  assert.equal(firstSentence('Why did the scarecrow win? Because he was outstanding.'),
    'Why did the scarecrow win?');
  assert.equal(firstSentence('What a result! Nobody expected it.'), 'What a result!');
});

test('a run of terminators stays together', () => {
  assert.equal(firstSentence('Really?! I had no idea.'), 'Really?!');
});

test('a single sentence with no terminator comes back whole', () => {
  assert.equal(firstSentence('All-in-one workspace'), 'All-in-one workspace');
  assert.equal(firstSentence('All-in-one workspace.'), 'All-in-one workspace.');
});

test('empty input is handled everywhere', () => {
  assert.equal(firstSentence(''), '');
  assert.equal(firstSentence(null), '');
  assert.deepEqual(spokenForm(''), { text: '', shortened: false });
  assert.deepEqual(spokenForm(null), { text: '', shortened: false });
});

test('newlines and runs of whitespace collapse', () => {
  // Vendors stream answers into the DOM as blocks, so innerText arrives full of newlines.
  assert.equal(firstSentence('Why did it win?\n\n   Because it was outstanding.'),
    'Why did it win?');
});
