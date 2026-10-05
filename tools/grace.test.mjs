// The answer grace crosses three contexts, and the middle hop drops anything it does not name.
//
// Panel → `chrome.storage.session` → worker (`ask()`, and the recorder's `askOnce`) → content
// script (`askAssistant`). The worker does not forward a question's payload: `dispatchIntent`
// rebuilds the message field by field. So a field added in `ask()` and nowhere else reaches the
// page as `undefined`, `graceWindow` turns that into the default, and the slider silently does
// nothing – the shape `preview.test.mjs` exists for, one hop further along.
//
// **The contract is read out of `askAssistant`'s own signature rather than copied here**, for the
// reason that file gives: the failure being guarded against is somebody updating one of two
// places, and a copy here would be a third.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { graceWindow, ANSWER_GRACE_MS, GRACE_RANGE } from '../src/grace.js';

const here = dirname(fileURLToPath(import.meta.url));
const source = (file) => readFileSync(join(here, '..', 'src', file), 'utf8');

/** The names in an object literal or a destructuring pattern: `a, b: c, d = 1` gives a, b, d. */
const keys = (body) => body.split(',').map((part) => part.split(/[=:]/)[0].trim()).filter(Boolean);

/** What `askAssistant` destructures out of the message it is handed. */
function readByThePage() {
  const signature = /async function askAssistant\(\{([^}]*)\}/.exec(source('content.js'));
  assert.ok(signature, 'content.js no longer declares `async function askAssistant({ … })` – '
    + 'this test reads the contract from that signature, so update it rather than deleting this');
  return keys(signature[1]);
}

test('every question the worker builds carries what the page reads', () => {
  const fields = readByThePage();
  // Without this the loop below could run over nothing and pass, which is a green tick for a
  // regex that stopped matching rather than for the seam.
  assert.ok(fields.includes('graceMs'), `askAssistant reads ${fields.join(', ')} – no graceMs`);

  const worker = source('service-worker.js');
  // `ask()` and the recorder's dry run each write the question out in full.
  const questions = [...worker.matchAll(/\{ intent: 'ask_assistant',([^}]*)\}/g)].map((m) => keys(m[1]));
  assert.ok(questions.length >= 2, `expected ask() and askOnce() to build questions, found ${questions.length}`);
  // **The hop that drops things**, because it rebuilds the message rather than forwarding it.
  const rebuilt = /const message = \{([^}]*)\}/.exec(worker);
  assert.ok(rebuilt, 'dispatchIntent no longer builds `const message = { … }` – update this test');

  for (const field of fields) {
    for (const question of questions) {
      assert.ok(question.includes(field), `a question is built without \`${field}\`: ${question.join(', ')}`);
    }
    assert.ok(keys(rebuilt[1]).includes(field), `dispatchIntent drops \`${field}\` on its way to the page`);
  }
});

test('the grace takes an override only when it is a usable number', () => {
  assert.equal(graceWindow(undefined), ANSWER_GRACE_MS, 'nothing sent is the shipped value');
  assert.equal(graceWindow(1_500), 1_500);
  assert.equal(graceWindow(GRACE_RANGE.min), GRACE_RANGE.min);
  assert.equal(graceWindow(GRACE_RANGE.max), GRACE_RANGE.max);
  // **Empty is not zero.** `Number(null)` is 0, and a zero grace would end every turn on whatever
  // row it read first – which is how a status line gets spoken as the answer.
  assert.equal(graceWindow(null), ANSWER_GRACE_MS);
  assert.equal(graceWindow(''), ANSWER_GRACE_MS);
  assert.equal(graceWindow(0), ANSWER_GRACE_MS);
  assert.equal(graceWindow('long'), ANSWER_GRACE_MS);
  assert.equal(graceWindow(GRACE_RANGE.max + 1), ANSWER_GRACE_MS);
});
