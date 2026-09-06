// OpenPosse selector capture — paste into DevTools on a vendor's assistant page.
//
// This is the hand-cranked precursor to M3's recorder. It produces the fields of a `Recipe`
// (`Sources/OpenPosseShared/Recipe.swift`) by inspecting a live page, so the first vendor
// recipe is *recorded* rather than guessed — which is the rule that keeps selector literals
// out of extension source.
//
// PRIVACY: it reports element structure and identifying attributes only. It never emits page
// text, form values, cookies, tokens, or URLs beyond the page's own origin. Response
// containers are reported by shape (tag, attributes, text *length*), never by content — you
// can read everything below before pasting it anywhere.
//
// Usage:
//   1. openposseCapture()          → candidate selectors for input / submit / response
//   2. openposseCaptureShortcut()  → then press the assistant's shortcut

(() => {
  const MAX_RESULTS = 6;

  /** Attributes worth building a selector from, most stable first. */
  const STABLE_ATTRS = [
    'data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa',
    'id', 'name', 'aria-label', 'placeholder', 'role',
  ];

  /** Everything in the page, including shadow roots and same-origin iframes. */
  function allElements(root = document, seen = new Set()) {
    const out = [];
    const nodes = root.querySelectorAll?.('*') ?? [];
    for (const el of nodes) {
      if (seen.has(el)) continue;
      seen.add(el);
      out.push(el);
      if (el.shadowRoot) out.push(...allElements(el.shadowRoot, seen));
    }
    for (const frame of root.querySelectorAll?.('iframe') ?? []) {
      let doc = null;
      try { doc = frame.contentDocument; } catch { /* cross-origin: unreachable by design */ }
      if (doc) out.push(...allElements(doc, seen));
    }
    return out;
  }

  /**
   * How many elements match `selector` anywhere, including inside shadow roots.
   *
   * `document.querySelectorAll` stops at every shadow boundary, so on a page like LeanIX's —
   * 100+ shadow roots — it reports 0 matches for an element that plainly exists, the
   * uniqueness check fails, and a perfectly good `[data-testid=…]` gets discarded in favour
   * of a structural path that cannot resolve from `document` either. The runtime's
   * `deepQuerySelector` searches all roots, so uniqueness must be measured the same way.
   */
  function deepMatchCount(selector) {
    let count = 0;
    for (const el of allElements()) {
      try { if (el.matches?.(selector)) count += 1; } catch { return -1; }
    }
    return count;
  }

  /**
   * The most stable selector that uniquely identifies `el`.
   *
   * Returns `{ selector, stable }`. `stable: false` means it fell back to a structural path —
   * those are the fragile ones, and `Recipe.usesStructuralSelector` exists to flag them in
   * the UI rather than let them rot quietly.
   */
  function selectorFor(el) {
    for (const attr of STABLE_ATTRS) {
      const value = el.getAttribute?.(attr);
      if (!value) continue;
      const candidate = attr === 'id'
        ? `#${CSS.escape(value)}`
        : `${el.tagName.toLowerCase()}[${attr}="${CSS.escape(value)}"]`;
      if (deepMatchCount(candidate) === 1) {
        return { selector: candidate, stable: true, via: attr };
      }
    }

    // A custom element's tag name IS its identity.
    //
    // Missing this was a real gap: on a web-components app (Angular, Lit, Stencil) the
    // semantic structure lives in tag names like `lx-agentic-chat-assistant-message`, not in
    // attributes. Checking only `data-testid`/`id`/`aria-label` marked every one of those
    // "unstable" and fell back to an nth-of-type path — discarding the most durable selector
    // on the page in favour of the most brittle. A component rename is far rarer than the
    // class and DOM-shape churn a structural path depends on.
    //
    // Deliberately allowed to match more than once: a chat has one such element per turn, and
    // the runtime takes the newest via `waitForNewMatch`. Uniqueness is the wrong test here.
    const tag = el.tagName.toLowerCase();
    if (tag.includes('-')) {
      const count = deepMatchCount(tag);
      if (count >= 1) {
        return { selector: tag, stable: true, via: 'custom-element', matches: count };
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
      const index = siblings.indexOf(node) + 1;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${index})`);
      node = parent;
    }
    return { selector: parts.join(' > '), stable: false, via: 'structure' };
  }

  const visible = (el) => {
    const rect = el.getBoundingClientRect?.();
    return rect && rect.width > 0 && rect.height > 0;
  };

  /** Identifying attributes only — never `value`, never text. */
  function describe(el) {
    const attrs = {};
    for (const attr of STABLE_ATTRS) {
      const value = el.getAttribute?.(attr);
      if (value) attrs[attr] = value;
    }
    const { selector, stable, via } = selectorFor(el);
    return {
      tag: el.tagName.toLowerCase(),
      selector,
      stable,
      via,
      attrs,
      visible: visible(el),
      // Length only. The text itself is exactly what must never leave the page.
      textLength: (el.innerText ?? '').length,
    };
  }

  globalThis.openposseCapture = function openposseCapture() {
    const elements = allElements();

    const inputs = elements.filter((el) =>
      el.tagName === 'TEXTAREA'
      || (el.tagName === 'INPUT' && ['text', 'search', ''].includes(el.type))
      || el.isContentEditable
    ).filter(visible);

    const buttons = elements.filter((el) =>
      (el.tagName === 'BUTTON' || el.getAttribute?.('role') === 'button')
      && visible(el)
      // Cheap heuristic for "this is the send control". Matches on the accessible name and
      // test id, never on surrounding page text.
      && /send|submit|ask|arrow|paper|enter/i.test(
        `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('data-testid') ?? ''} ${el.className ?? ''}`
      )
    );

    // Largest first. Sorting ascending here reported the six *smallest* blocks over the
    // threshold, which on a real page means six bits of unrelated chrome while the actual
    // answer — being long — sorted past the cut. Use openposseDiff() instead of this for
    // anything real; this list is only a hint.
    const containers = elements.filter((el) =>
      visible(el)
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
   * This is the reliable way to identify a response container, and guessing by shape is not.
   * A vendor page is mostly text that has nothing to do with the assistant — LeanIX's
   * inventory list alone produced 112 candidate blocks — so "which block is the answer" is
   * unanswerable from one snapshot and trivial from two.
   */
  let snapshot = null;

  globalThis.openposseSnapshot = function openposseSnapshot() {
    snapshot = new Map();
    for (const el of allElements()) {
      snapshot.set(el, (el.innerText ?? '').length);
    }
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
      if (after > before + 20 && visible(el)) {
        grew.push({ el, before, after, delta: after - before });
      }
    }

    // Smallest growth first, because the *tightest* element that grew is the response
    // container. Every ancestor up to <body> also grew by the same amount, and picking one of
    // those would make the app read the entire page chrome aloud along with the answer.
    grew.sort((a, b) => a.delta - b.delta || a.after - b.after);

    return {
      origin: location.origin,
      matched: grew.length,
      candidates: grew.slice(0, 8).map(({ el, before, after, delta }) => ({
        ...describe(el),
        textBefore: before,
        textAfter: after,
        delta,
        // How deep this sits inside the growth chain. The best container is usually the
        // shallowest element whose delta equals the smallest observed delta.
        ancestorsThatAlsoGrew: grew.filter((g) => g.el !== el && g.el.contains(el)).length,
      })),
    };
  };

  /**
   * Captures the next key combination as `Recipe.Shortcut`.
   *
   * Field names match the JavaScript `KeyboardEvent` properties exactly, so the extension
   * needs no translation layer. Capture phase, so it is recorded even when the page stops
   * propagation — which an app that owns the shortcut usually does.
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
    + '  3. openposseDiff()              — the response container\n'
    + '  openposseCapture()              — input and submit button\n'
    + '  openposseCaptureShortcut()      — then press the shortcut'
  );
})();
