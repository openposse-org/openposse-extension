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

export function installLocalOnlyFetch(self_ = self) {
  if (self_.__openposseLocalOnly) return;
  self_.__openposseLocalOnly = true;

  const original = self_.fetch.bind(self_);

  self_.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);

    // Our own packaged files — the dictionary, the worker's siblings. Always local, never the
    // network, and left alone.
    if (url.startsWith('chrome-extension://') || url.startsWith('blob:') || url.startsWith('data:')) {
      return original(input, init);
    }

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
      const tail = canonical(url).split('/').slice(-2).join('/');
      for (const request of await cache.keys()) {
        if (canonical(request.url).endsWith(`/${tail}`)) {
          hit = await cache.match(request);
          break;
        }
      }
    }
    if (hit) return hit;

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
