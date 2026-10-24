// The orb itself: 520 points on a Fibonacci sphere, a rim stroked three times, and nothing else.
// Or, chosen in Settings since 2026-10-13, the same instrument as layered strands – `drawWave`.
//
// Ported verbatim from `design/README.md`'s `draw()`/`points()`/`lut()` rather than re-derived.
// The two non-obvious parts are commented where they are, and are worth keeping: the halo's
// inner stop must be transparent or the face floods with colour, and the rim is stroked three
// times at falling blur and rising opacity because that is what makes it bloom rather than read
// as a drawn circle.
//
// ── Why this is a module, when E14 says not to share a renderer ──────────────────────────────
//
// The milestone's corollary is explicit: **do not build one state model feeding two renderers**,
// because that is the right architecture for two permanent surfaces and the wrong one for a
// fallback with a scheduled death. That rule held – `orb.js` and `sidepanel.js` each kept
// their own state, their own DOM and their own render pass, so the orb was deleted whole on
// 2026-10-24 and this stayed with the panel.
//
// This is not that. It is a function of `(canvas, time, mode, tint, level)` with no DOM beyond
// the canvas it is handed and no knowledge of which surface called it. It is artwork, not
// architecture, and it was lifted rather than copied for one reason: 150 lines of canvas
// mathematics duplicated into a second file is 150 lines where a fix can land in one copy. When
// a surface is deleted, one import line goes with it.
//
// **It is not quite stateless, and the exception is worth stating rather than discovering.** The
// eased amplitude, luminance and tint strength live on the canvas object (`cv.__amp` and friends,
// alongside the 2D context that was always cached there), because easing is a property of a thing
// being animated rather than of the caller animating it. Two canvases drawing the same turn ease
// independently, which is right: one of them may have been hidden for the first half of it.
//
// Two changes from the in-orb version. `level` is a parameter rather than a pair of closure
// variables, and `null` means *there is no meter*, which is a different thing from a silent room
// and must not look the same – see the amplitude note below. And the drawing constants were
// reconciled against the landing page's own orb (`op-landing`, hero A) on 2026-10-01: the dot
// scale, the amplitude clamp, the point distribution and the rim's stop count had all drifted in
// the port, each of them in the direction of a flatter sphere.

/** The outer bloom. Off – see the note where it is drawn. */
const SHOW_HALO = false;

const PAL = [[255, 122, 24], [255, 63, 216], [138, 92, 255], [34, 216, 255], [196, 242, 255], [255, 122, 24]];
let POINTS = null;

function points() {
  if (POINTS) return POINTS;
  // **`(i + .5) / N`, not `i / (N - 1)`.** The offset form is the standard Fibonacci sphere and
  // keeps both poles off the exact ±1 axis; the other puts one point dead on each, where the
  // ring maths degenerates and the wobble has no lateral component to act on.
  const N = 520, out = [], ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i += 1) {
    const y = 1 - (2 * (i + 0.5)) / N;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = ga * i;
    out.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  POINTS = out;
  return out;
}

function hexArr(h) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h || '');
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
}

/** The untinted rim: 72 steps around the palette, computed once because it never changes. */
const BASE = (() => {
  const N = 72, out = [];
  for (let i = 0; i < N; i += 1) {
    const p = (i / N) * (PAL.length - 1);
    const a = Math.floor(p), b = Math.min(PAL.length - 1, a + 1), f = p - a;
    out.push([0, 1, 2].map((k) => PAL[a][k] + (PAL[b][k] - PAL[a][k]) * f));
  }
  return out;
})();

/**
 * The rim with the agent's channel mixed in, at strength `mix`.
 *
 * **Built per frame rather than cached per tint, and the reason is the easing below.** `mix`
 * now moves continuously from 0 to 1 as a turn acquires an agent, so a cache keyed on the hex
 * alone would hand back whatever strength happened to be current when that agent first drew.
 * It is 72 interpolations a frame against 520 `fillRect`s, which is not where the time goes.
 */
function lut(tint, mix) {
  const m = mix > 0.002 ? hexArr(tint) : null;
  const s = [], raw = [];
  for (const base of BASE) {
    const c = m ? base.map((v, k) => v + (m[k] - v) * 0.58 * mix) : base;
    raw.push(c);
    s.push(c.map(Math.round).join(','));
  }
  return { s, raw };
}

/**
 * Moves a canvas's own copy of a value toward a target, and returns where it got to.
 *
 * The state lives on the canvas for the same reason the 2D context does: this stays a function
 * of what it is handed, and the thing being animated is the one holding the animation. Two
 * canvases drawing the same turn ease independently, which is correct – one may have been
 * hidden for the first half of it.
 */
function toward(cv, key, target, rate) {
  const now = cv[key];
  cv[key] = now === undefined ? target : now + (target - now) * rate;
  return cv[key];
}

/**
 * Sizes the canvas to its box and clears it, or returns null for a canvas with no size yet.
 *
 * **Additive on a dark page, painted over on a light one.** `lighter` is what makes the dots and
 * the rim bloom where they overlap, the way light adds up on a screen. On a light page the same
 * blend runs every colour toward white, which is the page, so the shape fades into it.
 */
function prepare(cv, light) {
  const r = cv.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const cx = cv.__cx || (cv.__cx = cv.getContext('2d'));
  const d = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(r.width * d) || cv.height !== Math.round(r.height * d)) {
    cv.width = Math.round(r.width * d);
    cv.height = Math.round(r.height * d);
  }
  cx.setTransform(d, 0, 0, d, 0, 0);
  cx.clearRect(0, 0, r.width, r.height);
  cx.globalCompositeOperation = light ? 'source-over' : 'lighter';
  return { cx, w: r.width, h: r.height, d };
}

/**
 * How big, how bright and how tinted this frame is. **Shared by the sphere and the waveform**, so
 * the two shapes are one instrument drawn two ways: the same microphone, the same voice, the same
 * easing between states.
 */
function motion(cv, { t, mode, tint, level }) {
  const hasLevel = typeof level === 'number';
  const shown = hasLevel ? level : 0;

  // **While listening, the radius is the microphone**, which is what the design asks for and
  // why: "so a dead mic can never look healthy." The synthetic curve below drew the same
  // confident sphere whether or not anything was being heard – breaking the promise in
  // precisely the case it exists for, a granted, connected, silent microphone.
  //
  // The floor is kept, so silence still breathes rather than collapsing: a quiet room sits
  // near 0.24 against a synthetic 0.80, which is the visible difference between "listening"
  // and "hearing you".
  //
  // A **null** level is not a quiet room – it is a browser or a device that cannot give us a
  // meter – so it falls back to the synthetic curve rather than drawing a permanently dead orb.
  const target = mode === 'speak'
    ? (hasLevel
      ? Math.min(1.05, 0.22 + 0.04 * Math.sin(t / 28) + 0.85 * shown)
      : 0.80 + 0.16 * Math.sin(t / 13) + 0.09 * Math.sin(t / 4.1))
    // An answering agent moves with its own speech for the same reason a listening orb moves
    // with yours – otherwise it is an animation that happens to be playing while a voice
    // happens to be talking, and the two drift apart within a sentence. The floor is higher
    // than the microphone's because there is no silence to represent: an agent that is
    // speaking is always saying something.
    : mode === 'agent'
      ? (hasLevel
        ? Math.min(1.05, 0.42 + 0.06 * Math.sin(t / 9.5) + 0.60 * shown)
        : 0.58 + 0.16 * Math.sin(t / 9.5) + 0.10 * Math.sin(t / 3.3))
      : mode === 'think' ? 0.26 + 0.07 * Math.sin(t / 20)
        : mode === 'dead' ? 0
          : 0.13 + 0.04 * Math.sin(t / 28);

  // **Eased toward, not jumped to.** This is the hero's own treatment and the one difference a
  // still image cannot show: a turn moving listening → thinking → answering glides rather than
  // snapping between three sizes and two brightnesses. The rates are the hero's.
  //
  // The amplitude eases faster when a meter is live, because the caller has already smoothed
  // that signal and a second lag stacked on it is lag a person can feel. The radius is supposed
  // to *be* the microphone: a sluggish one says "listening" where a prompt one says "hearing
  // you", and telling those two apart is the whole reason the meter drives the radius at all.
  const amp = toward(cv, '__amp', target, hasLevel ? 0.4 : 0.12);
  const lum = toward(cv, '__lum', mode === 'dead' ? 0.18 : mode === 'rest' ? 0.5 : mode === 'think' ? 0.72 : 1, 0.06);

  // The channel fades in as a turn acquires an agent, rather than the sphere changing colour
  // between one frame and the next. `dead` is its own grey and is always at full strength – it
  // is a state rather than an identity, so there is nothing for it to fade in from.
  const grey = mode === 'dead';
  const mix = toward(cv, '__mix', grey || hexArr(tint) ? 1 : 0, grey ? 0.12 : 0.05);

  return { amp, lum, L: lut(grey ? '#8E8E93' : tint, mix) };
}

/**
 * One frame.
 *
 * @param cv     the canvas. Sized from its own bounding box, so CSS owns the dimensions.
 * @param t      a frame counter, incremented by the caller. Drives every oscillation here.
 * @param mode   `speak` | `agent` | `think` | `dead` | `rest`.
 * @param tint   the agent's channel colour as `#rrggbb`, or anything unparseable for none.
 * @param level  0–1 from a real meter, or **null when there is no meter at all**.
 * @param light  whether the page behind is light – see `prepare`.
 */
export function drawSphere(cv, { t, mode, tint, level = null, light = false }) {
  const frame = prepare(cv, light);
  if (!frame) return;
  const { cx, w, h, d } = frame;
  const ox = w / 2, oy = h / 2;
  const { amp, lum, L } = motion(cv, { t, mode, tint, level });

  const R = Math.min(w, h) * 0.232 * (0.93 + 0.13 * amp);

  // Diffuse halo – **off by request, 2026-09-26.**
  //
  // A deliberate departure from a design marked high-fidelity, so it is a switch rather than
  // a deletion: the bloom reaches 2.05R, roughly doubling the panel's visual footprint over
  // somebody else's page, and on screen it read as a second ring around the sphere rather
  // than as light coming off it. The rim's own three passes already bloom.
  //
  // Kept because judging it needs to be done against a real page in both states, and
  // re-deciding costs one word here.
  if (SHOW_HALO) {
    // The inner stop **must** be transparent: a radial gradient's inner radius is a plateau,
    // so anything inside it floods the core, and the reference's face is near-black.
    const hg = cx.createRadialGradient(ox, oy, R * 0.55, ox, oy, R * 2.05);
    hg.addColorStop(0, 'rgba(0,0,0,0)');
    hg.addColorStop(0.62, `rgba(${L.s[18]},${0.30 * lum})`);
    hg.addColorStop(0.78, `rgba(${L.s[50]},${0.13 * lum})`);
    hg.addColorStop(1, 'rgba(0,0,0,0)');
    cx.fillStyle = hg;
    cx.beginPath(); cx.arc(ox, oy, R * 2.05, 0, 6.2832); cx.fill();
  }

  if (mode !== 'dead') {
    const pts = points();
    // **A dot's size scales with the sphere, and the port had it fixed.** The reference draws at
    // 168px, so `k` is how much bigger than that this canvas is – without it a 320px orb is the
    // same 520 one-pixel dots spread over three times the area, which is why a larger orb read
    // as *dimmer* rather than larger and sent the last round looking at the glow instead.
    //
    // It also replaces the decimation it sits where: halving the point count below 160px made a
    // narrow panel's orb sparse, where shrinking the dots keeps it the same sphere, smaller.
    // 1× displays get a touch less, because a 1px dot is already heavier than it means to be.
    const k = (Math.min(w, h) / 168) * (d > 1 ? 1 : 0.8);
    const a = t * 0.0075, ca = Math.cos(a), sa = Math.sin(a);
    const ct = Math.cos(0.34), st = Math.sin(0.34);
    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i];
      const x = p[0] * ca + p[2] * sa, zr = -p[0] * sa + p[2] * ca;
      const y = p[1] * ct - zr * st, z = p[1] * st + zr * ct;
      const wob = 1 + 0.14 * amp * Math.sin(p[1] * 6 + t * 0.06)
        + 0.07 * amp * Math.sin(p[0] * 7 - t * 0.045);
      const px = ox + x * R * wob, py = oy + y * R * wob;
      // Clamped, because the wobble can push a point past the unit sphere and `rim` is a 2.5
      // power – unclamped, a loud syllable makes the silhouette flare rather than swell.
      const rad = Math.min(1.3, x * x + y * y);
      const rim = rad * rad * Math.sqrt(rad);
      const depth = (z + 1) / 2;
      const al = (0.07 + 0.8 * rim) * (0.3 + 0.7 * depth) * lum;
      if (al < 0.015) continue;
      const idx = (((Math.atan2(y, x) + Math.PI) / 6.2832) * 72 + t * 0.12) | 0;
      const s = (0.9 + 1.7 * rim * depth) * k;
      cx.fillStyle = `rgba(${L.s[idx % 72]},${Math.min(1, al)})`;
      cx.fillRect(px - s / 2, py - s / 2, s, s);
    }
  }

  const grad = () => {
    const g = cx.createConicGradient
      ? cx.createConicGradient(t * 0.004, ox, oy)
      : cx.createLinearGradient(ox - R, oy - R, ox + R, oy + R);
    // Thirteen stops, not seven. Seven quantises the rim into visible bands at the blurred
    // passes, where the point cloud behind it is continuous – so the two read as two objects.
    for (let i = 0; i <= 12; i += 1) {
      const c = L.raw[Math.min(71, Math.round((i / 12) * 71))];
      g.addColorStop(i / 12, `rgb(${c.map(Math.round).join(',')})`);
    }
    return g;
  };
  const ring = (lw, alpha, blur) => {
    cx.save();
    if (blur && cx.filter !== undefined) cx.filter = `blur(${blur}px)`;
    cx.globalAlpha = alpha * lum;
    cx.lineWidth = lw;
    cx.strokeStyle = grad();
    cx.beginPath(); cx.arc(ox, oy, R * 1.055, 0, 6.2832); cx.stroke();
    cx.restore();
  };
  ring(R * 0.22, 0.34, R * 0.30);
  ring(R * 0.11, 0.5, R * 0.10);
  ring(R * 0.035, 0.92, 0);
}

/**
 * The strands of the waveform: how many times each crosses the line, how fast it travels, how
 * tall it is against the others, and where it starts. Uneven on purpose – strands at even
 * multiples line up into one braid every few seconds, and these never quite do.
 */
const STRANDS = [
  { waves: 1.5, speed: 0.052, height: 1, phase: 0 },
  { waves: 2.2, speed: -0.038, height: 0.74, phase: 1.9 },
  { waves: 3.1, speed: 0.063, height: 0.52, phase: 3.7 },
  { waves: 1.1, speed: -0.029, height: 0.6, phase: 5.2 },
];

/**
 * The same instrument as `drawSphere`, drawn as layered strands across the canvas.
 *
 * Height is the sphere's radius by another name: `motion` hands both the same eased amplitude, so
 * while listening it is the microphone and while answering it is the agent's voice, and a dead
 * microphone lies flat rather than drawing a healthy wave. Each strand is pinned to the line at
 * both ends and swells in the middle, so the wave reads as one sound rather than a cropped
 * stretch of an endless one.
 *
 * Same parameters as `drawSphere`, so a caller switches shape by switching function.
 */
export function drawWave(cv, { t, mode, tint, level = null, light = false }) {
  const frame = prepare(cv, light);
  if (!frame) return;
  const { cx, w, h } = frame;
  const { amp, lum, L } = motion(cv, { t, mode, tint, level });

  const mid = h / 2;
  const edge = w * 0.04;
  const span = w - edge * 2;
  // The tallest a strand gets at full voice, from the line to its crest. `amp` runs to about 1.05,
  // so a loud syllable reaches most of the way to the canvas's edge without touching it.
  const reach = h * 0.4;
  const step = 2;

  // The palette across the line rather than around a rim, drifting at the rim's own pace.
  const paint = () => {
    const g = cx.createLinearGradient(edge, 0, w - edge, 0);
    for (let i = 0; i <= 12; i += 1) {
      const c = L.raw[Math.round((i / 12) * 71 + t * 0.12) % 72];
      g.addColorStop(i / 12, `rgb(${c.map(Math.round).join(',')})`);
    }
    return g;
  };

  const strand = ({ waves, speed, height, phase }) => {
    cx.beginPath();
    for (let x = 0; x <= span; x += step) {
      const u = x / span;
      const pinned = Math.sin(Math.PI * u) ** 2;
      const y = mid + reach * amp * height * pinned * Math.sin(u * waves * 6.2832 + t * speed + phase);
      if (x === 0) cx.moveTo(edge + x, y);
      else cx.lineTo(edge + x, y);
    }
  };

  // Two passes per strand, as the rim takes three: a wide blurred one for the glow and a fine
  // crisp one on top, so the strands bloom rather than reading as drawn lines.
  const stroke = ({ height }, width, alpha, blur) => {
    cx.save();
    if (blur && cx.filter !== undefined) cx.filter = `blur(${blur}px)`;
    cx.globalAlpha = Math.min(1, alpha * (0.45 + 0.55 * height) * lum);
    cx.lineWidth = width;
    cx.lineCap = 'round';
    cx.lineJoin = 'round';
    cx.strokeStyle = paint();
    cx.stroke();
    cx.restore();
  };

  const scale = Math.max(1, h / 128);
  for (const s of STRANDS) {
    strand(s);
    stroke(s, 5 * scale, 0.32, 4 * scale);
    stroke(s, 1.6 * scale, 0.9, 0);
  }
}

/** The design's six states, mapped from the loop's own vocabulary. Shared because it is a table. */
export function modeFor(phase) {
  switch (phase) {
    case 'listening': return 'speak';
    case 'thinking': return 'think';
    case 'answering': return 'agent';
    case 'not-capturing': return 'dead';
    default: return 'rest';          // routing, needs-attention, idle
  }
}
