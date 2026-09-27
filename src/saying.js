// Deciding what to say out loud, when the answer is longer than anyone wants read to them.
//
// This exists because of a complaint that turned out to be the real product problem: **AI
// answers are far longer than one or two sentences.** A panel that reads a six-paragraph reply
// aloud is not a voice assistant, it is a screen reader with extra steps, and waiting for it to
// finish is worse than having read the thing yourself.
//
// So: short answers are spoken whole, long ones are spoken as one useful sentence while the
// full text stays on screen. Chrome's on-device `Summarizer` does the shortening — no cloud, no
// fallback to one, same guarantee as the speech recogniser. When it is unavailable, which is
// common given the hardware gate, the first sentence plus a pointer to the screen is a
// deliberately dumb fallback that is still honest: it never claims to have summarised anything.
//
// The decisions are pure and live here; the speaking is in the offscreen document.

/**
 * Above this many characters, speaking the whole thing is a worse experience than shortening.
 *
 * ~320 characters is roughly 20 seconds of speech at a normal rate, and about two sentences of
 * ordinary prose. The threshold is on *characters* rather than sentences on purpose: one very
 * long sentence is exactly as tiring to listen to as three short ones, and sentence counting
 * would let it through.
 */
export const SPEAK_WHOLE_BELOW = 320;

export function needsShortening(text) {
  return String(text ?? '').trim().length > SPEAK_WHOLE_BELOW;
}

/**
 * The first sentence, for when there is no summariser.
 *
 * Deliberately conservative about what ends a sentence. `.` is ambiguous — it ends sentences,
 * but it also sits inside `3.5`, `e.g.`, `Dr.` and `notion.so` — so a naive split truncates an
 * answer mid-thought and produces something that reads as a bug rather than as a summary.
 *
 * A full stop only ends a sentence here when it is followed by whitespace and something that
 * looks like a new sentence starting, and when what precedes it is not a known abbreviation.
 * `?` and `!` are unambiguous and end one outright.
 */
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'no', 'vs', 'etc', 'eg', 'ie',
  'e.g', 'i.e', 'approx', 'fig', 'inc', 'ltd', 'co', 'dept', 'est', 'al',
]);

export function firstSentence(text) {
  const s = String(text ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return '';

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch !== '.' && ch !== '?' && ch !== '!') continue;

    // Runs of terminators ("…!?") end together, so find the end of the run.
    let end = i;
    while (end + 1 < s.length && '.?!'.includes(s[end + 1])) end += 1;

    const next = s.slice(end + 1);
    // Nothing after it: the whole string is one sentence.
    if (!next.trim()) return s;
    // A terminator mid-token — `notion.so`, `3.5` — is not the end of anything.
    if (!/^\s/.test(next)) continue;
    // What follows has to look like a new sentence. A lowercase word after a full stop is
    // almost always an abbreviation we failed to list.
    if (!/^\s+["'“(]?[A-Z0-9]/.test(next)) continue;

    if (ch === '.') {
      const word = s.slice(0, i).split(/[\s(]/).pop().toLowerCase();
      if (ABBREVIATIONS.has(word) || ABBREVIATIONS.has(word.replace(/\.$/, ''))) continue;
      // A single capital before the stop is an initial — "J. R. Tolkien".
      if (/(^|\s)[A-Za-z]$/.test(s.slice(0, i))) continue;
    }

    return s.slice(0, end + 1);
  }
  return s;
}

/**
 * What to speak, given an answer and whatever the summariser managed.
 *
 * **Never claims more than it did.** A real summary is spoken on its own, because it is a
 * whole thought. The fallback is a truncation, and a truncation read aloud with no warning
 * sounds like the assistant stopped mid-answer — so it says where the rest is. That sentence
 * is the difference between a limitation and a bug.
 *
 * @param answer   the full text, which stays on screen either way
 * @param summary  what `Summarizer` returned, or null when it was unavailable or failed
 */
export function spokenForm(answer, summary = null) {
  const full = String(answer ?? '').trim();
  if (!full) return { text: '', shortened: false };
  if (!needsShortening(full)) return { text: full, shortened: false };

  const short = String(summary ?? '').trim();
  if (short && short.length < full.length) return { text: short, shortened: true };

  const opening = firstSentence(full);
  // Only worth saying when there is meaningfully more to see. A two-sentence answer whose
  // first sentence is nearly all of it does not need to be told it is incomplete.
  if (opening && opening.length < full.length * 0.8) {
    return { text: `${opening} The rest is on screen.`, shortened: true };
  }
  return { text: full, shortened: false };
}
