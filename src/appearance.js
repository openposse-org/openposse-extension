// The two appearance controls: light or dark, and the orb's shape. Shared by the side panel and
// Settings, so the toggle looks and answers the same on both.

import { icon } from './icons.js';
import { bindThemeKey, currentTheme, setTheme, watchTheme } from './theme.js';

/**
 * A small row of icon buttons with one pressed, as linear.app draws its theme switch. Returns a
 * function that presses whichever option matches a value, for changes made somewhere else.
 *
 * Each button's `aria-label` is also its hover label, through each page's own tooltip rule.
 */
export function segmented(host, { label, options, value, onPick }) {
  host.classList.add('segmented');
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', label);
  const buttons = options.map((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'seg';
    button.dataset.value = option.value;
    button.dataset.tipAt = 'start';
    button.dataset.tipBelow = '';
    button.setAttribute('aria-label', option.label);
    button.append(icon(option.icon, { size: 15 }));
    button.addEventListener('click', () => onPick(option.value));
    host.append(button);
    return button;
  });
  const show = (current) => {
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(button.dataset.value === current));
    }
  };
  show(value);
  return show;
}

/** The light/dark switch, kept in step with the T key, the other page and the system. */
export function mountThemeToggle(host) {
  const show = segmented(host, {
    label: 'Theme',
    options: [
      { value: 'dark', icon: 'moon', label: 'Dark (T)' },
      { value: 'light', icon: 'sun', label: 'Light (T)' },
    ],
    value: currentTheme(),
    onPick: setTheme,
  });
  watchTheme(show);
  bindThemeKey();
}
