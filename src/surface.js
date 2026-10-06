// Which surface a turn is shown on: the floating orb, or Chrome's side panel.
//
// E14 ships both so user testing can decide, and this holds the choice. It is a module of its
// own for one reason, and the reason is a trap:
//
// ── The choice has to be readable *synchronously* ──
//
// Both surfaces are gesture-gated and both gestures are spent by an `await`. `activeTab` is
// granted by the keypress and gone by the time an async chain reaches `executeScript` – that is
// documented at length in `panel.js`, and it is why the orb once appeared on Notion and nowhere
// else. `chrome.sidePanel.open()` has the identical rule: called after an await it rejects with
// "may only be called in response to a user gesture".
//
// So the command handler cannot read storage to decide which one to open. It has to already
// know. `surfaceNow()` answers from a cache that `hydrate()` fills at worker startup and
// `chrome.storage.onChanged` keeps current.
//
// **The default is the panel, as of 2026-10-06**, when Settings stopped offering the switch. It
// was `orb`, chosen for a cold cache: MV3 kills an idle worker in ~30 s, so a shortcut can arrive
// while `hydrate()` is still in flight, and the orb was then the behaviour that existed. With no
// switch, a fresh install has nothing stored and no way to reach the panel unless the default is
// the panel. A stored choice still wins once the cache is warm, which in practice is every press.

export const SURFACES = ['orb', 'panel'];
const DEFAULT = 'panel';
const KEY = 'surface';

let current = DEFAULT;
let warm = false;

/** The current surface, readable with no await. Safe before `hydrate()` resolves. */
export function surfaceNow() {
  return current;
}

/**
 * Whether `surfaceNow()` is a *choice* or merely the default.
 *
 * The distinction is invisible at the call site and is the difference between "the user picked
 * the orb" and "we have not read storage yet". A caller cannot act on it – there is still nothing
 * to await – but it can **say** which of the two it is, which is the whole difference between a
 * diagnosable failure and three plausible explanations.
 */
export function surfaceWarm() {
  return warm;
}

/** Fills the cache from storage. Call once at worker startup, and do not await it in a handler. */
export async function hydrate() {
  try {
    const stored = await chrome.storage.local.get(KEY);
    if (SURFACES.includes(stored?.[KEY])) current = stored[KEY];
    warm = true;
  } catch {
    // Storage unreadable: the default stands, which is today's behaviour.
  }
  return current;
}

/** Changes the surface and reports what it became, so a caller never has to re-read. */
export async function setSurface(next) {
  if (!SURFACES.includes(next)) throw new TypeError(`unknown surface: ${next}`);
  current = next;
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/**
 * Keeps the cache current when the setting changes in another context – the panel's own toggle
 * writes storage, and this worker may not be the one that wrote it.
 */
export function watchSurface(onChange) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[KEY]) return;
    const next = changes[KEY].newValue;
    if (!SURFACES.includes(next)) return;
    current = next;
    onChange?.(next);
  });
}
