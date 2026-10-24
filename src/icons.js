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
 * as a frame and a ring. `pause` too, because two outlined bars at that size read as `||` in a
 * thin font rather than as a control.
 */
const NODES = {
  play: {
    filled: true,
    nodes: [['path', { d: 'M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z' }]],
  },
  pause: {
    filled: true,
    nodes: [
      ['rect', { x: '14', y: '3', width: '5', height: '18', rx: '1' }],
      ['rect', { x: '5', y: '3', width: '5', height: '18', rx: '1' }],
    ],
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
  // Picking a shared file. It was `upload`, whose arrow rising out of a tray read as Share's.
  'folder-open': {
    nodes: [
      ['path', { d: 'm6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2' }],
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
  'arrow-up-down': {
    nodes: [
      ['path', { d: 'm21 16-4 4-4-4' }],
      ['path', { d: 'M17 20V4' }],
      ['path', { d: 'm3 8 4-4 4 4' }],
      ['path', { d: 'M7 4v16' }],
    ],
  },
  copy: {
    nodes: [
      ['rect', { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' }],
      ['path', { d: 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2' }],
    ],
  },
  // Settings' setup sheet and its import row, taken the same day. Lucide has removed its brand
  // icons, `github` among them, so getting a lasso from GitHub is drawn as a cloud.
  'list-checks': {
    nodes: [
      ['path', { d: 'M13 5h8' }],
      ['path', { d: 'M13 12h8' }],
      ['path', { d: 'M13 19h8' }],
      ['path', { d: 'm3 17 2 2 4-4' }],
      ['path', { d: 'm3 7 2 2 4-4' }],
    ],
  },
  'cloud-download': {
    nodes: [
      ['path', { d: 'M12 13v8l-4-4' }],
      ['path', { d: 'm12 21 4-4' }],
      ['path', { d: 'M4.393 15.269A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.436 8.284' }],
    ],
  },
  moon: {
    nodes: [
      ['path', { d: 'M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401' }],
    ],
  },
  sun: {
    nodes: [
      ['circle', { cx: '12', cy: '12', r: '4' }],
      ['path', { d: 'M12 2v2' }],
      ['path', { d: 'M12 20v2' }],
      ['path', { d: 'm4.93 4.93 1.41 1.41' }],
      ['path', { d: 'm17.66 17.66 1.41 1.41' }],
      ['path', { d: 'M2 12h2' }],
      ['path', { d: 'M20 12h2' }],
      ['path', { d: 'm6.34 17.66-1.41 1.41' }],
      ['path', { d: 'm19.07 4.93-1.41 1.41' }],
    ],
  },
  'audio-waveform': {
    nodes: [
      ['path', { d: 'M2 13a2 2 0 0 0 2-2V7a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0V4a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0v-4a2 2 0 0 1 2-2' }],
    ],
  },
  // The three promises under Settings' intro: on-device, private, in the flow.
  laptop: {
    nodes: [
      ['path', { d: 'M18 5a2 2 0 0 1 2 2v8.526a2 2 0 0 0 .212.897l1.068 2.127a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45l1.068-2.127A2 2 0 0 0 4 15.526V7a2 2 0 0 1 2-2z' }],
      ['path', { d: 'M20.054 15.987H3.946' }],
    ],
  },
  lock: {
    nodes: [
      ['rect', { width: '18', height: '11', x: '3', y: '11', rx: '2', ry: '2' }],
      ['path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' }],
    ],
  },
  // From tag 0.469.0: `waves` is no longer on Lucide's main branch.
  waves: {
    nodes: [
      ['path', { d: 'M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1' }],
      ['path', { d: 'M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1' }],
      ['path', { d: 'M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1' }],
    ],
  },
  // Settings' footer: the project's own links.
  globe: {
    nodes: [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['path', { d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' }],
      ['path', { d: 'M2 12h20' }],
    ],
  },
  'circle-alert': {
    nodes: [
      ['circle', { cx: '12', cy: '12', r: '10' }],
      ['line', { x1: '12', x2: '12', y1: '8', y2: '12' }],
      ['line', { x1: '12', x2: '12.01', y1: '16', y2: '16' }],
    ],
  },
  sparkles: {
    nodes: [
      ['path', { d: 'M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z' }],
      ['path', { d: 'M20 2v4' }],
      ['path', { d: 'M22 4h-4' }],
      ['circle', { cx: '4', cy: '20', r: '2' }],
    ],
  },
  heart: {
    nodes: [
      ['path', { d: 'M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5' }],
    ],
  },
  rocket: {
    nodes: [
      ['path', { d: 'M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5' }],
      ['path', { d: 'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09' }],
      ['path', { d: 'M9 12a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.4 22.4 0 0 1-4 2z' }],
      ['path', { d: 'M9 12H4s.55-3.03 2-4c1.62-1.08 5 .05 5 .05' }],
    ],
  },
  'message-square-heart': {
    nodes: [
      ['path', { d: 'M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z' }],
      ['path', { d: 'M7.5 9.5c0 .687.265 1.383.697 1.844l3.009 3.264a1.14 1.14 0 0 0 .407.314 1 1 0 0 0 .783-.004 1.14 1.14 0 0 0 .398-.31l3.008-3.264A2.77 2.77 0 0 0 16.5 9.5 2.5 2.5 0 0 0 12 8a2.5 2.5 0 0 0-4.5 1.5' }],
    ],
  },
  scale: {
    nodes: [
      ['path', { d: 'M12 3v18' }],
      ['path', { d: 'm19 8 3 8a5 5 0 0 1-6 0zV7' }],
      ['path', { d: 'M3 7h1a17 17 0 0 0 8-2 17 17 0 0 0 8 2h1' }],
      ['path', { d: 'm5 8 3 8a5 5 0 0 1-6 0zV7' }],
      ['path', { d: 'M7 21h10' }],
    ],
  },
  // The footer's socials. X's mark is Simple Icons' (CC0), filled with no stroke like GitHub's.
  // Simple Icons dropped LinkedIn's at LinkedIn's request, so that one is Lucide 0.469.0's
  // outline (ISC) filled, which draws the same solid "in" and so matches the other two marks.
  x: {
    filled: true,
    nodes: [
      ['path', { stroke: 'none', d: 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z' }],
    ],
  },
  linkedin: {
    filled: true,
    nodes: [
      ['path', { d: 'M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z' }],
      ['rect', { width: '4', height: '12', x: '2', y: '9' }],
      ['circle', { cx: '4', cy: '4', r: '2' }],
    ],
  },
  // GitHub's own mark, the octocat in a disc, from Simple Icons (CC0). Lucide has no brand icons
  // now, and its old outline GitHub was not the mark people recognise. Filled with no stroke: the
  // shared outline stroke would thicken it.
  github: {
    filled: true,
    nodes: [
      ['path', { stroke: 'none', d: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12' }],
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
 * never for anything read from a page, a lasso or a file.
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
