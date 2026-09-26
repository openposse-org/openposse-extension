// Chrome's on-device summariser, and what to do on the many machines that do not have it.
//
// `Summarizer` with `type: 'tldr', length: 'short'` returns roughly one sentence, entirely
// locally — Chrome documents no cloud fallback, which is the same guarantee `processLocally`
// gives the recogniser and the reason this is allowed to exist here at all.
//
// **It is an enhancement and never a dependency.** It shares Gemini Nano's hardware gate — 22 GB
// of free disk plus either 4 GB of VRAM or 16 GB of RAM — which plenty of machines fail. A demo
// machine that happens to clear it will hide how often the fallback runs, so every path through
// here returns `null` rather than throwing, and `spokenForm` treats `null` as the ordinary case
// it is.
//
// One session is kept warm because `create()` is far more expensive than `summarize()` — the
// same lesson `AFMRouter.prewarm()` records on the Swift side, arriving at a different vendor.

const OPTIONS = {
  type: 'tldr',
  length: 'short',
  format: 'plain-text',
};

/** The warm session, or a promise for one. Null when unavailable or not yet asked for. */
let session = null;

/** Set once we know this machine cannot do it, so we stop asking on every answer. */
let unavailable = false;

function api() {
  return globalThis.Summarizer ?? null;
}

/**
 * Whether this machine can summarise, without starting a download.
 *
 * `downloadable` is deliberately treated as *not available*. Kicking off a multi-gigabyte model
 * download because somebody asked an assistant a question would be a surprising thing to do
 * with their disk and their network, and there is nowhere in a spoken turn to show progress.
 */
export async function canSummarise() {
  const Summarizer = api();
  if (!Summarizer?.availability || unavailable) return false;
  try {
    return (await Summarizer.availability(OPTIONS)) === 'available';
  } catch {
    return false;
  }
}

/**
 * One sentence, or null.
 *
 * Null covers every way this can fail to produce something useful — no API, wrong hardware,
 * a model that declined, a timeout — because the caller's response to all of them is the same
 * and `spokenForm` already knows what to do with nothing.
 */
export async function summarise(text) {
  if (!text || unavailable) return null;
  const Summarizer = api();
  if (!Summarizer) return null;

  try {
    if (!(await canSummarise())) {
      // Latched, so a machine that cannot do this pays the availability check once rather than
      // on every answer for the rest of the session.
      unavailable = true;
      return null;
    }
    session ??= Summarizer.create(OPTIONS);
    const summariser = await session;
    const out = await summariser.summarize(text);
    return typeof out === 'string' && out.trim() ? out.trim() : null;
  } catch {
    // A session that has gone bad should not poison every later answer, so it is dropped
    // rather than latched — the next turn builds a fresh one.
    session = null;
    return null;
  }
}

/** Test seam, and the way to re-check after the user installs the model. */
export function resetSummariser() {
  session = null;
  unavailable = false;
}
