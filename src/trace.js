// Where the time goes in a turn.
//
// The loop had exactly three log lines — listening, ended, and whatever failed — so "there is a
// lag between Notion answering and the panel" could not be answered without guessing at which
// of six steps it was. Guessing at timings is how this project got `10.5 s`, `3.181 s` and
// `59 ms` into its root `CLAUDE.md` as bugs found only by reading a clock.
//
// Every line carries milliseconds since the turn began, so the gaps are the point rather than
// the events. A step that takes 8 seconds is visible as a gap even when nothing about it is
// wrong, which is what makes this useful for *tuning* and not just for failures.
//
// **Never content.** A step name, a duration, and counts or codes — the same rule as everywhere
// else. The one thing a trace of a voice assistant must not become is a transcript with
// timestamps.

let startedAt = 0;
let last = 0;

/** Resets the clock. Called when a turn begins, so every line is relative to the same zero. */
export function beginTurn(what = 'turn') {
  startedAt = performance.now();
  last = startedAt;
  console.info(`[openposse] ──── ${what} ────`);
}

/**
 * One step, with time since the turn started and since the previous step.
 *
 * The second number is the one that finds things. Total elapsed tells you a turn took nine
 * seconds; the delta tells you which step spent eight of them.
 */
export function trace(step, detail = '') {
  const now = performance.now();
  if (!startedAt) beginTurn();
  const total = Math.round(now - startedAt);
  const delta = Math.round(now - last);
  last = now;
  console.info(
    `[openposse] ${String(total).padStart(6)}ms  +${String(delta).padStart(5)}ms  ${step}`,
    detail,
  );
}
