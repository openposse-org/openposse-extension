// Light or dark, for the side panel and Settings.
//
// **Follows the system until somebody chooses**, then keeps the choice. The choice lives in
// `localStorage` rather than `chrome.storage` for one reason: it has to be readable *before the
// first paint*, and `chrome.storage` only answers asynchronously – so a light-mode user would see
// a dark frame flash on every open. Both pages share the extension's origin, so they share the
// value, and the `storage` event carries a change in one to the other while both are open.
//
// `theme-boot.js` applies it from a blocking script in each page's head; this module does the
// rest once the page's own script runs: the toggle, the T key, and keeping up with changes.
//
// The popup and the in-page orb never set `data-theme`, so they stay dark. Only `[data-theme="light"]`
// changes anything in ui.css.

const KEY = 'openposse.theme';
const SYSTEM_DARK = '(prefers-color-scheme: dark)';
const CHANGED = 'openposse:theme';

/** What a stored value and the system setting come to. Pure, so it is testable without a page. */
export function resolveTheme(stored, systemDark) {
  if (stored === 'light' || stored === 'dark') return stored;
  return systemDark ? 'dark' : 'light';
}

function stored() {
  try {
    return window.localStorage.getItem(KEY);
  } catch (error) {
    // Named rather than swallowed: a page that cannot read its choice falls back to the system,
    // and that should not look like the choice being ignored.
    console.warn('[theme] could not read the stored theme:', error?.message ?? error);
    return null;
  }
}

export function currentTheme() {
  return resolveTheme(stored(), window.matchMedia(SYSTEM_DARK).matches);
}

export function applyTheme(root = document.documentElement) {
  root.dataset.theme = currentTheme();
}

export function setTheme(theme) {
  try {
    window.localStorage.setItem(KEY, theme);
  } catch (error) {
    console.warn('[theme] could not store the theme:', error?.message ?? error);
  }
  applyTheme();
  document.dispatchEvent(new Event(CHANGED));
}

export function toggleTheme() {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

/**
 * Calls `onChange` whenever the theme in force changes: from this page's toggle or key, from the
 * other page, or from the system while nobody has chosen.
 */
export function watchTheme(onChange) {
  const reapply = () => { applyTheme(); onChange(currentTheme()); };
  document.addEventListener(CHANGED, () => onChange(currentTheme()));
  window.addEventListener('storage', (event) => { if (event.key === KEY) reapply(); });
  window.matchMedia(SYSTEM_DARK).addEventListener('change', () => { if (!stored()) reapply(); });
}

/**
 * Whether a key pressed here was typing rather than a shortcut. Takes the event's target, so a
 * T typed into a question, a name or a search box stays a T.
 */
export function isTyping(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** T switches between light and dark, the way linear.app does, unless somebody is typing. */
export function bindThemeKey() {
  document.addEventListener('keydown', (event) => {
    if (event.key !== 't' && event.key !== 'T') return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
    if (isTyping(event.target)) return;
    event.preventDefault();
    toggleTheme();
  });
}
