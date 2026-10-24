// A roster saved before lassos were called lassos has to come through the rename whole: same
// agents, same content, nothing left under the old keys and nothing reported broken.
//
// `chrome.storage.local` is an in-memory stand-in, set before `storage.js` is imported – the same
// arrangement as `mocks.test.mjs`.

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

const { loadRoster, lassoFor } = await import('../src/storage.js');

test('a roster from before the rename moves to the lasso keys and stays whole', async () => {
  store.agents = [
    { id: 'i', name: 'Ivan', voice: 'bm_george', recipeID: 'ri', connection: 'browser', channel: '#30D158' },
    { id: 'j', name: 'Jo', voice: null, recipeID: 'rj', connection: 'browser', channel: '#5E5CE6' },
  ];
  store['recipe:ri'] = { domainPattern: '*.notion.so', agentName: 'Ivan' };
  // Jo's content is missing, as it can be; that stays a broken agent rather than a lost one.

  const { agents, broken, problem } = await loadRoster();
  assert.equal(problem, null);
  assert.deepEqual(agents.map((a) => [a.id, a.lassoID, 'recipeID' in a]), [['i', 'ri', false], ['j', 'rj', false]]);
  assert.deepEqual(broken, ['j']);
  assert.deepEqual(await lassoFor(agents[0]), { domainPattern: '*.notion.so', agentName: 'Ivan' });
  assert.deepEqual(Object.keys(store).filter((k) => k.startsWith('recipe:')), []);
  assert.equal(store.agents.some((a) => 'recipeID' in a), false);

  // A second read finds nothing to move and changes nothing.
  const before = structuredClone(store);
  await loadRoster();
  assert.deepEqual(store, before);
});
