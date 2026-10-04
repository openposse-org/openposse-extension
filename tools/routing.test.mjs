// Routing, without a microphone.
//
// Every one of these is an utterance somebody could plausibly say, and several are cases that
// would otherwise only surface by a real person being answered by the wrong agent. That is the
// argument for testing this layer: the failures are about strings, and strings do not need a
// browser, a vendor tab, or anyone saying "Ivan" forty times into a laptop.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  route, bestMatch, normalise, editDistance, navigationTarget, productName,
  floorWindow, FLOOR_MS, FLOOR_RANGE,
} from '../src/routing.js';

const ROSTER = [
  { id: '1', name: 'Ivan' },
  { id: '2', name: 'Andy' },
  { id: '3', name: 'Priya' },
];

test('a name and a question route to that agent', () => {
  const result = route('Ivan tell me a joke', ROSTER);
  assert.equal(result.agent.name, 'Ivan');
  assert.equal(result.prompt, 'tell me a joke');
  assert.equal(result.matched, 'name');
});

test("the recogniser's punctuation does not change the routing", () => {
  // "Ivan, tell me a joke" and "Ivan tell me a joke" are the same utterance. Whether a comma
  // appears is the recogniser's decision, not the speaker's.
  const withComma = route('Ivan, tell me a joke.', ROSTER);
  const without = route('Ivan tell me a joke', ROSTER);
  assert.equal(withComma.agent.name, without.agent.name);
  assert.equal(withComma.prompt, without.prompt);
});

test('a mis-heard name still reaches the right agent', () => {
  // The case the whole fuzzy layer exists for: "Ivan" is one letter from several English words
  // and a recogniser under pressure produces exactly this.
  assert.equal(route('Ivar tell me a joke', ROSTER).agent.name, 'Ivan');
  assert.equal(route('Ivan tell me a joke', ROSTER).matched, 'name');
  assert.equal(route('Ivar tell me a joke', ROSTER).matched, 'fuzzy');
});

test('filler before the name is skipped', () => {
  const result = route('hey Ivan what is the weather', ROSTER);
  assert.equal(result.agent.name, 'Ivan');
  assert.equal(result.prompt, 'what is the weather');
});

test('an agent named after a filler word still wins on its own name', () => {
  // The direct match is tried before any filler is skipped, so naming an agent "Hey" is
  // eccentric rather than broken.
  const roster = [...ROSTER, { id: '4', name: 'Hey' }];
  assert.equal(route('hey what is the weather', roster).agent.name, 'Hey');
});

test('a sentence that mentions an agent is not addressed to it', () => {
  // The reason the name must come first. Matching the end of the sentence would send this to
  // Andy with the prompt "tell me about", which is both the wrong agent and a mangled question.
  const result = route('tell me about Andy', ROSTER);
  assert.equal(result.agent, undefined);
  assert.equal(result.problem, 'unknown-agent');
});

test('a name-less follow-up goes to whoever holds the floor', () => {
  const result = route('and what about last quarter', ROSTER, { floorHolder: ROSTER[0] });
  assert.equal(result.agent.name, 'Ivan');
  assert.equal(result.prompt, 'and what about last quarter');
  assert.equal(result.matched, 'floor');
});

test('a name-less utterance with nobody holding the floor is a refusal', () => {
  assert.equal(route('what about last quarter', ROSTER).problem, 'unknown-agent');
});

test('an ordinary English word never fuzzy-matches a name', () => {
  // The bug this suite earned its keep on. "and" is one edit from "Andy", so the plan's own
  // example of a follow-up — "and what about last quarter" — routed to an agent nobody had
  // addressed, silently, while Ivan held the floor.
  assert.equal(bestMatch('and', ROSTER), null);
  assert.equal(bestMatch('any', ROSTER), null);        // one edit from Andy too
  assert.equal(route('and what about last quarter', ROSTER, { floorHolder: ROSTER[0] })
    .agent.name, 'Ivan');
});

test('an exact match on a common word still works', () => {
  // The guard refuses the approximate leap, not the word. Someone who names an agent "Will"
  // can still address it.
  const roster = [{ id: '1', name: 'Will' }];
  assert.equal(route('Will what is the weather', roster).agent.name, 'Will');
  assert.equal(bestMatch('well', roster), null);       // one edit away, and a word itself
});

test('a name on its own is an address, not an empty question', () => {
  // Someone starting to speak before deciding what to ask. Sending an empty prompt to a vendor
  // would be worse than saying "yes?".
  const result = route('Ivan', ROSTER);
  assert.equal(result.problem, 'name-only');
  assert.equal(result.agent.name, 'Ivan');
});

test('an ambiguous name is refused rather than guessed', () => {
  // "Dana" and "Lana" are each exactly one letter from "jana". There is no evidence to choose
  // between them, and choosing anyway puts a real question in front of the wrong person.
  //
  // Note this test was first written with Andy/Sandy, which is *not* ambiguous — "andi" is one
  // letter from "andy" and two from "sandy", so Andy wins fairly. The implementation was right
  // and the example was wrong, which is worth remembering when picking the next one: near-miss
  // pairs feel ambiguous long before they actually are.
  const roster = [{ id: '1', name: 'Dana' }, { id: '2', name: 'Lana' }];
  assert.equal(bestMatch('jana', roster), null);
  assert.equal(route('jana tell me a joke', roster).problem, 'unknown-agent');
});

test('short names tolerate nothing, because one letter is most of them', () => {
  const roster = [{ id: '1', name: 'Al' }];
  assert.equal(bestMatch('al', roster).agent.name, 'Al');
  assert.equal(bestMatch('el', roster), null);
});

test('a multi-word name beats a shorter agent sharing its first word', () => {
  const roster = [{ id: '1', name: 'Data' }, { id: '2', name: 'Data Team' }];
  const result = route('Data Team how many rows', roster);
  assert.equal(result.agent.name, 'Data Team');
  assert.equal(result.prompt, 'how many rows');
});

test('an empty roster is a distinct problem from an unrecognised name', () => {
  // These need different sentences: one is "record an assistant first", the other is "I did not
  // catch who you meant". A single generic error would send someone to the wrong place.
  assert.equal(route('Ivan tell me a joke', []).problem, 'no-agents');
  assert.equal(route('', ROSTER).problem, 'heard-nothing');
});

test('normalise and editDistance behave as the matcher assumes', () => {
  assert.equal(normalise("  Ivan, TELL me!  "), 'ivan tell me');
  assert.equal(normalise("O'Brien"), "o'brien");
  assert.equal(editDistance('ivan', 'ivan'), 0);
  assert.equal(editDistance('ivan', 'ivar'), 1);
  assert.equal(editDistance('', 'ivan'), 4);
});

// ── Navigation (E3b) ───────────────────────────────────────────────────────────────────────
//
// These matter more than they look. A false positive here does not misfire — it swallows the
// question and switches tabs instead, so the speaker watches their request vanish with nothing
// to explain it. Every one of these is a sentence somebody would actually say.

const NAV_ROSTER = [
  { id: '1', name: 'Ivan', product: 'notion' },
  { id: '2', name: 'Andy', product: 'leanix' },
];

test('"show me" with the floor held goes to that agent', () => {
  const result = navigationTarget('show me', NAV_ROSTER, { floorHolder: NAV_ROSTER[0] });
  assert.equal(result.agent.name, 'Ivan');
});

test('"show me" with nobody holding the floor asks what', () => {
  // Rather than guessing at whichever tab happens to be open, which is right once.
  assert.equal(navigationTarget('show me', NAV_ROSTER).problem, 'nothing-to-show');
});

test('a question that merely begins like navigation is still a question', () => {
  // The one that matters. "show me" opens both a navigation request and an ordinary question,
  // and treating this as navigation would discard the request entirely.
  assert.equal(navigationTarget('show me the Q3 numbers', NAV_ROSTER), null);
  assert.equal(navigationTarget('show me what changed last week', NAV_ROSTER), null);
  assert.equal(navigationTarget('open the door', NAV_ROSTER), null);
});

test('a vendor can be named by its product', () => {
  // Nobody says "take me to Ivan". They say Notion.
  for (const said of ['take me to Notion', 'open Notion', 'go to Notion', 'switch to Notion']) {
    assert.equal(navigationTarget(said, NAV_ROSTER)?.agent?.name, 'Ivan', said);
  }
});

test('a vendor can also be named by its agent', () => {
  // Unambiguous when someone does say it, so there is no reason to refuse.
  assert.equal(navigationTarget('take me to Ivan', NAV_ROSTER).agent.name, 'Ivan');
});

test('the longer opening wins over the one it contains', () => {
  // "take me back to" must not be eaten by "take me to" leaving "back to notion".
  assert.equal(navigationTarget('take me back to Notion', NAV_ROSTER).agent.name, 'Ivan');
});

test('naming something we do not know is a question, not a failed navigation', () => {
  // "take me to the summary" is a request to an assistant. Refusing it as bad navigation would
  // be worse than passing it on.
  assert.equal(navigationTarget('take me to the summary', NAV_ROSTER), null);
});

test('product names come from the domain, minus the generic subdomain', () => {
  assert.equal(productName('notion.so'), 'notion');
  assert.equal(productName('*.notion.so'), 'notion');
  assert.equal(productName('app.leanix.net'), 'leanix');
  assert.equal(productName('chat.openai.com'), 'openai');
  assert.equal(productName(''), '');
});

test('asking a question is never navigation', () => {
  // The ordinary case, stated so a future prefix cannot quietly capture it.
  assert.equal(navigationTarget('Ivan tell me a joke', NAV_ROSTER), null);
  assert.equal(navigationTarget('and what about last quarter', NAV_ROSTER), null);
});

test('the floor window takes a debug override only when it is a usable number', () => {
  assert.equal(floorWindow(undefined), FLOOR_MS, 'nothing stored is the shipped value');
  assert.equal(floorWindow(45_000), 45_000);
  assert.equal(floorWindow(FLOOR_RANGE.min), FLOOR_RANGE.min);
  assert.equal(floorWindow(FLOOR_RANGE.max), FLOOR_RANGE.max);
  // **Empty is not zero.** `Number(null)` and `Number('')` are 0, which is finite – without the
  // range check a cleared value would close the floor the instant it opened.
  assert.equal(floorWindow(null), FLOOR_MS);
  assert.equal(floorWindow(''), FLOOR_MS);
  assert.equal(floorWindow(0), FLOOR_MS);
  assert.equal(floorWindow('soon'), FLOOR_MS);
  assert.equal(floorWindow(FLOOR_RANGE.max + 1), FLOOR_MS);
});
