// OpenPosse selector capture — the manual counterpart to the recorder.
//
// Build it (`npm run build`) and paste `dist/capture.js` into DevTools on a vendor's assistant
// page. It reports the fields of a `Lasso` (`Sources/OpenPosseShared/Lasso.swift`) by
// inspecting a live page.
//
// **It shares its selector computation with the recorder** — `src/selector.js` — rather than
// carrying a second copy. That matters: this tool is what you reach for when a recorded agent
// stops working, and a tool that computes selectors differently from the thing under test
// answers a question you did not ask.
//
// PRIVACY: it reports element structure and identifying attributes only. It never emits page
// text, form values, cookies, tokens, or URLs beyond the page's own origin. Response containers
// are reported by shape (tag, attributes, text *length*), never by content.
//
// Usage:
//   1. openposseSnapshot()          — before asking
//   2. …ask the assistant, wait for the full answer…
//   3. openposseDiff()              — the reply element
//   openposseCapture()              — input and submit button
//   openposseCaptureShortcut()      — then press the shortcut

import { deepQuerySelectorAll, isVisible } from '../src/dom.js';
import { describe } from '../src/selector.js';

const MAX_RESULTS = 6;

/** Every element in the page, including shadow roots and same-origin iframes. */
const allElements = () => deepQuerySelectorAll('*');

globalThis.openposseCapture = function openposseCapture() {
  const elements = allElements();

  const inputs = elements.filter((el) =>
    el.tagName === 'TEXTAREA'
    || (el.tagName === 'INPUT' && ['text', 'search', ''].includes(el.type))
    || el.isContentEditable
  ).filter(isVisible);

  const buttons = elements.filter((el) =>
    (el.tagName === 'BUTTON' || el.getAttribute?.('role') === 'button')
    && isVisible(el)
    // Cheap heuristic for "this is the send control". Matches on the accessible name and test
    // id, never on surrounding page text.
    && /send|submit|ask|arrow|paper|enter/i.test(
      `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('data-testid') ?? ''} ${el.className ?? ''}`
    )
  );

  // Largest first. Sorting ascending here reported the six *smallest* blocks over the
  // threshold, which on a real page means six bits of unrelated chrome while the actual answer
  // — being long — sorted past the cut. Use openposseDiff() for anything real; this is a hint.
  const containers = elements.filter((el) =>
    isVisible(el)
    && (el.innerText ?? '').length > 80
    && el.children.length > 0
    && !['BODY', 'HTML', 'MAIN'].includes(el.tagName)
  ).sort((a, b) => (b.innerText?.length ?? 0) - (a.innerText?.length ?? 0));

  return {
    origin: location.origin,
    pathname: location.pathname,
    inputs: inputs.slice(0, MAX_RESULTS).map(describe),
    submitButtons: buttons.slice(0, MAX_RESULTS).map(describe),
    responseCandidates: containers.slice(0, MAX_RESULTS).map(describe),
    counts: {
      inputs: inputs.length,
      buttons: buttons.length,
      containers: containers.length,
      iframes: document.querySelectorAll('iframe').length,
      shadowRoots: elements.filter((el) => el.shadowRoot).length,
    },
  };
};

/**
 * Records every element's text length, to be compared after asking a question.
 *
 * This is the reliable way to identify a reply element, and guessing by shape is not. A vendor
 * page is mostly text that has nothing to do with the assistant — LeanIX's inventory list alone
 * produced 112 candidate blocks — so "which block is the answer" is unanswerable from one
 * snapshot and trivial from two.
 */
let snapshot = null;

globalThis.openposseSnapshot = function openposseSnapshot() {
  snapshot = new Map();
  for (const el of allElements()) snapshot.set(el, (el.innerText ?? '').length);
  console.info(`[openposse] snapshot taken: ${snapshot.size} elements. `
    + 'Now ask the assistant something, wait for the full answer, then run openposseDiff().');
  return snapshot.size;
};

/** Elements whose text grew since `openposseSnapshot()`, smallest growth first. */
globalThis.openposseDiff = function openposseDiff() {
  if (!snapshot) {
    console.warn('[openposse] run openposseSnapshot() first');
    return null;
  }

  const grew = [];
  for (const el of allElements()) {
    const before = snapshot.get(el) ?? 0;
    const after = (el.innerText ?? '').length;
    if (after > before + 20 && isVisible(el)) grew.push({ el, before, after, delta: after - before });
  }

  // Newly-added elements first, largest content first within each group.
  //
  // This used to sort by *smallest* growth, on the reasoning that the tightest element which
  // grew is the reply and every ancestor up to `<body>` grew by the same amount. That holds for
  // a vendor whose answer is one element. It is badly wrong for one whose answer is many blocks:
  // on Notion it filled all eight slots with 21-character fragments and left the 1500-character
  // answer off the list entirely, which sent me writing a heuristic against noise.
  //
  // `isNewSinceSnapshot` is the more decisive signal anyway — `responseContainerSelector` has to
  // gain a match per answer, so an element that merely got longer can never be the right one.
  grew.sort((a, b) => {
    const aNew = !snapshot.has(a.el), bNew = !snapshot.has(b.el);
    if (aNew !== bNew) return aNew ? -1 : 1;
    return b.after - a.after;
  });

  return {
    origin: location.origin,
    matched: grew.length,
    candidates: grew.slice(0, 8).map(({ el, before, after, delta }) => ({
      ...describe(el),
      textBefore: before,
      textAfter: after,
      delta,
      // Whether this element is NEW rather than merely longer. This is the property that
      // matters: `responseContainerSelector` must gain a match per answer, because the runtime
      // waits for the count to increase. An element that only grew is the transcript, and a
      // lasso built on it times out on every question. See `RecordedReply`.
      isNewSinceSnapshot: !snapshot.has(el),
      // How deep this sits inside the growth chain.
      ancestorsThatAlsoGrew: grew.filter((g) => g.el !== el && g.el.contains(el)).length,
    })),
  };
};

/**
 * Captures the next key combination as `Lasso.Shortcut`.
 *
 * Field names match the JavaScript `KeyboardEvent` properties exactly, so the extension needs
 * no translation layer. Capture phase, so it is recorded even when the page stops propagation —
 * which an app that owns the shortcut usually does.
 */
globalThis.openposseCaptureShortcut = function openposseCaptureShortcut() {
  console.info('[openposse] press the assistant shortcut now…');
  return new Promise((resolve) => {
    const handler = (event) => {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
      window.removeEventListener('keydown', handler, true);
      const shortcut = {
        key: event.key,
        code: event.code,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
      };
      console.info('[openposse] captured:', shortcut);
      resolve(shortcut);
    };
    window.addEventListener('keydown', handler, true);
  });
};

console.info(
  '[openposse] ready.\n'
  + '  1. openposseSnapshot()          — before asking\n'
  + '  2. …ask the assistant, wait for the full answer…\n'
  + '  3. openposseDiff()              — the reply element\n'
  + '  openposseCapture()              — input and submit button\n'
  + '  openposseCaptureShortcut()      — then press the shortcut'
);
