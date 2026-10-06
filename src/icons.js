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
// `curl https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/<name>.svg`, then copy
// each element inside it into `NODES` as `[tag, attributes]`, under the same name Lucide uses.
// Keep Lucide's name: renaming it to something that reads better here is how the next person
// fails to find the icon they want.

/**
 * Lucide's own frame. These are what make a Lucide icon look like one, so they are set here
 * rather than left to each call site to remember.
 */
const BOX = 24;

/**
 * The elements of each icon, plus whether the shape is meant to be filled.
 *
 * **`[tag, attributes]`, which is Lucide's own icon-node format** – the shape its JavaScript
 * packages ship. It was a list of `d` strings while every icon here happened to be paths, and
 * Lucide also draws with `rect` and `circle`: `mic` is a rect, `settings` ends in a circle.
 * Converting those to paths by hand is the redrawing this file exists to avoid, so the table
 * holds the elements as the SVG has them, attribute for attribute.
 *
 * **`filled` exists for `play` and shapes like it.** Lucide draws everything as an outline, which
 * is right at 24px and wrong at 13: an outlined triangle in a 26px button reads as a hollow
 * arrow rather than a play control. Filling it with the same colour as the stroke gives the solid
 * rounded triangle the slot actually wants, which is how Lucide's own docs suggest handling it.
 * `square` and `circle` are filled for the same reason, as Stop and Record: outlined, they read
 * as a frame and a ring.
 */
const NODES = {
  play: {
    filled: true,
    nodes: [['path', { d: 'M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z' }]],
  },
  'chevron-right': { nodes: [['path', { d: 'm9 18 6-6-6-6' }]] },
  'loader-circle': { nodes: [['path', { d: 'M21 12a9 9 0 1 1-6.219-8.56' }]] },
  mic: {
    nodes: [
      ['path', { d: 'M12 19v3' }],
      ['path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2' }],
      ['rect', { x: '9', y: '2', width: '6', height: '13', rx: '3' }],
    ],
  },
  square: { filled: true, nodes: [['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }]] },
  circle: { filled: true, nodes: [['circle', { cx: '12', cy: '12', r: '10' }]] },
  keyboard: {
    nodes: [
      ['path', { d: 'M10 8h.01' }],
      ['path', { d: 'M12 12h.01' }],
      ['path', { d: 'M14 8h.01' }],
      ['path', { d: 'M16 12h.01' }],
      ['path', { d: 'M18 8h.01' }],
      ['path', { d: 'M6 8h.01' }],
      ['path', { d: 'M7 16h10' }],
      ['path', { d: 'M8 12h.01' }],
      ['rect', { width: '20', height: '16', x: '2', y: '4', rx: '2' }],
    ],
  },
  'send-horizontal': {
    nodes: [
      ['path', { d: 'M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.842 7.627a.498.498 0 0 0 .682.627l18-8.5a.5.5 0 0 0 0-.904z' }],
      ['path', { d: 'M6 12h16' }],
    ],
  },
  settings: {
    nodes: [
      ['path', { d: 'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915' }],
      ['circle', { cx: '12', cy: '12', r: '3' }],
    ],
  },
  bug: {
    nodes: [
      ['path', { d: 'M12 20v-9' }],
      ['path', { d: 'M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z' }],
      ['path', { d: 'M14.12 3.88 16 2' }],
      ['path', { d: 'M21 21a4 4 0 0 0-3.81-4' }],
      ['path', { d: 'M21 5a4 4 0 0 1-3.55 3.97' }],
      ['path', { d: 'M22 13h-4' }],
      ['path', { d: 'M3 21a4 4 0 0 1 3.81-4' }],
      ['path', { d: 'M3 5a4 4 0 0 0 3.55 3.97' }],
      ['path', { d: 'M6 13H2' }],
      ['path', { d: 'm8 2 1.88 1.88' }],
      ['path', { d: 'M9 7.13V6a3 3 0 1 1 6 0v1.13' }],
    ],
  },
  'panel-right': {
    nodes: [
      ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }],
      ['path', { d: 'M15 3v18' }],
    ],
  },
  orbit: {
    nodes: [
      ['path', { d: 'M20.341 6.484A10 10 0 0 1 10.266 21.85' }],
      ['path', { d: 'M3.659 17.516A10 10 0 0 1 13.74 2.152' }],
      ['circle', { cx: '12', cy: '12', r: '3' }],
      ['circle', { cx: '19', cy: '5', r: '2' }],
      ['circle', { cx: '5', cy: '19', r: '2' }],
    ],
  },
  stethoscope: {
    nodes: [
      ['path', { d: 'M11 2v2' }],
      ['path', { d: 'M5 2v2' }],
      ['path', { d: 'M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1' }],
      ['path', { d: 'M8 15a6 6 0 0 0 12 0v-3' }],
      ['circle', { cx: '20', cy: '10', r: '2' }],
    ],
  },
  'key-round': {
    nodes: [
      ['path', { d: 'M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z' }],
      ['circle', { cx: '16.5', cy: '7.5', r: '.5', fill: 'currentColor' }],
    ],
  },
  // Settings' controls, taken 2026-10-06. Lucide has since renamed `trash-2` to `trash`, so the
  // name here is the current one rather than the one older docs use.
  eye: {
    nodes: [
      ['path', { d: 'M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0' }],
      ['circle', { cx: '12', cy: '12', r: '3' }],
    ],
  },
  share: {
    nodes: [
      ['path', { d: 'M12 2v13' }],
      ['path', { d: 'm16 6-4-4-4 4' }],
      ['path', { d: 'M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8' }],
    ],
  },
  'rotate-ccw': {
    nodes: [
      ['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }],
      ['path', { d: 'M3 3v5h5' }],
    ],
  },
  trash: {
    nodes: [
      ['path', { d: 'M10 11v6' }],
      ['path', { d: 'M14 11v6' }],
      ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' }],
      ['path', { d: 'M3 6h18' }],
      ['path', { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }],
    ],
  },
  download: {
    nodes: [
      ['path', { d: 'M12 15V3' }],
      ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
      ['path', { d: 'm7 10 5 5 5-5' }],
    ],
  },
  upload: {
    nodes: [
      ['path', { d: 'M12 3v12' }],
      ['path', { d: 'm17 8-5-5-5 5' }],
      ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
    ],
  },
  info: {
    nodes: [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['path', { d: 'M12 16v-4' }],
      ['path', { d: 'M12 8h.01' }],
    ],
  },
  plus: { nodes: [['path', { d: 'M5 12h14' }], ['path', { d: 'M12 5v14' }]] },
  check: { nodes: [['path', { d: 'M20 6 9 17l-5-5' }]] },
  copy: {
    nodes: [
      ['rect', { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' }],
      ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }],
    ],
  },
};

/** Every name this module knows, so a caller can check rather than discover at render time. */
export const ICONS = Object.keys(NODES);

function spec(name) {
  const found = NODES[name];
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
  const { nodes, filled } = spec(name);
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

  for (const [tag, attributes] of nodes) {
    const node = document.createElementNS(ns, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
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
  const { nodes, filled } = spec(name);
  const parts = nodes
    .map(([tag, attributes]) => {
      const pairs = Object.entries(attributes).map(([key, value]) => `${key}="${value}"`);
      return `<${tag} ${pairs.join(' ')}/>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${BOX} ${BOX}" width="${size}" height="${size}" `
    + `fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" `
    + `stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" `
    + `aria-hidden="true"${className ? ` class="${className}"` : ''}>${parts}</svg>`;
}
