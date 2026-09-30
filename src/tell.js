// Sending to the service worker from a page that may have outlived the extension.
//
// **`.catch()` on `chrome.runtime.sendMessage` is a guard that cannot fire.** Reloading or
// updating the extension orphans the content scripts already injected into open tabs: their
// `chrome.runtime` is gone, and the call then throws *synchronously*, before there is a promise
// for `.catch` to attach to. All four page-context call sites had that shape, so an orphaned tab
// reported `Uncaught Error: Extension context invalidated` on its next event and abandoned
// whatever callback it was in the middle of – a recording's `emit`, or an answer mid-stream.
//
// Only pages can be orphaned this way. The popup and the offscreen document die with the
// extension, and the service worker is the extension, so this is for `content.js` and `orb.js`.

/**
 * Whether anyone is left to say it to, said once per page.
 *
 * An orphaned tab keeps emitting for as long as it is open, so the same sentence on every
 * capture is noise rather than a diagnosis. The reason is still shown – it just isn't repeated.
 */
let said = false;

function orphaned() {
  if (!said) {
    said = true;
    console.warn('[openposse] this page is running a previous build of the extension – '
      + 'reload the tab to reconnect');
  }
  return false;
}

/**
 * Sends `message` to the service worker.
 *
 * Returns `true` if it went, `false` if this page has no extension behind it any more. Callers
 * that can carry on regardless may ignore the result; the point is that they get to decide,
 * rather than being unwound by a throw.
 */
export function tell(message) {
  // `chrome.runtime.id` is undefined in an orphaned context, which is the cheap test. The
  // try/catch is what actually holds, since the runtime can go away between these two lines.
  if (!chrome.runtime?.id) return orphaned();
  try {
    // A *rejection* is ordinary and is not this function's problem: MV3 stops the worker after
    // ~30 s idle, and every caller here is already written to survive a lost message.
    chrome.runtime.sendMessage(message).catch(() => {});
    return true;
  } catch {
    return orphaned();
  }
}

/** Test seam: the once-only warning is module state, and each case needs its own. */
export function _resetForTests() {
  said = false;
}
