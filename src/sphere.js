// The orb itself: 520 points on a Fibonacci sphere, a rim stroked three times, and nothing else.
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
// fallback with a scheduled death. That rule is intact – `orb.js` and `sidepanel.js` each keep
// their own state, their own DOM and their own render pass, and they duplicate each other freely.
//
// This is not that. It is a pure function of `(canvas, time, mode, tint, level)` with no state,
// no DOM beyond the canvas it is handed, and no knowledge of which surface called it. It is
// artwork, not architecture, and it was lifted rather than copied for one reason: 150 lines of
// canvas mathematics duplicated into a second file is 150 lines where a fix can land in one copy.
// When a surface is deleted, one import line goes with it.
//
// The one real change from the in-orb version: `level` is a parameter rather than a pair of
// closure variables. `null` means *there is no meter*, which is a different thing from a silent
// room and must not look the same – see the amplitude note below.

/** The outer bloom. Off – see the note where it is drawn. */
const SHOW_HALO = false;

const PAL = [[255, 122, 24], [255, 63, 216], [138, 92, 255], [34, 216, 255], [196, 242, 255], [255, 122, 24]];
const LUTS = {};
let POINTS = null;

function points() {
  if (POINTS) return POINTS;
  const N = 520, out = [], ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < N; i += 1) {
    const y = 1 - (i / (N - 1)) * 2;
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

/** 72 steps around the rim, and the one place the agent's channel colour is mixed in. */
function lut(tint) {
  if (LUTS[tint]) return LUTS[tint];
  const mix = hexArr(tint), N = 72, arr = [], raw = [];
  for (let i = 0; i < N; i += 1) {
    const p = (i / N) * (PAL.length - 1);
    const a = Math.floor(p), b = Math.min(PAL.length - 1, a + 1), f = p - a;
    let c = [0, 1, 2].map((k) => PAL[a][k] + (PAL[b][k] - PAL[a][k]) * f);
    if (mix) c = c.map((v, k) => v * 0.42 + mix[k] * 0.58);
    raw.push(c);
    arr.push(c.map(Math.round).join(','));
  }
  LUTS[tint] = { s: arr, raw };
  return LUTS[tint];
}

/**
 * One frame.
 *
 * @param cv     the canvas. Sized from its own bounding box, so CSS owns the dimensions.
 * @param t      a frame counter, incremented by the caller. Drives every oscillation here.
 * @param mode   `speak` | `agent` | `think` | `dead` | `rest`.
 * @param tint   the agent's channel colour as `#rrggbb`, or anything unparseable for none.
 * @param level  0–1 from a real meter, or **null when there is no meter at all**.
 */
export function drawSphere(cv, { t, mode, tint, level = null }) {
  const r = cv.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const cx = cv.__cx || (cv.__cx = cv.getContext('2d'));
  const d = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(r.width * d) || cv.height !== Math.round(r.height * d)) {
    cv.width = Math.round(r.width * d);
    cv.height = Math.round(r.height * d);
  }
  cx.setTransform(d, 0, 0, d, 0, 0);
  const w = r.width, h = r.height, ox = w / 2, oy = h / 2;
  cx.clearRect(0, 0, w, h);
  cx.globalCompositeOperation = 'lighter';

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
  const amp = mode === 'speak'
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
  const lum = mode === 'dead' ? 0.18 : mode === 'rest' ? 0.5 : mode === 'think' ? 0.72 : 1;

  const R = Math.min(w, h) * 0.232 * (0.93 + 0.13 * amp);
  const L = lut(mode === 'dead' ? '#8E8E93' : tint);

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
    const pts = points(), step = w < 160 ? 2 : 1;
    const a = t * 0.0075, ca = Math.cos(a), sa = Math.sin(a);
    const ct = Math.cos(0.34), st = Math.sin(0.34);
    for (let i = 0; i < pts.length; i += step) {
      const p = pts[i];
      const x = p[0] * ca + p[2] * sa, zr = -p[0] * sa + p[2] * ca;
      const y = p[1] * ct - zr * st, z = p[1] * st + zr * ct;
      const wob = 1 + 0.14 * amp * Math.sin(p[1] * 6 + t * 0.06)
        + 0.07 * amp * Math.sin(p[0] * 7 - t * 0.045);
      const px = ox + x * R * wob, py = oy + y * R * wob;
      const rad = x * x + y * y;
      const rim = rad * rad * Math.sqrt(rad);
      const depth = (z + 1) / 2;
      const al = (0.07 + 0.8 * rim) * (0.3 + 0.7 * depth) * lum;
      if (al < 0.015) continue;
      const idx = (((Math.atan2(y, x) + Math.PI) / 6.2832) * 72 + t * 0.12) | 0;
      const s = 0.9 + 1.7 * rim * depth;
      cx.fillStyle = `rgba(${L.s[idx % 72]},${al})`;
      cx.fillRect(px - s / 2, py - s / 2, s, s);
    }
  }

  const grad = () => {
    const g = cx.createConicGradient
      ? cx.createConicGradient(t * 0.004, ox, oy)
      : cx.createLinearGradient(ox - R, oy - R, ox + R, oy + R);
    for (let i = 0; i <= 6; i += 1) {
      const c = L.raw[Math.min(71, Math.round((i / 6) * 71))];
      g.addColorStop(i / 6, `rgb(${c.map(Math.round).join(',')})`);
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
