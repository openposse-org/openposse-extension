// The only test here that *runs* a bundle, and the only one that could have caught the backtick.
//
// Everything else under `tools/` tests a pure module. That left the two files which actually get
// injected into a page – `content.js` and `orb.js` – covered by nothing: a comment written with
// real backticks inside orb.js's CSS template became ``MARK_CSS.keys`…` ``, a *valid*
// tagged-template call, so esbuild built it, ESLint passed it and 118 tests stayed green while
// the orb threw on load and neither ⌥V nor the recorder had anywhere to draw.
//
// This bundles from source rather than reading `dist/`, so it cannot pass against a stale build,
// and it evaluates the result. It does not assert behaviour – there is no DOM here worth the
// name. It asserts the file survives being loaded, which is the thing that was untested.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

/**
 * Stands in for a browser object, chaining to itself so any depth of property access works:
 * `document.createElement('div').attachShadow({}).appendChild(…)` and the like.
 *
 * **`then` is the one member that cannot chain to another thenable.** A promise resolved with a
 * thenable is unwrapped recursively, so a stub whose `then` hands back another stub never
 * terminates. It resolves with a plain (non-thenable) stub instead, which ends the chain.
 */
const stub = (thenable = true) => new Proxy(function stubbed() {}, {
  get: (target, key) => {
    if (typeof key === 'symbol') return undefined;      // let coercion fall through to the target
    if (key !== 'then') return stub(thenable);
    if (!thenable) return undefined;
    return (onFulfilled) => {
      try { onFulfilled?.(stub(false)); } catch { /* the caller's own failure, not ours */ }
      return stub(true);
    };
  },
  apply: () => stub(thenable),
  construct: () => stub(thenable),
});

/**
 * Evaluates `code` with **only** the named globals present.
 *
 * The enumeration is the load-bearing part, and getting it wrong cost a round here. A sandbox
 * that answers every name – a `has: () => true` Proxy – makes `globalThis.__openposseOrb`
 * truthy, so `if (!globalThis.__openposseOrb)` is false and the entire orb body is skipped. The
 * harness then reports the broken bundle as clean, which is worse than having no harness: it is
 * a green tick for code that never ran.
 */
function evaluate(code, globals = []) {
  const sandbox = {};
  for (const name of globals) sandbox[name] = stub();
  vm.createContext(sandbox);
  new vm.Script(code, { filename: 'bundle.js' }).runInContext(sandbox);
  return sandbox;
}

/** Bundles exactly as `npm run build` does, in memory, so the test cannot read a stale artefact. */
async function bundled(entry) {
  const result = await build({
    entryPoints: [entry], bundle: true, format: 'iife', write: false, logLevel: 'silent',
  });
  return result.outputFiles[0].text;
}

test('orb.js survives being loaded, and its body actually runs', async () => {
  const sandbox = evaluate(await bundled('src/orb.js'), ['document', 'chrome']);
  // Without this the test passes vacuously the moment the re-injection guard stops matching:
  // the file would load, skip everything, and throw nothing.
  assert.equal(sandbox.__openposseOrb, true, 'the guarded block was skipped, so nothing was tested');
});

test('content.js survives being loaded, and its body actually runs', async () => {
  const sandbox = evaluate(await bundled('src/content.js'), ['chrome']);
  assert.equal(sandbox.__openposseContentScript, true, 'the guarded block was skipped');
});

test('capture.js survives being loaded', async () => {
  // The recorder's in-page helper. It needs no globals at load time, which is itself worth
  // pinning: if it grows one, this fails with the name rather than at the next recording.
  const code = await bundled('tools/capture.js');
  assert.doesNotThrow(() => evaluate(code));
});

test('the runner reports a throw instead of swallowing it', () => {
  // The exact shape that shipped: a backtick inside a template literal closes it, leaving a
  // tagged-template call on the string that precedes it.
  const asItShipped = 'const MARK_CSS = "x"; const CSS = `a` + MARK_CSS.keys`b`;';
  assert.throws(() => evaluate(asItShipped), /keys is not a function/);
});

test('an unknown global is undefined, so re-injection guards still guard', () => {
  // Pins the harness bug above: if this ever returns a truthy stub, every guarded bundle in this
  // file starts passing without executing a line.
  const sandbox = evaluate('globalThis.reached = !globalThis.__nobodySetsThis;');
  assert.equal(sandbox.reached, true);
});
