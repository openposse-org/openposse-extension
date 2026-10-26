// Routing, without a microphone.
//
// Every one of these is an utterance somebody could plausibly say, and several are cases that
// would otherwise only surface by a real person being answered by the wrong agent. That is the
// argument for testing this layer: the failures are about strings, and strings do not need a
// browser, a vendor tab, or anyone saying "Ivan" forty times into a laptop.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  route, bestMatch, normalise, editDistance, soundKey, navigationTarget, replyToOffer, productName,
  productLabel, floorWindow, withoutAddress, FLOOR_MS, FLOOR_RANGE,
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

test('a name spelt the way it sounds reaches the right agent', () => {
  // Each of these is outside spelling tolerance – two letters off a four- or five-letter name,
  // or one off a three-letter one – and is exactly what a recogniser writes for a name it does
  // not know.
  const andie = route('Andie what is on my calendar', ROSTER);
  assert.equal(andie.agent.name, 'Andy');
  assert.equal(andie.prompt, 'what is on my calendar');
  assert.equal(andie.matched, 'fuzzy');
  assert.equal(route('Preeya summarise the doc', ROSTER).agent.name, 'Priya');
  assert.equal(bestMatch('macks', [{ id: '1', name: 'Max' }]).agent.name, 'Max');
});

test('an ordinary English word never matches a name by sound either', () => {
  // "even" sounds exactly like "Ivan". The common-word guard is what stops "even so, the
  // numbers look off" reaching Ivan, and it has to cover sound as well as spelling.
  assert.equal(soundKey('even'), soundKey('Ivan'));
  assert.equal(bestMatch('even', ROSTER), null);
  assert.equal(route('even so the numbers look off', ROSTER).problem, 'unknown-agent');
});

test('matching by sound never runs words together', () => {
  // "I've an" run together sounds like "Ivan", and is how a great many sentences begin.
  assert.equal(route("I've an idea for the roadmap", ROSTER).problem, 'unknown-agent');
  assert.equal(route('eye van tell me a joke', ROSTER).problem, 'unknown-agent');
});

test('a sound key too short to mean anything is not trusted', () => {
  // "Kai" is K and "key" is K; "Ava" and "Ivy" are both AF. Too many words share those.
  assert.equal(bestMatch('key', [{ id: '1', name: 'Kai' }]), null);
  assert.equal(bestMatch('ivy', [{ id: '1', name: 'Ava' }]), null);
});

test('sound keys agree where the ear does and give up outside English spelling', () => {
  assert.equal(soundKey('Andy'), 'ANT');
  assert.equal(soundKey('Andie'), soundKey('Andy'));
  assert.equal(soundKey('Evan'), soundKey('Ivan'));
  assert.equal(soundKey('Priya'), soundKey('Preeya'));
  assert.equal(soundKey('José'), soundKey('Jose'));
  assert.equal(soundKey('Иван'), null);
  assert.notEqual(soundKey('Dana'), soundKey('Lana'));
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

test('product labels are capitalised for reading, with the brands that need it spelt out', () => {
  // `productName` above stays lowercase – it is what spoken navigation is matched against.
  assert.equal(productLabel('*.notion.so'), 'Notion');
  assert.equal(productLabel('*.atlassian.net'), 'Atlassian');
  // Inner capitals are not in a domain, so they come from the table rather than a guess.
  assert.equal(productLabel('app.leanix.net'), 'LeanIX');
  assert.equal(productLabel('chat.openai.com'), 'OpenAI');
  assert.equal(productLabel('*.chatgpt.com'), 'ChatGPT');
  // An exact host under an umbrella domain reads as its own product (see `UMBRELLA_DOMAINS`).
  assert.equal(productLabel('gemini.google.com'), 'Gemini');
  // A real company whose name is an `Object.prototype` key. On a plain-object table this label
  // would be a function, printed into the status line as "function Object() { [native code] }".
  assert.equal(productLabel('constructor.io'), 'Constructor');
  assert.equal(productLabel(''), '');
});

test('asking a question is never navigation', () => {
  // The ordinary case, stated so a future prefix cannot quietly capture it.
  assert.equal(navigationTarget('Ivan tell me a joke', NAV_ROSTER), null);
  assert.equal(navigationTarget('and what about last quarter', NAV_ROSTER), null);
});

// ── The reply to "would you like to see it?" ──────────────────────────────────────────────

const offered = (said) => replyToOffer(said, NAV_ROSTER, { floorHolder: NAV_ROSTER[0] });

test('a yes on its own goes to whoever offered', () => {
  for (const said of ['Yes.', 'yeah', 'Yep!', 'sure', 'OK', 'okay', 'Yes please.', 'please',
    'Yeah, sure.', 'Go ahead.', 'yes thanks']) {
    assert.equal(offered(said)?.accept?.agent?.name, 'Ivan', said);
  }
});

test('a yes followed by navigation goes where the navigation says', () => {
  assert.equal(offered('Yes, show me.')?.accept?.agent?.name, 'Ivan');
  assert.equal(offered('yes take me there')?.accept?.agent?.name, 'Ivan');
  assert.equal(offered('Sure, take me to Notion.')?.accept?.agent?.name, 'Ivan');
  // Naming the other vendor is a choice, and it wins over the one that offered.
  assert.equal(offered('yes, take me to LeanIX')?.accept?.agent?.name, 'Andy');
});

test('no, in its common forms, declines', () => {
  for (const said of ['No.', 'nope', 'No thanks.', 'no thank you', 'Not now.', "I'm good.",
    "That's fine, thanks.", 'never mind']) {
    assert.deepEqual(offered(said), { decline: true }, said);
  }
});

test('anything else is left for the ordinary path', () => {
  // These need nothing here: navigation already handles them, and a follow-up question is a
  // perfectly good reply to an offer.
  assert.equal(offered('show me'), null);
  assert.equal(offered('take me to Ivan'), null);
  assert.equal(offered('and what about last quarter'), null);
  // The exhaustion rule again: a yes that carries a question is the question.
  assert.equal(offered('yes and what about last quarter'), null);
  assert.equal(offered('yesterday'), null);
  assert.equal(offered(''), null);
});

test('a yes with nobody holding the floor asks what', () => {
  assert.equal(replyToOffer('yes', NAV_ROSTER).accept.problem, 'nothing-to-show');
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

// ── Typed questions ───────────────────────────────────────────────────────────────────────

const MATT = { id: '5', name: 'Matt' };

test("a typed question loses the agent's name and keeps the rest as typed", () => {
  // The turn that found this: the vendor was asked the whole sentence, name and all.
  assert.equal(withoutAddress('Matt, what is on this to-do list?', MATT),
    'what is on this to-do list?');
  assert.equal(withoutAddress('matt what is on this to-do list?', MATT),
    'what is on this to-do list?');
  assert.equal(withoutAddress('Matt: what is due?', MATT), 'what is due?');
  assert.equal(withoutAddress('Matt – what is due?', MATT), 'what is due?');
  assert.equal(withoutAddress('Hey Matt, what is due?', MATT), 'what is due?');
});

test('a typed question that does not start with the name is left alone', () => {
  assert.equal(withoutAddress('What did Matt say?', MATT), 'What did Matt say?');
  assert.equal(withoutAddress('Mattress prices this year?', MATT), 'Mattress prices this year?');
  // A typo is not a name. Nothing mishears a keyboard, so nothing is guessed.
  assert.equal(withoutAddress('Mat, what is due?', MATT), 'Mat, what is due?');
});

test('a typed name with nothing after it is not turned into an empty question', () => {
  assert.equal(withoutAddress('Matt', MATT), 'Matt');
  assert.equal(withoutAddress('Matt?', MATT), 'Matt?');
});

test("a typed question addressed to another agent is sent as typed", () => {
  // The box says where it sends. Taking Ivan's name off a question going to Matt would hide that
  // the person meant someone else.
  const roster = [MATT, ...ROSTER];
  assert.equal(withoutAddress('Ivan, tell me a joke', MATT, roster), 'Ivan, tell me a joke');
});

test("a longer agent's name is not cut down to the target's", () => {
  const data = { id: '6', name: 'Data' };
  const roster = [data, { id: '7', name: 'Data Team' }];
  assert.equal(withoutAddress('Data Team, who is on call?', data, roster), 'Data Team, who is on call?');
  assert.equal(withoutAddress('Data, who is on call?', data, roster), 'who is on call?');
  assert.equal(withoutAddress('Data Team, who is on call?', roster[1], roster), 'who is on call?');
});

test('a question that opens with a quotation keeps its quotation mark', () => {
  assert.equal(withoutAddress('Matt, "done" means what here?', MATT), '"done" means what here?');
});
