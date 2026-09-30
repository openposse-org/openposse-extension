// A shared recipe is a text file a stranger wrote, and its `domainPattern` becomes a host
// permission. So the cases that matter here are the ones where accepting a forged pattern
// **grants access** rather than merely failing – the same reason `domain.test.mjs` exists, one
// layer further out.
//
// The refusal cases are enumerated rather than sampled. `*.co.uk` is the whole point.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pack, unpack, toFile, filenameFor, patternIsDerivable, FORMAT, VERSION } from '../src/share.js';

/** A complete, legitimate recipe, shaped as `draft.js:finish()` emits one. */
const notion = () => ({
  domainPattern: '*.notion.so',
  openMethod: 'click',
  shortcut: null,
  openSelector: 'button[data-testid="ai-button"]',
  inputSelector: 'div[contenteditable="true"]',
  submitMethod: 'click',
  submitSelector: 'button[aria-label="Send"]',
  responseContainerSelector: 'div[data-message-role="assistant"]',
  busySelector: 'button[aria-label="Stop"]',
  triggerMethod: 'dom',
  quietPeriodMs: 900,
  responseTimeoutMs: 60_000,
});

const shared = (overrides = {}) => toFile({
  format: FORMAT, version: VERSION, name: 'Ivan',
  recipe: { ...notion(), ...overrides },
});

// ── The domain, which is the security boundary ─────────────────────────────────────────────

test('a pattern the recorder could have produced is accepted', () => {
  assert.equal(patternIsDerivable('*.notion.so'), true);
  assert.equal(patternIsDerivable('*.leanix.net'), true);
  assert.equal(patternIsDerivable('localhost'), true);
  assert.equal(patternIsDerivable('192.168.1.1'), true);
  // `domain.js` refuses to wildcard a public suffix and returns the bare host instead, so the
  // bare host round-trips. `https://co.uk/*` is one host, not a wildcard, so this is safe.
  assert.equal(patternIsDerivable('co.uk'), true);
});

test('a forged wildcard over a public suffix is refused', () => {
  // The failure this whole file is for. `*.co.uk` is every commercial site in the UK.
  for (const forged of ['*.co.uk', '*.com.au', '*.co.jp', '*.co.nz', '*.ac.uk', '*.com.br']) {
    assert.equal(patternIsDerivable(forged), false, `${forged} must not be derivable`);
  }
});

test('anything that is not a bare host is refused', () => {
  for (const bad of ['*', '*.*', '*.*.notion.so', 'https://*/*', '*.notion.so/evil',
    'notion.so/*', 'https://notion.so', 'notion.so:443', 'user@notion.so', 'notion so', '']) {
    assert.equal(patternIsDerivable(bad), false, `${bad} must not be derivable`);
  }
});

test('a bare registrable domain is refused, because the recorder would have wildcarded it', () => {
  // Not a security hole, but not a pattern this system produces either. Refusing keeps one
  // definition of what a pattern is rather than two.
  assert.equal(patternIsDerivable('notion.so'), false);
});

// ── Packing ────────────────────────────────────────────────────────────────────────────────

test('what is this machine’s business does not travel', () => {
  const packed = pack({
    name: 'Ivan',
    recipe: { ...notion(), agentName: 'Ivan', recipeID: 'ABC', voice: 'bm_george', id: 'XYZ' },
  });
  for (const local of ['agentName', 'recipeID', 'voice', 'id']) {
    assert.equal(local in packed.recipe, false, `${local} must not be shared`);
  }
  // A voice id names a file the recipient may not have installed, and `voices.js` resolves
  // voices against the runtime list for exactly that reason.
  assert.equal(packed.format, FORMAT);
  assert.equal(packed.name, 'Ivan');
});

test('a round trip preserves every field the runtime reads', () => {
  const result = unpack(toFile(pack({ name: 'Ivan', recipe: notion() })));
  assert.equal(result.ok, true);
  assert.deepEqual(result.recipe, notion());
  assert.equal(result.name, 'Ivan');
});

test('the filename is recognisable in a downloads folder', () => {
  assert.equal(filenameFor('Ivan'), 'openposse-ivan.json');
  assert.equal(filenameFor('Andy (LeanIX)'), 'openposse-andy-leanix.json');
  assert.equal(filenameFor(''), 'openposse-assistant.json');
});

// ── Unpacking: fatal problems ──────────────────────────────────────────────────────────────

test('a forged domain is refused by name, and nothing is returned to import', () => {
  const result = unpack(shared({ domainPattern: '*.co.uk' }));
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /\*\.co\.uk/, 'the refusal must name what it asked for');
  assert.equal('recipe' in result, false);
});

test('a recipe missing a load-bearing field is refused, and the message says which', () => {
  const result = unpack(shared({ inputSelector: '' }));
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /inputSelector/);
});

test('a half-recorded open or submit step is refused', () => {
  assert.equal(unpack(shared({ openMethod: 'click', openSelector: null })).ok, false);
  assert.equal(unpack(shared({ openMethod: 'shortcut', shortcut: null })).ok, false);
  assert.equal(unpack(shared({ submitMethod: 'click', submitSelector: null })).ok, false);
});

test('a file from something else is refused without reading further', () => {
  assert.equal(unpack('not json at all').ok, false);
  assert.equal(unpack('{"format":"someone.else","version":1}').ok, false);
  assert.equal(unpack('[]').ok, false);
  assert.equal(unpack(JSON.stringify({ format: FORMAT, version: 1 })).ok, false);
});

// ── Unpacking: lenient where it must be ────────────────────────────────────────────────────

test('an unknown field survives the trip instead of being dropped', () => {
  // The two sides version independently, so an unfamiliar field is routine. Dropping it would
  // silently downgrade a recipe that a newer build recorded.
  const result = unpack(shared({ settleStrategy: 'indicator' }));
  assert.equal(result.ok, true);
  assert.equal(result.recipe.settleStrategy, 'indicator');
});

test('a newer version is accepted with a note rather than refused', () => {
  const text = toFile({ format: FORMAT, version: VERSION + 1, name: 'Ivan', recipe: notion() });
  const result = unpack(text);
  assert.equal(result.ok, true, 'refusing would make every future field a breaking change');
  assert.match(result.notes.join(' '), /newer version/);
});

test('a missing name falls back rather than failing', () => {
  const result = unpack(toFile({ format: FORMAT, version: VERSION, recipe: notion() }));
  assert.equal(result.ok, true);
  assert.equal(result.name, 'Assistant');
});
