// The wizard's rules, checked without a window.
//
// Ported from `Tests/OpenPosseUITests/CoachingStateTests.swift` and
// `Tests/OpenPosseSharedTests/RecipeDraftTests.swift` on the parked Swift side. The cases come
// across with their reasoning, because each one is a thing that went wrong once.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newDraft, applyCapture, problems, isComplete, outstanding, finish,
} from '../src/draft.js';
import { derive, stepLabel, isCancellable, captures, keycaps, PATIENCE_MS } from '../src/coaching.js';

const sel = (css) => ({ css });

/** A draft with everything a complete recording produces, so tests can remove one thing. */
function complete() {
  let draft = newDraft('*.notion.so');
  draft = applyCapture(draft, {
    kind: 'open', openMethod: 'shortcut', shortcut: { key: 'o', metaKey: true },
  });
  draft = applyCapture(draft, { kind: 'input', selector: sel('div[contenteditable]') });
  draft = applyCapture(draft, { kind: 'submit', submitMethod: 'enterKey' });
  draft = applyCapture(draft, {
    kind: 'reply',
    reply: { selector: sel('.reply'), matchesBefore: 1, matchesAfter: 2 },
  });
  return draft;
}

// ── Accumulating ───────────────────────────────────────────────────────────────────────────

test('a correction overwrites rather than being refused', () => {
  // Somebody who presses the wrong shortcut will simply press the right one. Refusing the
  // second would force them to restart the wizard over a typo.
  let draft = newDraft('*.notion.so');
  draft = applyCapture(draft, { kind: 'input', selector: sel('.wrong') });
  draft = applyCapture(draft, { kind: 'input', selector: sel('.right') });
  assert.equal(draft.input.css, '.right');
});

test('switching how it opens does not leave the other way behind', () => {
  // The recipe must not claim both. A stale shortcut means the runtime sends a key combination
  // that does nothing, then reports the assistant never opened — which reads as a broken agent
  // rather than as a stale field.
  let draft = newDraft('*.notion.so');
  draft = applyCapture(draft, {
    kind: 'open', openMethod: 'shortcut', shortcut: { key: 'o', metaKey: true },
  });
  draft = applyCapture(draft, { kind: 'open', openMethod: 'click', selector: sel('.btn') });

  assert.equal(draft.openMethod, 'click');
  assert.equal(draft.shortcut, null, 'the shortcut must be cleared, not left stale');
  assert.equal(draft.openSelector.css, '.btn');
});

test('switching how it sends does not leave the other way behind', () => {
  let draft = newDraft('*.notion.so');
  draft = applyCapture(draft, { kind: 'submit', submitMethod: 'click', selector: sel('.send') });
  draft = applyCapture(draft, { kind: 'submit', submitMethod: 'enterKey' });

  assert.equal(draft.submitMethod, 'enterKey');
  assert.equal(draft.submitSelector, null);
});

test('the response ceiling comes from the vendor, not from the default', () => {
  // The one number M2 got wrong by guessing: 15 s against a vendor measured at 7–8 s, met by
  // the cold path with ~200 ms to spare and reported as TIMEOUT while it was still working.
  let draft = newDraft('*.notion.so');
  draft = applyCapture(draft, {
    kind: 'reply',
    reply: {
      selector: sel('.reply'), matchesBefore: 1, matchesAfter: 2,
      suggestedResponseTimeoutMs: 59_000,
    },
  });
  assert.equal(draft.responseTimeoutMs, 59_000);
});

test('an unknown event kind is kept, not silently dropped', () => {
  // A newer recorder against an older module is routine, not corrupt. Dropping it would make
  // the capture stream quietly one element shorter and the checklist stop advancing, which a
  // person reads as having failed to press something.
  let draft = newDraft('*.notion.so');
  draft = applyCapture(draft, { kind: 'something_new' });
  assert.deepEqual(draft.unrecognised, ['something_new']);
});

// ── Validating ─────────────────────────────────────────────────────────────────────────────

test('a complete draft has no problems and finishes', () => {
  const draft = complete();
  assert.deepEqual(problems(draft), []);
  assert.ok(isComplete(draft));
  assert.deepEqual(outstanding(draft), []);

  const result = finish(draft, { triggerMethod: 'synthetic' });
  assert.ok(result.ok);
  assert.equal(result.recipe.triggerMethod, 'synthetic');
});

test('a finished recipe carries plain CSS strings, not selector objects', () => {
  // The runtime passes these straight into `deepQuerySelectorAll`, while a draft holds
  // `selectorFor`'s full result because the checklist and the two-sample comparison need it.
  // Handing the object through would stringify to "[object Object]", match nothing, and report
  // ELEMENT_NOT_FOUND on a recipe that had just been recorded *and verified* — a failure that
  // would look like vendor drift rather than like a type.
  let draft = complete();
  draft = applyCapture(draft, { kind: 'open', openMethod: 'click', selector: sel('.btn') });
  draft = applyCapture(draft, { kind: 'submit', submitMethod: 'click', selector: sel('.send') });

  const { recipe } = finish(draft, { triggerMethod: 'synthetic' });
  for (const key of [
    'openSelector', 'inputSelector', 'submitSelector', 'responseContainerSelector',
  ]) {
    assert.equal(typeof recipe[key], 'string', `${key} must be a CSS string`);
  }
  assert.equal(recipe.responseContainerSelector, '.reply');
  assert.equal(recipe.inputSelector, 'div[contenteditable]');
});

test('an answer container that did not gain a match is the transcript, not a reply', () => {
  // `docs/recording-flow.md` step 5 said to record "the container that received new child
  // nodes". That container is one element and stays one element, while the runtime waits for
  // the match count to grow.
  let draft = complete();
  draft = applyCapture(draft, {
    kind: 'reply', reply: { selector: sel('.transcript'), matchesBefore: 1, matchesAfter: 1 },
  });
  assert.ok(problems(draft).some((p) => p.id === 'reply-not-per-reply'));
  assert.ok(!isComplete(draft));
});

test('one answer asks for another, and it does not read as a failure', () => {
  let draft = newDraft('*.notion.so');
  draft = applyCapture(draft, { kind: 'reply_pending', repliesSoFar: 1 });

  const problem = problems(draft).find((p) => p.id === 'needs-second-answer');
  assert.ok(problem);
  // From the user's side nothing went wrong — they asked and got an answer.
  assert.ok(!/sorry|error|failed|couldn/i.test(problem.message), problem.message);
});

test('a finished draft cannot be built from an incomplete one', () => {
  const result = finish(newDraft('*.notion.so'), { triggerMethod: 'synthetic' });
  assert.equal(result.ok, false);
  assert.ok(result.problems.length > 0);
});

test('problems are sentences a person can act on, never jargon', () => {
  // "AI for the rest of us" — whoever records an agent never sees the word "selector".
  for (const problem of problems(newDraft('*.notion.so'))) {
    assert.ok(!/selector|DOM|CSS|null|undefined/i.test(problem.message), problem.message);
    assert.ok(problem.message.length > 20, problem.message);
  }
});

// ── Coaching ───────────────────────────────────────────────────────────────────────────────

test('nothing captured yet means await, and it says which step we are on', () => {
  const state = derive(newDraft('*.notion.so'), { sinceArmedMs: 2000 });
  assert.equal(state.step, 'await-open');
  assert.equal(stepLabel(state), 'SETTING UP · 1 OF 2');
  assert.ok(isCancellable(state));
});

test('an assistant already open is told to close it, not asked to press anything', () => {
  // These controls are toggles. Asking for the shortcut now would shut the panel and record
  // the wrong thing — an M2 finding, and why this state exists at all.
  let draft = newDraft('*.notion.so');
  draft = applyCapture(draft, { kind: 'input', selector: sel('div[placeholder]') });
  const state = derive(draft, { alreadyOpen: true, sinceArmedMs: 2000 });
  assert.equal(state.step, 'already-open');
});

test('once it opens, the captured keys are shown back', () => {
  // Confirmation is load-bearing: somebody who cannot see that the shortcut registered will
  // press it again, and the second press shuts the panel.
  let draft = newDraft('*.notion.so');
  draft = applyCapture(draft, {
    kind: 'open', openMethod: 'shortcut', shortcut: { key: 'o', metaKey: true },
  });
  const state = derive(draft, { sinceArmedMs: 2000 });
  assert.equal(state.step, 'opened');
  assert.deepEqual(state.keys, ['⌘', 'O']);
  assert.equal(stepLabel(state), 'SETTING UP · 2 OF 2');
});

test('an assistant opened by clicking names the control instead of keys', () => {
  let draft = newDraft('*.notion.so');
  draft = applyCapture(draft, { kind: 'open', openMethod: 'click', selector: sel('.ai-button') });
  const state = derive(draft, { sinceArmedMs: 2000 });
  assert.deepEqual(state.keys, []);
  assert.equal(state.control, '.ai-button');
});

test('waiting too long offers a way out rather than sitting there', () => {
  const draft = newDraft('*.notion.so');
  assert.equal(derive(draft, { sinceArmedMs: PATIENCE_MS - 1000 }).step, 'await-open');
  assert.equal(derive(draft, { sinceArmedMs: PATIENCE_MS }).step, 'nothing-happened');
});

test('patience comfortably exceeds every arm-to-open time measured', () => {
  // Measured 2026-09-07 across five recordings: 5s, 5s, 6s, 13s, 14s — the slow ones opened by
  // clicking, because finding a button is a search and pressing keys you know is not. All five
  // were by someone who built the thing.
  assert.ok(PATIENCE_MS > 14_000 * 2,
    'a first-time user hunting an unfamiliar menu is the case this has to serve');
});

test('once it opens, waiting for the question is not hurried', () => {
  // `nothing-happened` is scoped to the *open* step. Someone composing a question deserves as
  // long as they like; the recording's own deadline covers wandering off.
  let draft = newDraft('*.notion.so');
  draft = applyCapture(draft, {
    kind: 'open', openMethod: 'shortcut', shortcut: { key: 'o', metaKey: true },
  });
  assert.notEqual(derive(draft, { sinceArmedMs: 600_000 }).step, 'nothing-happened');
});

test('two answers sharing nothing is told apart from needing a second', () => {
  // The remedy differs: a third question does not help when the page gives its answers no
  // shared handle, and the honest thing is to say so rather than keep asking.
  let draft = newDraft('*.notion.so');
  draft = applyCapture(draft, {
    kind: 'reply_pending', repliesSoFar: 2, noCommonSelector: true,
  });
  assert.equal(derive(draft, { sinceArmedMs: 2000 }).step, 'replies-share-nothing');
});

test('a complete draft lists every capture, in the order they were made', () => {
  const state = derive(complete(), { sinceArmedMs: 2000 });
  assert.equal(state.step, 'done');
  assert.equal(stepLabel(state), 'SETTING UP · DONE');
  assert.ok(!isCancellable(state), 'done is already leaving');

  assert.deepEqual(state.captures.map((c) => c.id), ['open', 'input', 'submit', 'reply', 'busy']);
  assert.equal(state.captures[0].isKeys, true);
  assert.equal(state.captures[0].detail, '⌘ O');
});

test('the busy indicator is listed whether or not it was found', () => {
  // The one optional capture, so its absence is the thing that needs saying. A row that only
  // appeared on success could not answer "did it get it?" — and it decides whether every later
  // turn waits ~900ms after an answer or ~4s, which is worth knowing at the moment of recording
  // rather than by reading a console afterwards.
  const without = captures(complete()).find((row) => row.id === 'busy');
  assert.ok(without, 'the row exists even when nothing was captured');
  assert.equal(without.absent, true);
  assert.match(without.detail, /timer/);

  let draft = complete();
  draft = applyCapture(draft, {
    kind: 'reply',
    reply: {
      selector: sel('.reply'),
      matchesBefore: 1,
      matchesAfter: 2,
      busySelector: 'div[data-testid="stop"]',
    },
  });

  const found = captures(draft).find((row) => row.id === 'busy');
  assert.equal(found.detail, 'div[data-testid="stop"]');
  assert.notEqual(found.absent, true);
});

test('navigating away abandons rather than silently mixing two pages', () => {
  let draft = complete();
  draft = applyCapture(draft, { kind: 'navigated_away' });
  assert.equal(derive(draft, { sinceArmedMs: 2000 }).step, 'abandoned');
  assert.ok(!isComplete(draft));
});

test('keycaps are ordered the way macOS writes them', () => {
  assert.deepEqual(
    keycaps({ key: 'k', ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }),
    ['⌃', '⌥', '⇧', '⌘', 'K'],
  );
  assert.deepEqual(keycaps(null), []);
  assert.deepEqual(keycaps({ key: 'Enter' }), ['Enter']);
});

test('the checklist skips what was not captured that way', () => {
  // An Enter-key submit has no button, and a click-opened assistant has no keys. Neither is a
  // missing row — they are different rows.
  let draft = newDraft('*.notion.so');
  draft = applyCapture(draft, { kind: 'open', openMethod: 'click', selector: sel('.btn') });
  draft = applyCapture(draft, { kind: 'submit', submitMethod: 'enterKey' });

  const rows = captures(draft);
  assert.equal(rows.find((r) => r.id === 'open').label, 'Opens from');
  assert.equal(rows.find((r) => r.id === 'submit').detail, '↩');
});
