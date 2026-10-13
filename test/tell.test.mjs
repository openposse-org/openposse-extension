// The case this module exists for is the one a `.catch` cannot reach: a *synchronous* throw from
// `chrome.runtime.sendMessage` in a page whose extension has been reloaded out from under it.
//
// So the tests assert the shape of the failure rather than the value returned. If `tell` ever
// goes back to letting a throw escape, the first two cases stop passing – which is the whole
// point, because nothing else in this repo executes a content script.

import test from 'node:test';
import assert from 'node:assert/strict';
import { tell, _resetForTests } from '../src/tell.js';

/** Stands in for the extension APIs, with `id` present or absent as an orphaned page sees it. */
function stubChrome({ id, send }) {
  globalThis.chrome = { runtime: { id, sendMessage: send } };
}

test.beforeEach(() => _resetForTests());
test.after(() => { delete globalThis.chrome; });

test('a synchronous throw is contained, not propagated', () => {
  // Exactly what Chrome does to an orphaned content script. `.catch()` never sees this.
  stubChrome({
    id: 'abc',
    send: () => { throw new Error('Extension context invalidated.'); },
  });
  assert.doesNotThrow(() => tell({ kind: 'openposse.recording' }));
  assert.equal(tell({ kind: 'openposse.recording' }), false);
});

test('a missing runtime id is caught before the call is made', () => {
  let called = false;
  stubChrome({ id: undefined, send: () => { called = true; return Promise.resolve(); } });
  assert.equal(tell({ kind: 'openposse.listen.toggle' }), false);
  assert.equal(called, false, 'must not call into a runtime it has already seen is gone');
});

test('a rejection is ordinary and is not reported as orphaned', async () => {
  // MV3 stops the worker after ~30 s idle. Every caller already survives a lost message, so
  // this must stay distinct from "the extension is gone" – same handling, different cause.
  stubChrome({ id: 'abc', send: () => Promise.reject(new Error('no receiving end')) });
  assert.equal(tell({ kind: 'openposse.stream' }), true);
  await new Promise((resolve) => { setTimeout(resolve, 0); });   // let the rejection settle
});

test('the reason is said once, not on every capture', () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    stubChrome({ id: undefined, send: () => {} });
    for (let i = 0; i < 5; i += 1) tell({ kind: 'openposse.recording' });
  } finally {
    console.warn = realWarn;
  }
  assert.equal(warnings.length, 1, 'an orphaned page emits for as long as the tab is open');
  assert.match(warnings[0], /previous build/);
});

test('the happy path sends and says so', () => {
  const sent = [];
  stubChrome({ id: 'abc', send: (m) => { sent.push(m); return Promise.resolve(); } });
  assert.equal(tell({ kind: 'openposse.orb.reroute', agentName: 'Ivan' }), true);
  assert.deepEqual(sent, [{ kind: 'openposse.orb.reroute', agentName: 'Ivan' }]);
});
