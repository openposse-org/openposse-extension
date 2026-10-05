// How long a turn waits for the rest of an answer, when the vendor has not said it is done.
//
// Its own module because three contexts need the one number: the content script waits it out,
// the worker carries an override of it into every question, and the panel's debug tools show
// it. A copy in each would be three numbers free to drift – and the content script cannot be
// imported from anywhere, because loading it registers its listeners.
//
// What the grace *does* is described where it is spent, in `askAssistant` in content.js.

/**
 * The grace on the first extra pass, when the vendor's own busy indicator has not finished.
 *
 * **2.5 s, down from 10.** The first version was a guess with a ceiling and the ceiling was being
 * paid on every successful exchange: `settling 11998ms over 3 passes` for an answer already
 * sitting in the tab. Pass 1 waits for a row *beyond* the one just read, and when pass 0 already
 * had the answer – the common case – no such row is ever coming, so the whole window is spent
 * discovering that.
 *
 * The replacement is measured rather than guessed. The same trace reports the vendor's own
 * thinking time at 1.5–2 s, so the status-row-to-answer gap is that order, and 2.5 s covers it
 * with margin. Worst case is now ~4 s of settling instead of ~12.
 *
 * Still a clock, and still the wrong instrument. The honest fix is the vendor's own "still
 * generating" indicator, recorded during setup – E8.
 */
export const ANSWER_GRACE_MS = 2_500;

/**
 * Where the panel's debug tools keep an override, and the range they offer.
 *
 * **In `chrome.storage.session`**, for the same reason as the follow-up window in routing.js: a
 * debug value nobody remembers setting must not outlive the browser. The content script cannot
 * read session storage, so the worker reads it and sends it along with each question.
 *
 * The range runs to 10 s so the old ceiling can be put back to compare against, and stops at
 * 0.5 s because below that it is shorter than a page takes to render the row it is waiting for.
 */
export const GRACE_OVERRIDE_KEY = 'graceOverrideMs';
export const GRACE_RANGE = { min: 500, max: 10_000, step: 250 };

/**
 * The grace in force: an override when it is a usable number, else `ANSWER_GRACE_MS`.
 *
 * Validated where it is used rather than where it is sent. It crosses from the worker into a
 * vendor's page, and a value that arrives malformed should cost the default, not the turn.
 */
export function graceWindow(override) {
  // The range check also catches empty: `Number(null)` and `Number('')` are 0, which is finite.
  const ms = Number(override);
  return Number.isFinite(ms) && ms >= GRACE_RANGE.min && ms <= GRACE_RANGE.max
    ? ms
    : ANSWER_GRACE_MS;
}
