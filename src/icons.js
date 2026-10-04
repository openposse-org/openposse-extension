// Icons, from Lucide.
//
// **Path data copied in rather than the package vendored, and that is the same decision
// `vendor/NOTICE.md` records for transformers.js.** Chrome loads the whole unpacked directory
// and reports its size, so a dependency that unpacks to megabytes of icons nobody renders is
// charged to the extension in full – the same mistake that had this extension reading 437 MB
// until `node_modules` came out. An icon costs one line here and nothing at all if it is unused.
//
// [Lucide](https://lucide.dev) is ISC-licensed, and its licence travels with this file at
// `vendor/lucide/LICENSE` – which also carries Feather's MIT notice, because a hundred or so
// Lucide icons are derived from Feather and `chevron-right` below is one of them. Both licences
// ask only that the notice is kept, so copying the geometry is exactly what they permit.
//
// **Taken verbatim from `lucide-icons/lucide` on 2026-10-04**, not redrawn. A hand-approximated
// triangle is not Lucide's triangle, and a set that is "mostly Lucide" stops matching the moment
// anybody adds a real one beside it.
//
// ## Adding one
//
// `curl https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/<name>.svg`, then put
// its `d` attributes in `PATHS` under the same name Lucide uses. Keep Lucide's name: renaming it
// to something that reads better here is how the next person fails to find the icon they want.

/**
 * Lucide's own frame. These are what make a Lucide icon look like one, so they are set here
 * rather than left to each call site to remember.
 */
const BOX = 24;

/**
 * `d` attributes per icon, plus whether the shape is meant to be filled.
 *
 * **`filled` exists for `play` and shapes like it.** Lucide draws everything as an outline, which
 * is right at 24px and wrong at 13: an outlined triangle in a 26px button reads as a hollow
 * arrow rather than a play control. Filling it with the same colour as the stroke gives the solid
 * rounded triangle the slot actually wants, which is how Lucide's own docs suggest handling it.
 */
const PATHS = {
  play: {
    filled: true,
    d: ['M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z'],
  },
  'chevron-right': { d: ['m9 18 6-6-6-6'] },
  'loader-circle': { d: ['M21 12a9 9 0 1 1-6.219-8.56'] },
};

/** Every name this module knows, so a caller can check rather than discover at render time. */
export const ICONS = Object.keys(PATHS);

function spec(name) {
  const found = PATHS[name];
  // **Named, not swallowed.** An icon that silently renders nothing is a button with no label,
  // and the only clue would be a gap – so a typo says what it was and what exists instead.
  if (!found) throw new Error(`no icon named "${name}" – have: ${ICONS.join(', ')}`);
  return found;
}

/**
 * One icon as an SVG element.
 *
 * `currentColor` throughout, so an icon takes the colour of whatever it sits in and a hover rule
 * on the button is all it takes to light it up. Sized in CSS pixels on the element itself rather
 * than by a class, because the same icon is 13px in a voice row and 16px in a header and neither
 * should have to invent a modifier for it.
 *
 * `aria-hidden`, always: an icon is never the label. A button carrying one needs its own
 * `aria-label`, and an icon that announced itself would make that a duplicate.
 */
export function icon(name, { size = 16, className = '', strokeWidth = 2 } = {}) {
  const { d, filled } = spec(name);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');

  svg.setAttribute('viewBox', `0 0 ${BOX} ${BOX}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', filled ? 'currentColor' : 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);

  for (const path of d) {
    const node = document.createElementNS(ns, 'path');
    node.setAttribute('d', path);
    svg.append(node);
  }
  return svg;
}

/**
 * The same icon as markup, for the surfaces that build their DOM as strings.
 *
 * `orb.js` and the panel assemble whole templates in one literal, and handing those an element
 * would mean a second pass to insert it. Same table, same attributes, so the two cannot drift –
 * which is the only reason it is worth having a second entry point at all.
 *
 * The geometry is looked up rather than interpolated, so an unknown `name` throws instead of
 * reaching the output. `className` is interpolated, so it is for literals in our own source –
 * never for anything read from a page, a recipe or a file.
 */
export function iconMarkup(name, { size = 16, className = '', strokeWidth = 2 } = {}) {
  const { d, filled } = spec(name);
  const paths = d.map((path) => `<path d="${path}"/>`).join('');
  return `<svg viewBox="0 0 ${BOX} ${BOX}" width="${size}" height="${size}" `
    + `fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" `
    + `stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" `
    + `aria-hidden="true"${className ? ` class="${className}"` : ''}>${paths}</svg>`;
}
