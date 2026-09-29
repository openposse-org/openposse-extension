#!/usr/bin/env python3
"""Draws the extension's icons from the app mark in `design/README.md`.

    python3 tools/make-icons.py

**A script rather than four committed PNGs with no provenance.** The mark is specified in the
design record, is already drawn in `orb.js` at 19x19, and the numbers here are transcribed from
that spec rather than matched by eye. Committing only the output would make the next change to
the mark a Photoshop job and the two copies would drift on the first edit.

There was no Mac app icon to reuse. `project.pbxproj` names an `AppIcon` asset catalogue, but
that is Xcode's default template line and the catalogue was never created — so the parked app
shipped the blank default, and `design/README.md`'s "use the real app icon if one exists"
resolves to this placeholder.

Two deliberate departures from the 19px spec, both because a toolbar slot is not a panel
header:

- **The outer drop shadow is dropped.** `0 1px 3px rgba(0,0,0,.4)` needs a background to fall
  on. An extension icon sits on the browser's chrome in either theme, so a baked-in shadow is a
  grey smudge on dark and a halo on light.
- **The "op" is dropped at 16px.** The spec's text is 42% of the tile height (8px in 19px),
  which is 6.7px at 16 — two letters of mush. The toolbar icon also carries the agent's initial
  as a badge on top of it, so text under text is the one thing worth avoiding there.
"""

import math
import pathlib

from PIL import Image, ImageDraw, ImageFont

# ── From design/README.md §Avatars and §Radii ──────────────────────────────────────────────
MARK = 19                       # the size the spec is written at
RADIUS = 6.5 / MARK             # 6.5px corner on a 19px tile
TEXT = 8 / MARK                 # "op" at 8px
FROM, TO = (0x0A, 0x84, 0xFF), (0x30, 0xD1, 0x58)   # #0A84FF -> #30D158
ANGLE = 150                     # linear-gradient(150deg, ...)

# Chrome asks for these four: 16 in menus, 32 on Windows, 48 on the extensions page, 128 in the
# store listing and the install dialog. 128 is the one a human actually looks at.
SIZES = [16, 32, 48, 128]
TEXT_FROM = 32                  # below this the letters are noise, see the module docstring

SS = 8                          # supersample, then LANCZOS down — gives the radius clean edges
OUT = pathlib.Path(__file__).resolve().parent.parent / 'icons'

FONTS = [
    ('/System/Library/Fonts/SFNS.ttf', 'Bold'),          # San Francisco, what the design uses
    ('/System/Library/Fonts/Supplemental/Arial Bold.ttf', None),
]


def gradient(size):
    """CSS `linear-gradient(150deg, …)`, computed the way CSS defines it rather than corner-to-
    corner. 0deg points up and angles run clockwise, so the direction vector is (sin, -cos) in
    screen coordinates, and the gradient *line* is long enough for the box's corners to reach
    the end stops — |W·sin| + |H·cos|. Getting that length wrong is why a hand-rolled gradient
    usually looks flatter than the CSS it copies."""
    rad = math.radians(ANGLE)
    dx, dy = math.sin(rad), -math.cos(rad)
    length = abs(size * dx) + abs(size * dy)
    centre = size / 2

    image = Image.new('RGB', (size, size))
    pixels = image.load()
    for y in range(size):
        for x in range(size):
            t = ((x + 0.5 - centre) * dx + (y + 0.5 - centre) * dy) / length + 0.5
            t = min(1.0, max(0.0, t))
            pixels[x, y] = tuple(round(a + (b - a) * t) for a, b in zip(FROM, TO))
    return image


def load_font(px):
    """The bold face, and it says which one it got.

    **The first version swallowed a failed `set_variation_by_name`.** San Francisco is a
    variable font, so without the Bold axis it renders Regular at the same size — the spec says
    700, the output would say 400, and nothing anywhere would mention it. Measured: the axis
    changes the ink width of "op" from 109 to 118 at 100px, which is visible and would have been
    put down to the downsample. A weight that silently degrades is the whole shape of bug this
    project keeps re-learning, so it is reported rather than caught."""
    problems = []
    for path, variation in FONTS:
        try:
            font = ImageFont.truetype(path, px)
        except OSError as error:
            problems.append(f'{path}: {error}')
            continue

        if variation:
            try:
                font.set_variation_by_name(variation)
            except Exception as error:
                # Not fatal — the next entry is a static bold face — but never silent.
                problems.append(f'{path}: no "{variation}" axis ({error})')
                continue
        return font, f'{pathlib.Path(path).name}{f" {variation}" if variation else ""}'

    raise SystemExit('no usable bold font:\n  ' + '\n  '.join(problems))


def draw(size):
    big = size * SS
    icon = gradient(big).convert('RGBA')

    # The rounded corner is a mask rather than a drawn shape, so the gradient is clipped by it
    # instead of being painted over — no seam where a stroke meets the fill.
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, big - 1, big - 1], radius=RADIUS * big, fill=255,
    )
    icon.putalpha(mask)

    # `inset 0 .5px 0 rgba(255,255,255,.5)` — the top light that makes the tile read as a
    # surface rather than a swatch. Scaled with the icon, so it survives the downsample.
    light = max(1, round(0.5 / MARK * big))
    overlay = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(overlay).rounded_rectangle(
        [0, 0, big - 1, big - 1], radius=RADIUS * big,
        outline=(255, 255, 255, 128), width=light,
    )
    # Only the top edge of that stroke is wanted, so the bottom half is cut away.
    overlay.paste((0, 0, 0, 0), (0, big // 2, big, big))
    icon.alpha_composite(overlay)

    face = None
    if size >= TEXT_FROM:
        font, face = load_font(round(TEXT * big))
        pen = ImageDraw.Draw(icon)
        left, top, right, bottom = pen.textbbox((0, 0), 'op', font=font)
        # Centred on the glyphs' own ink box, not on the font's line box: "op" has no ascender
        # and no descender, so line-box centring sits it visibly low.
        pen.text(
            ((big - (right - left)) / 2 - left, (big - (bottom - top)) / 2 - top),
            'op', font=font, fill=(255, 255, 255, 255),
        )

    return icon.resize((size, size), Image.LANCZOS), face


def main():
    OUT.mkdir(exist_ok=True)
    for size in SIZES:
        path = OUT / f'icon-{size}.png'
        icon, face = draw(size)
        icon.save(path, optimize=True)
        print(f'{path.relative_to(OUT.parent)}  {path.stat().st_size} bytes'
              f'  {face or "no text at this size"}')


if __name__ == '__main__':
    main()
