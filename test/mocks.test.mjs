// The mock roster writes into the real one, so the test that matters is that nothing real moves.
//
// `chrome.storage.local` is an in-memory stand-in, set before `storage.js` is imported – the same
// arrangement as `preview.test.mjs`.

import test from 'node:test';
import assert from 'node:assert/strict';

const store = {};
const pick = (keys) => {
  const list = keys == null ? Object.keys(store) : [keys].flat();
  return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
};
globalThis.chrome = {
  storage: {
    local: {
      get: async (keys) => pick(keys),
      set: async (items) => { Object.assign(store, structuredClone(items)); },
      remove: async (keys) => { for (const k of [keys].flat()) delete store[k]; },
    },
  },
};

const { setMockRoster, loadRoster } = await import('../src/storage.js');
const { MOCK_SIZES, mockRecordings } = await import('../src/mocks.js');
const { pack, unpack } = await import('../src/share.js');

const REAL = [
  { id: 'i', name: 'Ivan', voice: 'bm_george', lassoID: 'ri', connection: 'browser', channel: '#30D158' },
  { id: 'j', name: 'Jo', voice: null, lassoID: 'rj', connection: 'browser', channel: '#5E5CE6' },
  { id: 'a', name: 'Andy', voice: null, lassoID: 'ra', connection: 'browser', channel: '#64D2FF' },
];
const lassoKeys = () => Object.keys(store).filter((k) => k.startsWith('lasso:')).sort();

test('mocks fill the roster to each size and come out again, leaving the real agents as they were', async () => {
  store.agents = structuredClone(REAL);
  for (const { lassoID } of REAL) store[`lasso:${lassoID}`] = { domainPattern: '*.notion.so' };
  const realLassos = lassoKeys();

  for (const size of [...MOCK_SIZES, 10]) {
    assert.deepEqual(await setMockRoster(size), { ok: true, total: size, mocks: size - REAL.length });
    const { agents } = await loadRoster();
    assert.equal(agents.length, size);
    assert.deepEqual(agents.slice(0, REAL.length), REAL, 'a real agent changed');
    assert.ok(agents.slice(REAL.length).every((a) => a.mock === true));
    // Every agent has its lasso and no lasso is left without an agent – including the previous
    // size's mocks, which this size replaced.
    assert.deepEqual(lassoKeys(), agents.map((a) => `lasso:${a.lassoID}`).sort());
    assert.equal(new Set(agents.map((a) => a.name.toLowerCase())).size, size, 'two agents share a name');
  }

  assert.deepEqual(await setMockRoster(0), { ok: true, total: REAL.length, mocks: 0 });
  assert.deepEqual(store.agents, REAL);
  assert.deepEqual(lassoKeys(), realLassos);
  assert.equal((await setMockRoster(15)).ok, false, 'a size nobody offered is refused');
});

test('every made-up lasso is one Settings can show and share', async () => {
  const all = mockRecordings(0, Math.max(...MOCK_SIZES));
  assert.equal(all.length, Math.max(...MOCK_SIZES), 'not enough made-up recordings for the largest size');
  for (const { name, lasso } of all) {
    const read = unpack(JSON.stringify(await pack({ name, lasso })));
    assert.ok(read.ok, `${name}: ${read.problems?.join(' ')}`);
  }
  assert.equal(new Set(all.map((m) => m.lasso.domainPattern)).size, all.length, 'two mocks share a site');
});
