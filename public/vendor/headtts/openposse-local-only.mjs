// Serves Kokoro's files from the verified cache, and refuses the network.
//
// **This is an OpenPosse addition, not part of HeadTTS.** It is the smallest patch that makes
// the vendored engine obey this project's rules, and it is a shim rather than configuration on
// purpose.
//
// The problem it solves: two different layers want to fetch the same files. transformers.js
// pulls the model through `from_pretrained`, and HeadTTS's worker pulls each voice from
// `voiceURL`. Both are hardcoded to HuggingFace URLs, and both would go to the network at the
// exact moment somebody is waiting for an answer — which `CLAUDE.md` forbids in as many words:
// *"Nothing fetched while a turn is in flight."*
//
// Pointing their options at local paths would have worked and would have been worse. It leaves
// the promise as a configuration detail, so one missed option, one upstream default change, or
// one code path nobody checked sends audio text to a third party during a turn. Replacing
// `fetch` in the worker makes the promise **structural**: there is no route to the network from
// in here, so there is nothing to get wrong later.
//
// What it will serve is exactly what `weights.js` downloaded and hash-checked. Anything else is
// refused loudly, because a miss means either a file we failed to download or an engine asking
// for something we never verified — and both of those are worth a stack trace rather than a
// silent 404 deep inside an inference library.

const CACHE = 'openposse-kokoro-v1';

/** Strips the query HuggingFace appends (`?download=true`) so keys match what we stored. */
function canonical(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url);
  }
}

/**
 * Makes a worker that fails during setup say so, instead of being waited on for 30 seconds.
 *
 * HeadTTS's `setup()` is async, and both of its failure paths end in `throw`. A throw inside an
 * async function is an **unhandled rejection**, which does not fire `Worker.onerror` — so the
 * main thread learns nothing, waits out its timeout, and reports "Connection timed out", which
 * is true and useless. The real message is in the worker's own console, which is a different
 * DevTools window from the one anybody is looking at.
 *
 * This forwards it. `headtts.mjs` is patched to reject on these, turning a silent half-minute
 * into an immediate, specific failure.
 */
export function reportWorkerFailures(self_ = self) {
  const post = (what, detail) => {
    try {
      self_.postMessage({
        type: 'openposse-error',
        message: `${what}: ${detail?.message ?? detail ?? 'no detail'}`,
        stack: detail?.stack ?? null,
      });
    } catch { /* the port is gone; the console line below is all that is left */ }
  };

  self_.addEventListener('unhandledrejection', (event) => {
    console.error('[openposse] worker rejection —', event.reason);
    post('worker failed', event.reason);
  });
  self_.addEventListener('error', (event) => {
    console.error('[openposse] worker error —', event.message ?? event);
    post('worker error', event.error ?? event);
  });
}

export function installLocalOnlyFetch(self_ = self) {
  if (self_.__openposseLocalOnly) return;
  self_.__openposseLocalOnly = true;

  const original = self_.fetch.bind(self_);

  self_.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);

    if (url.startsWith('blob:') || url.startsWith('data:')) return original(input, init);

    // **The cache is consulted for extension URLs too**, and that is not belt-and-braces — it
    // is how the model is found at all now. `env.localModelPath` points transformers.js at a
    // `chrome-extension://…/vendor/models/` prefix so it never assembles a huggingface.co URL,
    // and nothing is actually *at* that path: the files are in the cache, keyed by where they
    // were downloaded from. The tail match below is what bridges the two.
    const cache = await caches.open(CACHE);
    let hit = (await cache.match(url)) ?? (await cache.match(canonical(url)));

    // **Revisions will not line up, and that is expected.** We pinned a commit so the bytes
    // could not move under us; transformers.js asks for `/resolve/main/…` because that is what
    // a model id means to it. Same file, different URL.
    //
    // So a miss falls back to matching the tail of the path — `onnx/model_q8f16.onnx`,
    // `voices/bm_george.bin`. That is not a loosening of the guarantee: every byte in this
    // cache was checked against a hash in the build *before it was stored*, so what is being
    // relaxed is only how a verified file is looked up, never whether it was verified.
    if (!hit) {
      const keys = await cache.keys();
      // Two segments first, then one. `onnx/model_q8f16.onnx` and `voices/bm_george.bin` are
      // identified by their directory; `config.json` sits at the repository root, where the
      // second-to-last segment **is the revision** — so a two-segment tail compares
      // `main/config.json` against `dd4401a9…/config.json` and never matches. That was a real
      // failure, and the narrower rule alone could not express it.
      //
      // Filenames across everything pinned are distinct, so the one-segment pass is
      // unambiguous. Most specific first regardless, so a future collision resolves correctly
      // rather than alphabetically.
      for (const depth of [2, 1]) {
        const tail = canonical(url).split('/').slice(-depth).join('/');
        const match = keys.find((r) => canonical(r.url).endsWith(`/${tail}`));
        if (match) { hit = await cache.match(match); break; }
      }
    }
    if (hit) return hit;

    // An extension URL that is not in the cache is one of our own packaged files — the
    // dictionary, a worker sibling, the WASM. Local by definition, so it goes to the real
    // fetch; a 404 here is a missing file in the build, not a privacy question.
    if (url.startsWith('chrome-extension://')) return original(input, init);

    // Loud, and specific about which of the two things went wrong, because they need opposite
    // fixes: a file we never downloaded is a setup problem, and a URL we never pinned means the
    // engine wants something this build has not verified.
    throw new Error(
      `[openposse] refused a network request for ${canonical(url)} — `
      + 'Kokoro runs from locally verified files only. Either the download is incomplete, or '
      + 'the engine asked for a file this build does not pin.',
    );
  };
}
