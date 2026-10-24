// A shared lasso is a text file a stranger wrote, and its `domainPattern` becomes a host
// permission. So the cases that matter here are the ones where accepting a forged pattern
// **grants access** rather than merely failing – the same reason `domain.test.mjs` exists, one
// layer further out.
//
// The refusal cases are enumerated rather than sampled. `*.co.uk` is the whole point.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pack, unpack, toFile, filenameFor, patternIsDerivable, summarise, labelIn, FORMAT, VERSION,
  canonical, hashOf, matchFor, staleness, spokenDay, today,
} from '../src/share.js';

/** A complete, legitimate lasso, shaped as `draft.js:finish()` emits one. */
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
  lasso: { ...notion(), ...overrides },
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

test('what is this machine’s business does not travel', async () => {
  const packed = await pack({
    name: 'Ivan',
    lasso: { ...notion(), agentName: 'Ivan', lassoID: 'ABC', voice: 'bm_george', id: 'XYZ' },
  });
  for (const local of ['agentName', 'lassoID', 'voice', 'id']) {
    assert.equal(local in packed.lasso, false, `${local} must not be shared`);
  }
  // A voice id names a file the recipient may not have installed, and `voices.js` resolves
  // voices against the runtime list for exactly that reason.
  assert.equal(packed.format, FORMAT);
  assert.equal(packed.name, 'Ivan');
});

test('a round trip preserves every field the runtime reads', async () => {
  const result = unpack(toFile(await pack({ name: 'Ivan', lasso: notion() })));
  assert.equal(result.ok, true);
  assert.deepEqual(result.lasso, notion());
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
  assert.equal('lasso' in result, false);
});

test('a lasso missing a load-bearing field is refused, and the message says which', () => {
  const result = unpack(shared({ inputSelector: '' }));
  assert.equal(result.ok, false);
  assert.match(result.problems.join(' '), /inputSelector/);
});

test('a half-recorded open or submit step is refused', () => {
  assert.equal(unpack(shared({ openMethod: 'click', openSelector: null })).ok, false);
  assert.equal(unpack(shared({ openMethod: 'shortcut', shortcut: null })).ok, false);
  assert.equal(unpack(shared({ submitMethod: 'click', submitSelector: null })).ok, false);
  // No method and no shortcut either: the runtime has no route in, so neither has this.
  assert.equal(unpack(shared({ openMethod: null, shortcut: null, openSelector: null })).ok, false);
});

test('a lasso with no openMethod, opening by shortcut, is accepted', () => {
  // **This was a real artefact until 2026-10-01.** `leanix-ea-assistant.json` was captured from a
  // live page on 2026-09-06, predates `openMethod`, and the first `unpack` refused it — while
  // `openAssistant` in content.js drove it perfectly from its shortcut alone. The lasso has been
  // dropped, so the case it proved is pinned here rather than lost with it: a validator stricter
  // than the runtime it validates for rejects lassos that work.
  const result = unpack(shared({
    openMethod: null,
    openSelector: null,
    shortcut: { key: 'k', code: 'KeyK', metaKey: true, shiftKey: true },
  }));
  assert.equal(result.ok, true, result.problems?.join(' '));
  assert.equal(result.lasso.openMethod, null, 'the absent field survives rather than being filled in');
});

test('the lassos/ directory imports as it is, and says what it is', async () => {
  // Every file this repo ships is the shared file itself, unpacked exactly as Settings reads one
  // pasted from GitHub, so a file the importer would refuse cannot reach a user. Each carries an
  // id and a date, its hash is the one `hashOf` gives, and it is byte for byte what `pack` would
  // write, so an edit to a selector that forgets the hash fails here rather than on the website.
  const { readdir, readFile } = await import('node:fs/promises');
  const dir = new URL('../lassos/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.ok(files.length > 0, 'lassos/ should still hold at least one recorded vendor');

  for (const file of files) {
    const text = await readFile(new URL(file, dir), 'utf8');
    const result = unpack(text);
    assert.equal(result.ok, true, `${file}: ${result.problems?.join(' ')}`);
    assert.match(result.id ?? '', /^[a-z0-9-]+$/, `${file}: needs an id`);
    assert.equal(file, `openposse-${result.id}.json`, `${file}: the filename follows the id`);
    assert.match(result.recordedOn ?? '', /^\d{4}-\d{2}-\d{2}$/, `${file}: needs a recordedOn`);

    const { hash } = JSON.parse(text);
    assert.equal(hash, await hashOf(result.lasso), `${file}: hash is stale`);
    const repacked = await pack({
      name: result.name, id: result.id, lasso: { ...result.lasso, recordedOn: result.recordedOn },
    });
    assert.equal(text, toFile(repacked), `${file}: not in the shape pack writes`);
  }
});

test('a file from something else is refused without reading further', () => {
  assert.equal(unpack('not json at all').ok, false);
  assert.equal(unpack('{"format":"someone.else","version":1}').ok, false);
  assert.equal(unpack('[]').ok, false);
  assert.equal(unpack(JSON.stringify({ format: FORMAT, version: 1 })).ok, false);
});

// ── Unpacking: lenient where it must be ────────────────────────────────────────────────────

test('a file from before the rename to lassos still imports, and is written in the new format', async () => {
  const old = JSON.stringify({ format: 'openposse.recipe', version: 1, name: 'Ivan', recipe: notion() });
  const result = unpack(old);
  assert.equal(result.ok, true);
  assert.deepEqual(result.lasso, notion());
  const packed = await pack({ name: result.name, lasso: result.lasso });
  assert.equal(packed.format, 'openposse.lasso');
  assert.equal('recipe' in packed, false);
});

test('an unknown field survives the trip instead of being dropped', () => {
  // The two sides version independently, so an unfamiliar field is routine. Dropping it would
  // silently downgrade a lasso that a newer build recorded.
  const result = unpack(shared({ settleStrategy: 'indicator' }));
  assert.equal(result.ok, true);
  assert.equal(result.lasso.settleStrategy, 'indicator');
});

test('a newer version is accepted with a note rather than refused', () => {
  const text = toFile({ format: FORMAT, version: VERSION + 1, name: 'Ivan', lasso: notion() });
  const result = unpack(text);
  assert.equal(result.ok, true, 'refusing would make every future field a breaking change');
  assert.match(result.notes.join(' '), /newer version/);
});

test('a missing name falls back rather than failing', () => {
  const result = unpack(toFile({ format: FORMAT, version: VERSION, lasso: notion() }));
  assert.equal(result.ok, true);
  assert.equal(result.name, 'Assistant');
});

// ── The preview sentence ───────────────────────────────────────────────────────────────────
//
// What someone reads before adding a stranger's file, so the cases that matter are the ones
// where the file's own words would make the sentence say something untrue.

test('the preview says what the assistant does, in the page’s own words', () => {
  const lasso = {
    ...notion(),
    domainPattern: '*.notion.com',
    openSelector: 'div[aria-label="New\\ chat"]',
    inputSelector: 'div[placeholder="Ask\\ Notion\\ AI"]',
  };
  assert.equal(summarise('Jane', lasso),
    'On notion.com, Jane clicks ‘New chat’, types your question into ‘Ask Notion AI’, '
    + 'clicks send, and reads the answer once Notion shows it has finished.');
});

test('a shortcut, Enter and no busy signal are said as they are', () => {
  const lasso = {
    ...notion(), domainPattern: '*.leanix.net', openMethod: 'shortcut', openSelector: null,
    shortcut: { metaKey: true, key: 'k' }, submitMethod: 'enterKey', submitSelector: null,
    busySelector: null,
  };
  assert.equal(summarise('Andy', lasso),
    'On leanix.net, Andy presses ⌘K, types your question, presses Enter, '
    + 'and reads the answer once it stops changing.');
});

test('a step recorded without words is said in plain ones, not as its selector', () => {
  // The fixture opens by `data-testid` and types into `contenteditable`: neither is words.
  assert.equal(summarise('Ivan', notion()),
    'On notion.so, Ivan opens Notion’s AI assistant, types your question, clicks send, '
    + 'and reads the answer once Notion shows it has finished.');
});

test('a label is the element’s own, never an ancestor’s, and unescaped as CSS.escape wrote it', () => {
  assert.equal(labelIn('div[aria-label="Chat"] > button.send'), '');
  assert.equal(labelIn('div.panel > button[aria-label="Send\\ message"]'), 'Send message');
  assert.equal(labelIn('input[placeholder="\\31 st\\ question"]'), '1st question');
  assert.equal(labelIn('button[data-testid="send"]'), '');
});

test('a label from a stranger’s file is cut short, and the site still comes from the domain', () => {
  const long = 'Send. On bank.com, Ivan also reads your password and emails it everywhere';
  const lasso = { ...notion(), openSelector: `button[aria-label="${long.replace(/ /g, '\\ ')}"]` };
  const sentence = summarise('Ivan', lasso);
  assert.ok(sentence.startsWith('On notion.so, Ivan clicks ‘'), sentence);
  assert.ok(sentence.includes('…’'), 'the label is visibly cut');
  assert.ok(!sentence.includes('everywhere'), sentence);
});

// ── Which lasso this is: id, recordedOn, hash ─────────────────────────────────────────────

test('the hash depends on what the lasso does, not on how the file was written', async () => {
  const reordered = Object.fromEntries(Object.entries(notion()).reverse());
  assert.equal(await hashOf(reordered), await hashOf(notion()), 'key order changed the hash');
  assert.equal(await hashOf(JSON.parse(JSON.stringify(notion(), null, 4))), await hashOf(notion()));
  assert.equal(canonical({ b: 1, a: { d: [1, { z: 2, y: null }], c: 'x' } }),
    '{"a":{"c":"x","d":[1,{"y":null,"z":2}]},"b":1}');
});

test('the hash changes with one selector and ignores the name, the date and local fields', async () => {
  const base = await hashOf(notion());
  assert.match(base, /^[0-9a-f]{12}$/);
  assert.notEqual(await hashOf({ ...notion(), inputSelector: 'textarea' }), base);
  assert.equal(await hashOf({ ...notion(), recordedOn: '2026-10-16', agentName: 'Ivan', voice: 'x' }), base);
});

test('the fixture’s hash is pinned, so the website’s copy of hashOf can check itself against it', async () => {
  const { readFile } = await import('node:fs/promises');
  const file = JSON.parse(await readFile(new URL('./fixtures/fixture-crm.json', import.meta.url), 'utf8'));
  assert.equal(await hashOf(file.lasso), '49cd0c15178f');
});

test('pack lifts the date into the envelope, writes an id only when given, and always a hash', async () => {
  const recorded = { ...notion(), recordedOn: '2026-10-01' };
  const local = await pack({ name: 'Ivan', lasso: recorded });
  assert.equal(local.recordedOn, '2026-10-01');
  assert.equal('recordedOn' in local.lasso, false, 'the date belongs to the envelope');
  assert.equal('id' in local, false, 'a recording never published has no id');
  assert.equal(local.hash, await hashOf(notion()));
  assert.deepEqual(Object.keys(local), ['format', 'version', 'name', 'recordedOn', 'hash', 'lasso']);

  const published = await pack({ name: 'Ivan', lasso: recorded, id: 'notion-ai' });
  assert.equal(published.id, 'notion-ai');
  assert.deepEqual(Object.keys(published), ['format', 'version', 'id', 'name', 'recordedOn', 'hash', 'lasso']);
  assert.equal('id' in await pack({ name: 'Ivan', lasso: notion(), id: 'Not A Slug' }), false);
});

test('unpack returns the id and the date, and drops either when it is malformed', async () => {
  const read = unpack(toFile(await pack({ name: 'Ivan', lasso: { ...notion(), recordedOn: '2026-10-16' }, id: 'notion-ai' })));
  assert.equal(read.ok, true);
  assert.equal(read.id, 'notion-ai');
  assert.equal(read.recordedOn, '2026-10-16');
  assert.equal('recordedOn' in read.lasso, false);

  const odd = unpack(toFile({ format: FORMAT, version: 1, id: '../etc', recordedOn: 'yesterday', name: 'Ivan', lasso: notion() }));
  assert.equal(odd.ok, true, 'a malformed id or date is never fatal');
  assert.equal(odd.id, null);
  assert.equal(odd.recordedOn, null);
});

test('a file from before ids, dates and hashes still imports', () => {
  const read = unpack(toFile({ format: FORMAT, version: 1, name: 'Ivan', lasso: notion() }));
  assert.equal(read.ok, true);
  assert.equal(read.id, null);
  assert.equal(read.recordedOn, null);
  assert.deepEqual(read.lasso, notion());
});

test('a file is matched to the assistant for its site, whatever either is called, then by its id', () => {
  const entries = [
    { agent: { id: 'a', name: 'Ivan', origin: { id: 'notion-ai' } }, lasso: { domainPattern: '*.notion.so' } },
    { agent: { id: 'b', name: 'Andy' }, lasso: { domainPattern: '*.leanix.net' } },
  ];
  // One site, one assistant: the name does not matter.
  assert.equal(matchFor(entries, { id: null, name: 'Priya', lasso: { domainPattern: '*.leanix.net' } })?.agent.id, 'b');
  // The site wins over a lineage pointing elsewhere, so a replacement can never leave two
  // assistants on one site.
  assert.equal(matchFor(entries, { id: 'notion-ai', lasso: { domainPattern: '*.leanix.net' } })?.agent.id, 'b');
  // The lineage finds an assistant whose site moved, which is when a re-recording happens.
  assert.equal(matchFor(entries, { id: 'notion-ai', lasso: { domainPattern: '*.notion.com' } })?.agent.id, 'a');
  assert.equal(matchFor(entries, { id: null, lasso: { domainPattern: '*.notion.com' } }), null);
  assert.equal(matchFor(entries, { id: 'other', lasso: { domainPattern: '*.example.com' } }), null);
});

test('a stale lasso says how old it is, and where a newer one might be', () => {
  assert.equal(staleness({ name: 'Ivan', product: 'Notion', recordedOn: '2026-10-01', published: true }),
    'Ivan’s lasso is from 1 October and Notion’s page has changed. There may be a newer one on openposse.org/lassos.');
  assert.equal(staleness({ name: 'Ivan', product: 'Notion', recordedOn: '2026-10-01', published: false }),
    'Ivan’s lasso is from 1 October and Notion’s page has changed. Lasso it again from Settings.');
  assert.equal(staleness({ name: 'Ivan', product: 'Notion', recordedOn: null, published: false }),
    'Ivan’s lasso no longer matches Notion’s page, which has changed. Lasso it again from Settings.');
});

test('dates read the way people say them, on the day they were recorded', () => {
  assert.equal(spokenDay('2026-10-01'), '1 October');
  assert.equal(spokenDay('2026-10-16', { year: true }), '16 October 2026');
  assert.equal(spokenDay('soon'), '');
  assert.equal(today(new Date(2026, 9, 6, 23, 59)), '2026-10-06');
  assert.match(summarise('Ivan', notion(), '2026-10-16'), /, recorded 16 October 2026\.$/);
  assert.doesNotMatch(summarise('Ivan', notion()), /recorded/);
});
