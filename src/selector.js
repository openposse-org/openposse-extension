// Computing a durable CSS selector for one element.
//
// Promoted here from `tools/capture.js`, which was the hand-cranked precursor to the recorder
// and is now built from this module — one implementation, so the selector a user records
// through the wizard is the same one the DevTools tool reports. Two copies would drift, and the
// symptom would be a recipe that works when captured by hand and not by the product.
//
// PRIVACY: everything here reports element *structure* and identifying attributes. It never
// reads `value`, `textContent`, or any user-entered data. Text is only ever measured by length.

import { deepQuerySelectorAll, isVisible } from './dom.js';

/** Attributes worth building a selector from, most stable first. */
export const STABLE_ATTRS = [
  'data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa',
  'id', 'name', 'aria-label', 'placeholder', 'role',
];

/**
 * How many elements match `selector`, counted the way the runtime counts.
 *
 * `document.querySelectorAll` stops at every shadow boundary, so on a page like LeanIX's —
 * 100+ shadow roots — it reports 0 matches for an element that plainly exists, the uniqueness
 * check fails, and a perfectly good `[data-testid=…]` is discarded in favour of a structural
 * path that cannot resolve from `document` either.
 */
export function deepMatchCount(selector) {
  try {
    return deepQuerySelectorAll(selector).length;
  } catch {
    return -1;                      // malformed selector
  }
}

/**
 * The most durable selector that identifies `el`.
 *
 * Returns the shape of `CapturedSelector` in `Sources/OpenPosseShared/Recording.swift` —
 * `{ css, via, isStable, matchCount }` — so neither side translates.
 */
export function selectorFor(el) {
  for (const attr of STABLE_ATTRS) {
    const value = el.getAttribute?.(attr);
    if (!value) continue;
    const css = attr === 'id'
      ? `#${CSS.escape(value)}`
      : `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(value)}"]`;
    if (deepMatchCount(css) === 1) {
      return { css, via: attr, isStable: true, matchCount: 1 };
    }
  }

  // A custom element's tag name IS its identity.
  //
  // On a web-components app (Angular, Lit, Stencil) the semantic structure lives in tag names
  // like `lx-agentic-chat-assistant-message`, not in attributes. Checking only
  // `data-testid`/`id`/`aria-label` marks every one of those "unstable" and falls back to an
  // nth-of-type path — discarding the most durable selector on the page for the most brittle.
  // A component rename is far rarer than the class and DOM-shape churn a structural path
  // depends on.
  //
  // Deliberately allowed to match more than once: a chat has one such element per turn, and
  // the runtime takes the newest via `waitForNewMatch`. Uniqueness is the wrong test here.
  const tag = el.tagName.toLowerCase();
  if (tag.includes('-')) {
    const matchCount = deepMatchCount(tag);
    if (matchCount >= 1) {
      return { css: tag, via: 'custom-element', isStable: true, matchCount };
    }
  }

  // Structural fallback: nth-of-type path up to the nearest id.
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && parts.length < 6) {
    if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; }
    const parent = node.parentElement;
    if (!parent) break;
    const siblings = [...parent.children].filter((c) => c.tagName === node.tagName);
    parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
    node = parent;
  }
  const css = parts.join(' > ');
  return { css, via: 'structure', isStable: false, matchCount: deepMatchCount(css) };
}

/** Identifying attributes only — never `value`, never text. Used by the DevTools tool. */
export function describe(el) {
  const attrs = {};
  for (const attr of STABLE_ATTRS) {
    const value = el.getAttribute?.(attr);
    if (value) attrs[attr] = value;
  }
  return {
    tag: el.tagName.toLowerCase(),
    ...selectorFor(el),
    attrs,
    visible: isVisible(el),
    // Length only. The text itself is exactly what must never leave the page.
    textLength: (el.innerText ?? '').length,
  };
}
