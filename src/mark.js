// The OpenPosse mark, as inline SVG.
//
// **One copy, imported by both surfaces**, because there are two of them — the popup header and
// the orb's header — and a mark that lives in two files is a mark that will be updated in one.
// It replaced a `linear-gradient(150deg,#0A84FF,#30D158)` tile with "op" in it that had already
// drifted from the shipped icon within a day of the icon changing.
//
// **Inline rather than an `<img>` pointing at a file**, and that is the orb's constraint rather
// than a preference. The orb renders in a closed shadow root inside a vendor's page, so an
// `<img src="chrome-extension://…">` would need the SVG added to `web_accessible_resources` —
// a second web-accessible surface, probeable by any site, to save 1.1 kB. Inlining costs
// nothing and exposes nothing.
//
// Transcribed from `design/assets/openposse-mark.svg` with its C2PA metadata stripped: ~7 kB of
// provenance manifest that belongs with the source artwork, not in a content script injected
// into every granted page. **The artwork is the source — edit the SVG and re-transcribe, do not
// edit the path data here.**
//
// The ids (`op-sunset`, `op-band`) are document-scoped in the popup and shadow-scoped in the
// orb, so the two never meet. Rendering this twice in one document would collide; nothing does.

/**
 * The hat, filling whatever box it is given.
 *
 * `viewBox="0 0 128 128"` is the icon's own square framing, so the header mark and the toolbar
 * icon are the same composition at different sizes rather than two croppings of one drawing.
 * The band is a **mask**, not a painted stroke — it cuts through to whatever is behind, which is
 * what lets a single file sit on both light and dark backgrounds.
 */
export const MARK_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" class="mark" viewBox="0 0 128 128" role="img" aria-label="OpenPosse">
  <defs>
    <linearGradient id="op-sunset" gradientUnits="userSpaceOnUse" x1="112" y1="30" x2="18" y2="96">
      <stop offset="0" stop-color="#FFD36B"/>
      <stop offset="0.28" stop-color="#FFAE3A"/>
      <stop offset="0.52" stop-color="#FF8A1F"/>
      <stop offset="0.76" stop-color="#FF6B1F"/>
      <stop offset="1" stop-color="#E4497A"/>
    </linearGradient>
    <mask id="op-band" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">
      <rect width="128" height="128" fill="#fff"/>
      <path d="M35.9 63 L97.2 63 L97.8 70 L34.1 70 Z" fill="#000"/>
    </mask>
  </defs>
  <path d="M4 87.4 C9 85 13 83.5 17 81.7 C24 78.5 29 76 33.1 74.1 C34.5 64 36.5 52 40.7 43.7 C52 41 62 38.5 72 38.4 C79 38.2 84 38.4 87.2 38.7 C89.5 39.2 91 39.8 92 40.6 C94 44 95.3 48 96 51.6 C97.2 59 97.8 66 98.2 73.5 C103 76 108 78.2 111.9 80.2 C116 82.5 121 85.3 124.3 87.4 C124.6 88.2 124 88.9 123.3 89.1 C110 87 98 85.7 85.3 85.5 C72 85.4 60 85.5 47.3 85.9 C33 86.5 18 88 5.1 89.3 C4.2 89 3.7 88 4 87.4 Z"
        fill="url(#op-sunset)" mask="url(#op-band)"/>
</svg>`.trim();

/**
 * The box it sits in.
 *
 * **22px, not the 19px the tile used.** The tile was a solid block of colour filling its square;
 * the hat is a wide, thin glyph inside a square viewBox, so at 19px its ink is about 15×7 and it
 * reads as a smudge beside 13.5px text. 22 restores the visual weight the header had. No drop
 * shadow — the tile needed one to lift off the glass, and a shape with a cut-out in it collects
 * the shadow inside the cut.
 */
export const MARK_CSS = `
  .mark {
    width: 22px; height: 22px; flex: 0 0 22px;
    display: block; overflow: visible;
  }`;
