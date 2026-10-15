// What the assistant's tab title says during a turn – the words, and nothing that touches a page.
//
// The assistant's tab is in the background while OpenPosse asks it something, so the tab strip is
// the only part of it in view. Its title says what is happening there: `typing… · Q3 plan`, then
// `answering… · Q3 plan`, then `done · Q3 plan`, then the page's own title again. The hero on
// openposse.org shows the same three words. See `docs/tab-titles.md`.
//
// **A prefix, not a suffix.** Chrome cuts a title from the end, and a background tab is narrow,
// so `answering… · Q3 plan` keeps the word visible where `Q3 plan – answering…` would lose it.

/** The words, by state. The ellipsis is the single character, as in the panel's "is thinking…". */
export const STATES = Object.freeze({
  typing: 'typing…',
  answering: 'answering…',
  done: 'done',
});

export const SEPARATOR = ' · ';

/** How long `done` stays when nobody looks at the tab: long enough to find the tab by it. */
export const DONE_MS = 90_000;

const PREFIXES = Object.values(STATES).map((word) => word + SEPARATOR);

/** The title with one OpenPosse prefix removed, if it has one. Any other title is left alone. */
export function original(title) {
  const text = String(title ?? '');
  const prefix = PREFIXES.find((p) => text.startsWith(p));
  return prefix ? text.slice(prefix.length) : text;
}

/**
 * The title showing `state`. Applying a state to a title that already shows one replaces it, so
 * the strip reads `answering… · Q3 plan`, never `answering… · typing… · Q3 plan`.
 */
export function withState(title, state) {
  const word = STATES[state];
  if (!word) throw new Error(`no tab-title state called ${state}`);
  return word + SEPARATOR + original(title);
}
