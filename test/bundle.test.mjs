// The only test here that *runs* a bundle, and the only one that could have caught the backtick.
//
// Everything else under `tools/` tests a pure module. That left the files which actually get
// injected into a page – `content.js`, and the in-page orb until it was retired on 2026-10-24 –
// covered by nothing: a comment written with real backticks inside orb.js's CSS template
// became ``MARK_CSS.keys`…` ``, a *valid* tagged-template call, so esbuild built it, ESLint passed it and 118 tests stayed green while
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
    // **One symbol is answered, and it is not decoration.** `const [tab] = await
    // chrome.tabs.query(…)` is how every extension page reads the tab in front, and array
    // destructuring asks for `Symbol.iterator`. Without this the read throws *after* the test
    // has returned, which Node reports as an unhandled rejection against the whole file – six
    // green ticks and a red file, with the reason nowhere near the test that caused it.
    if (key === Symbol.iterator) return function* iterate() { yield stub(thenable); };
    // **And one more, for the same reason.** `` `Ask ${agent.name}` `` is ordinary UI code, and
    // a template literal coerces. Without this the fallback chain is `valueOf` then `toString`,
    // both of which the trap answers with another *stub* rather than a primitive – so every
    // interpolation throws "Cannot convert object to primitive value", asynchronously, long
    // after the test that caused it has passed.
    if (key === Symbol.toPrimitive) return (hint) => (hint === 'number' ? 0 : '«stub»');
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
 * that answers every name – a `has: () => true` Proxy – makes a re-injection guard such as
 * `globalThis.__openposseContentScript` truthy, so the guard is false and the entire body is
 * skipped. The
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

test('content.js survives being loaded, and its body actually runs', async () => {
  const sandbox = evaluate(await bundled('src/content.js'), ['chrome']);
  // Without this the test passes vacuously the moment the re-injection guard stops matching:
  // the file would load, skip everything, and throw nothing.
  assert.equal(sandbox.__openposseContentScript, true, 'the guarded block was skipped');
});

test('sidepanel.js survives being loaded, and runs to its last statement', async () => {
  // **This is the only surface**, so a module-load throw here is the whole product doing
  // nothing – the exact symptom this file exists for.
  //
  // The assertion is `requestAnimationFrame` having been reached, because it is the file's last
  // statement: a throw anywhere above it leaves `frame` null, which is precisely the failure the
  // stray backtick produced four hundred lines into the since-retired orb.js.
  //
  // **It schedules a frame and does not draw one**, deliberately. Invoking the callback would run
  // `drawSphere`, which wants a canvas with real dimensions and a 2D context – and `stub` cannot
  // give it either, because a chaining Proxy has no primitive conversion, so `window
  // .devicePixelRatio` fails at `Math.min`. Mocking fifteen canvas methods to execute drawing
  // code that has been on screen for weeks is not what this harness is for.
  let frame = null;
  const sandbox = {
    window: stub(), document: stub(), chrome: stub(), navigator: stub(), console: stub(),
    requestAnimationFrame: (fn) => { frame ??= fn; return 1; },
  };
  vm.createContext(sandbox);
  const code = await bundled('src/sidepanel.js');
  new vm.Script(code, { filename: 'sidepanel.js' }).runInContext(sandbox);

  assert.equal(typeof frame, 'function', 'the module did not reach its last statement');
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
