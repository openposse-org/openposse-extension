// Which Chrome window a side panel would open in, readable with no await.
//
// ── Why this has to exist ────────────────────────────────────────────────────────────────────
//
// `chrome.sidePanel.open()` needs a `windowId` and a live user gesture, and those two
// requirements are in direct conflict for the one event that matters.
//
// **A command marked `"global": true` carries no tab.** Chrome passes one only when the browser
// had focus, and it treats a global shortcut as arriving from outside the browser — so ⌥V hands
// the listener `undefined`, every press, as the ordinary path rather than an edge case.
//
// **And the obvious repair does not work.** Looking the window up with `chrome.tabs.query()` is
// an await, and measured on 2026-10-01 the gesture does not survive it:
//
//     sidePanel.open() may only be called in response to a user gesture.
//
// That is the same rule `activeTab` has and `permissions.request()` has, and it is documented at
// length in `panel.js`. There is no synchronous window lookup in the extension API, so the answer
// has to be known *before* the keypress rather than found after it.
//
// ── Why the cache is reliable enough to build on ─────────────────────────────────────────────
//
// MV3 kills an idle worker in ~30 s and a global shortcut is the most likely thing to wake one,
// so a cache filled at startup is exactly the kind of thing that sounds racy. It measured warm:
// `surface.js` does the same and its cold-path line never printed once across a dozen presses,
// including the first after an install. Chrome evaluates the worker's script and lets a storage
// read settle before dispatching the queued event.
//
// So this is filled the same way — a query at startup, kept current by focus events — and the
// worst case is stated plainly rather than guessed at: with nothing remembered, the panel does
// not open and says so.

/** The last normal Chrome window known to have had focus. */
let current = null;

/** Readable with no await, which is the entire point. `null` means we do not know yet. */
export function frontWindowNow() {
  return current;
}

function remember(windowId) {
  // `WINDOW_ID_NONE` is what `onFocusChanged` reports when focus leaves Chrome altogether, and
  // forgetting on it would defeat the whole exercise: the global shortcut's whole purpose is
  // being pressed from another application, which is precisely when that fires.
  if (typeof windowId !== 'number' || windowId === chrome.windows.WINDOW_ID_NONE) return;
  current = windowId;
}

/**
 * Fills the cache from the browser. Call once at worker startup, and do not await it in a handler.
 *
 * A query rather than a stored value: session storage would survive the worker but not a browser
 * restart, and a window id that no longer exists is worse than not knowing — `open()` would fail
 * against a window nobody can see.
 */
export async function hydrate() {
  try {
    const [front] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    remember(front?.windowId);
  } catch {
    // Nothing to read – no windows open, or the query rejected. `null` stands, and the caller
    // reports it rather than pretending.
  }
  return current;
}

/**
 * Keeps it current.
 *
 * **Filtered to `normal` windows, and that filter is load-bearing.** DevTools opens as its own
 * window with its own id and no side panel, so an unfiltered listener would cheerfully remember
 * it the moment anyone opened the worker's console — and the panel would then fail to open for a
 * third reason, while somebody watched the log that caused it.
 */
export function watchFront() {
  chrome.windows.onFocusChanged.addListener(remember, { windowTypes: ['normal'] });
}
