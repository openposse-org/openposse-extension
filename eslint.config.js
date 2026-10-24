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
    files: ['src/**/*.js', 'tools/**/*.js', 'tools/**/*.mjs', 'test/**/*.mjs'],
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
        // Settings' fixed footer and sticky header: the footer's height for the page's bottom
        // padding, and whether the header is holding at the top.
        ResizeObserver: 'readonly',
        IntersectionObserver: 'readonly',
        // The panel's sphere and the rope loader. The loader stops its loop when its card hides
        // rather than burning 60fps on nothing, which is what `cancelAnimationFrame` is for.
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        // The loudness meter in the offscreen document. `SpeechRecognition` reports no level,
        // so the orb's radius comes from a second capture of the same device through this.
        AudioContext: 'readonly',
        // Supertonic hands back samples, which the offscreen document wraps for the player.
        AudioBuffer: 'readonly',
        Float32Array: 'readonly',
        // Speaking, also in the offscreen document — a service worker has no DOM and so no
        // speech synthesis, and an utterance started in a tab dies when that tab navigates.
        speechSynthesis: 'readonly',
        SpeechSynthesisUtterance: 'readonly',
        // Only ever against `chrome.runtime.getURL` — asking the bundle whether the Kokoro
        // weights are present. **Never a network call**: a runtime fetch of model weights
        // would breach the project's "no third-party model downloads at runtime" rule, so a
        // `fetch` here with an outside host in it is a bug, not a feature.
        fetch: 'readonly',
        // Kokoro's weights: fetched once from setup, verified against a pinned hash, and kept
        // in Cache Storage — large immutable blobs from HTTP, which is what it is for.
        caches: 'readonly',
        Response: 'readonly',
        Uint8Array: 'readonly',
        TextEncoder: 'readonly',
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
        // Sharing a lasso. The file is built in memory on the Settings page and handed to an
        // `<a download>`, so no `downloads` permission is needed and nothing reaches the disk
        // that the user did not click for.
        Blob: 'readonly',
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
        // Not a browser global: `tools/build.mjs` replaces it with true or false at build time,
        // and Settings shows its debug drawer only when it is true.
        DEV_TOOLS: 'readonly',
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
