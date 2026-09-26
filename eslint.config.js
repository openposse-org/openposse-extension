// Narrow on purpose: this catches one class of bug, and it is a class that has already cost
// a real debugging cycle.
//
// `emitReply` was refactored to take a selector instead of an element, the parameter went, and
// one reference to `element` stayed in the body. It bundled cleanly, it passed every test —
// there are none that exercise the recorder without a DOM — and it threw at runtime on the
// *second* answer only, so the panel simply stopped advancing. From the user's side that looked
// identical to the recorder having missed their question, and they re-sent it three times.
//
// `no-undef` would have said "element is not defined" before the extension was ever reloaded.
//
// Style rules are deliberately absent. The point is not tidiness; it is that an identifier that
// does not exist should not reach a browser.
export default [
  {
    files: ['src/**/*.js', 'tools/**/*.js', 'tools/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        // The browser surface these files actually use. Listed rather than pulled from a
        // globals package so an unexpected one — a typo, or a Node API in a content script —
        // is a failure instead of a shrug.
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        navigator: 'readonly',
        crypto: 'readonly',
        InputEvent: 'readonly',
        globalThis: 'readonly',
        chrome: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        MutationObserver: 'readonly',
        // The orb's frame loop. It runs inside a vendor's page, so it has to stop when the
        // panel is hidden rather than burning 60fps on somebody else's tab — which is what
        // `cancelAnimationFrame` is doing there.
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        Event: 'readonly',
        CSS: 'readonly',
        TextEncoder: 'readonly',
        WeakSet: 'readonly',
        Node: 'readonly',
        Element: 'readonly',
        HTMLElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLInputElement: 'readonly',
        getComputedStyle: 'readonly',
        structuredClone: 'readonly',
        URL: 'readonly',
        Date: 'readonly',
        // The offscreen document's timing source. It measures how long the recogniser waits
        // after the last word before declaring the turn over — the number that decides whether
        // endpointing is free here or has to be rebuilt, so it wants a monotonic clock rather
        // than one a clock change can move.
        performance: 'readonly',
        Math: 'readonly',
        JSON: 'readonly',
        Promise: 'readonly',
        Set: 'readonly',
        Map: 'readonly',
        Array: 'readonly',
        Object: 'readonly',
        String: 'readonly',
        Number: 'readonly',
        Boolean: 'readonly',
        Error: 'readonly',
        process: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      // The other half of the same mistake: a parameter or binding left behind after a
      // refactor. A warning rather than an error — an unused import is untidy, an undefined
      // identifier is a crash.
      'no-unused-vars': ['warn', { args: 'after-used', varsIgnorePattern: '^_' }],
    },
  },
];
