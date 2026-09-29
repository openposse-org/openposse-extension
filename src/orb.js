// The summon panel, floating over whatever page you are on.
//
// A transposition of `design/README.md`, not a reinvention — the colours, spacing, motion
// timings and the orb algorithm are specified there as final, and the renderer below is ported
// from `draw()`/`points()`/`lut()` in the design file rather than re-derived.
//
// **It lives in a shadow root, and that is structural.** This markup sits inside the vendor's
// document, where their stylesheet has the same origin advantage over ours that popup.html's
// `.mic-fix { display: block }` had over `[hidden]` — one `div { margin: 0 }` in Notion's CSS
// and the panel is silently wrong. A closed shadow root is the only boundary CSS cannot cross,
// and it costs nothing here because nothing outside needs to style this.
//
// Injected per turn rather than registered as a content script: the panel belongs over the tab
// you are *looking at*, which is usually not a vendor's tab and so is not an origin we hold a
// permission for. Pressing the shortcut grants `activeTab` for exactly that tab, for exactly
// as long as this needs.

if (!globalThis.__openposseOrb) {
  globalThis.__openposseOrb = true;

  // ── The orb renderer ─────────────────────────────────────────────────────────────────────
  //
  // Ported verbatim from the design file's logic class. The comments there explain the two
  // non-obvious parts and are worth keeping: the halo's inner stop must be transparent or the
  // face floods with colour, and the rim is stroked three times at falling blur and rising
  // opacity because that is what makes it bloom rather than read as a drawn circle.

  /** The outer bloom. Off — see the note where it is drawn. */
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

  function draw(cv, t, mode, tint) {
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

    // **While listening, the radius is the microphone**, which is what the design asks for and
    // why: "so a dead mic can never look healthy." The synthetic curve below drew the same
    // confident sphere whether or not anything was being heard — breaking the promise in
    // precisely the case it exists for, a granted, connected, silent microphone.
    //
    // The floor is kept, so silence still breathes rather than collapsing: a quiet room sits
    // near 0.24 against a synthetic 0.80, which is the visible difference between "listening"
    // and "hearing you". `shown` eases toward the reported level, because the meter arrives at
    // 20 Hz and this runs at 60.
    //
    // Every other mode stays synthetic. `agent` becomes the TTS output level at E5, by the same
    // argument and through the same channel.
    const amp = mode === 'speak'
      ? (hasLevel
        ? Math.min(1.05, 0.22 + 0.04 * Math.sin(t / 28) + 0.85 * shown)
        : 0.80 + 0.16 * Math.sin(t / 13) + 0.09 * Math.sin(t / 4.1))
      // An answering agent moves with its own speech for the same reason a listening orb moves
      // with yours — otherwise it is an animation that happens to be playing while a voice
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

    // Diffuse halo — **off by request, 2026-09-26.**
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

  // ── The panel ────────────────────────────────────────────────────────────────────────────

  const CSS = `
    :host { all: initial; }
    .wrap {
      position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%);
      z-index: 2147483647;
      width: 452px;
      font: 400 13px/1.45 -apple-system, "SF Pro Text", system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
      color: #fff;
      /* Not hit-testable except where it has to be. The page underneath stays usable, which
         matters because the panel sits over someone else's application. */
      pointer-events: none;
      /* The --dx/--dy properties are where the panel has been dragged to. Composed into the
         transform rather than switching to explicit left/top, so the centring and the entry
         animation keep working and a drag stays a pure offset from where the design put it.
         (No backticks in this block: the whole stylesheet is a JS template literal.) */
      opacity: 0;
      transform: translateX(calc(-50% + var(--dx, 0px))) translateY(calc(8px + var(--dy, 0px)));
      transition: opacity .22s ease, transform .22s cubic-bezier(.22,1,.36,1);
    }
    .wrap.up {
      opacity: 1;
      transform: translateX(calc(-50% + var(--dx, 0px))) translateY(var(--dy, 0px));
    }
    /* The easing is what makes the panel arrive nicely and what would make it lag a pointer,
       so it is off for the duration of a drag only. */
    .wrap.dragging { transition: opacity .22s ease; }

    .glass {
      position: relative;
      border-radius: 32px;
      padding: 15px 18px 16px;
      background:
        linear-gradient(150deg, rgba(255,255,255,.155), rgba(255,255,255,.05)),
        rgba(20,20,23,.82);
      backdrop-filter: blur(44px) saturate(190%);
      -webkit-backdrop-filter: blur(44px) saturate(190%);
      box-shadow:
        0 34px 74px rgba(0,0,0,.6), 0 3px 12px rgba(0,0,0,.34),
        inset 0 1px 0 rgba(255,255,255,.42),
        inset 0 -1px 0 rgba(255,255,255,.08),
        inset 0 0 0 .5px rgba(255,255,255,.17);
    }
    /* Sheen, explicitly not hit-testable — it covers the whole panel. */
    .glass::after {
      content: ''; position: absolute; inset: 0; border-radius: 32px; pointer-events: none;
      background: linear-gradient(114deg, rgba(255,255,255,.12) 0%, transparent 30%,
                  transparent 72%, rgba(255,255,255,.045) 100%);
    }

    /* The title bar is the handle. It opts into hit-testing, which the rest of the card does
       not — so the page underneath stays usable everywhere except the strip you grab. */
    header {
      display: flex; align-items: center; gap: 9px;
      pointer-events: auto; cursor: grab; user-select: none; touch-action: none;
    }
    .wrap.dragging header { cursor: grabbing; }
    .mark {
      width: 19px; height: 19px; border-radius: 6.5px;
      background: linear-gradient(150deg, #0A84FF, #30D158);
      display: grid; place-items: center;
      font-size: 8px; font-weight: 700; color: #fff;
      box-shadow: inset 0 .5px 0 rgba(255,255,255,.5), 0 1px 3px rgba(0,0,0,.4);
    }
    .title { font-size: 13.5px; font-weight: 600; letter-spacing: -.008em; }
    .spacer { flex: 1; }
    .key {
      font-family: "SF Mono", ui-monospace, SFMono-Regular, monospace;
      font-size: 10.5px; color: rgba(235,235,245,.58);
    }

    .orbwrap {
      position: relative; display: flex; flex-direction: column; align-items: center;
      margin: -4px 0 0;
      pointer-events: auto; cursor: pointer;
    }
    canvas { width: 168px; height: 168px; display: block; }
    .deadmic {
      position: absolute; bottom: 14px;
      font-family: "SF Mono", ui-monospace, monospace;
      font-size: 9.5px; letter-spacing: .06em; color: #FF453A;
      background: rgba(255,69,58,.12);
      box-shadow: inset 0 0 0 .5px rgba(255,69,58,.4);
      border-radius: 7px; padding: 4px 9px;
    }

    .transcript {
      min-height: 48px; margin-top: -8px; padding: 0 6px; text-align: center;
      font-size: 17px; line-height: 1.34; letter-spacing: -.011em;
      text-wrap: pretty;
    }
    .volatile { color: rgba(235,235,245,.52); }
    .caret {
      display: inline-block; width: 2px; height: 16px; vertical-align: -2px;
      background: #fff; opacity: .9; margin-left: 1px;
      animation: blink 1.1s steps(2) infinite;
    }
    @keyframes blink { 50% { opacity: 0; } }

    .divider { height: .5px; background: rgba(255,255,255,.14); margin: 14px 0 12px; }

    .roster { display: flex; gap: 10px; align-items: center; min-height: 36px; }
    .avatars { display: flex; gap: 9px; }
    .avatar {
      width: 34px; height: 34px; border-radius: 50%;
      display: grid; place-items: center;
      font-size: 14px; font-weight: 600; color: #fff;
      background: color-mix(in srgb, var(--channel) 42%, rgba(255,255,255,.1));
      box-shadow: inset 0 .5px 0 rgba(255,255,255,.45), inset 0 0 0 .5px rgba(255,255,255,.18);
      opacity: .42;
      pointer-events: auto; cursor: pointer;
    }
    .avatar.lit {
      opacity: 1;
      box-shadow: inset 0 .5px 0 rgba(255,255,255,.45),
                  0 0 0 1.5px var(--channel),
                  0 0 14px color-mix(in srgb, var(--channel) 55%, transparent);
    }
    .status {
      margin-left: auto; font-size: 12px; color: rgba(235,235,245,.6);
      display: flex; align-items: center; gap: 7px;
    }
    .status.tinted { color: var(--channel); }
    .status.bad { color: #FF453A; }
    .pulse {
      width: 6px; height: 6px; border-radius: 50%; background: currentColor;
      animation: breathe 1.3s ease-in-out infinite;
    }
    @keyframes breathe {
      0%, 100% { opacity: .3; transform: scale(.7); }
      50% { opacity: 1; transform: scale(1); }
    }

    .answer { min-height: 52px; padding-top: 11px; }
    .bubble {
      border-radius: 15px; padding: 11px 13px;
      font-size: 14.5px; line-height: 1.47; color: #fff;
      background: rgba(255,255,255,.075);
      box-shadow: inset 0 .5px 0 rgba(255,255,255,.22), inset 0 0 0 .5px rgba(255,255,255,.1);
      animation: rise .34s cubic-bezier(.22,1,.36,1);
      max-height: 168px; overflow-y: auto;
      pointer-events: auto;
    }
    @keyframes rise { from { opacity: 0; transform: translateY(5px); } }
    .sub { font-size: 12px; color: rgba(235,235,245,.55); margin-top: 4px; }

    /* ── Recording ──────────────────────────────────────────────────────────────────────── */
    /* The card is the same glass and the same type as a turn; only the contents differ. The
       person is standing in the vendor's page being coached, and a surface that looked like a
       different product would read as having left OpenPosse behind. */
    .coach { padding: 2px 0 4px; }
    .coach .step {
      font: 600 9.5px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: .08em; color: rgba(235,235,245,.42); margin-bottom: 10px;
    }
    .coach .say { font-size: 14px; line-height: 1.45; color: rgba(255,255,255,.92); }
    .coach .say.bad { color: #FF453A; }
    .coach .list { margin-top: 14px; display: flex; flex-direction: column; gap: 7px; }
    .coach .row { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
    .coach .row .tick { color: #30D158; font-size: 11px; }
    .coach .row .label { color: rgba(235,235,245,.55); flex: 0 0 92px; }
    .coach .row .detail {
      font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: rgba(255,255,255,.75); overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; flex: 1 1 auto;
    }
    /* A shortcut is something you pressed, not page structure, so it is not a code chip. */
    .coach .row .detail.keys { font-family: inherit; font-size: 13px; letter-spacing: .12em; }
    /* **Opted back in.** The wrap is pointer-events: none so the page underneath stays usable,
       and every interactive part has to say otherwise for itself. Without this the field is
       visible, looks focusable, and every click lands in the vendor's page behind it — which
       reads as the panel being frozen rather than as it not being there. */
    .coach .name { margin-top: 14px; display: flex; gap: 8px; pointer-events: auto; }
    .coach .name input {
      flex: 1 1 auto; background: rgba(255,255,255,.08); color: #fff;
      border: .5px solid rgba(255,255,255,.18); border-radius: 8px;
      padding: 8px 10px; font: inherit; font-size: 14px; outline: none;
    }
    .coach .name input:focus { border-color: rgba(255,255,255,.4); }
    .coach .name button {
      background: rgba(255,255,255,.14); color: #fff; border: none; border-radius: 8px;
      padding: 8px 14px; font: inherit; font-size: 13px; font-weight: 590; cursor: pointer;
    }
    .coach .name button:disabled { opacity: .35; cursor: default; }
  `;

  const host = document.createElement('div');
  // `closed`, not `open`: nothing outside needs to reach in, and a closed root cannot be
  // queried by the page either — this panel shows what someone said, and the page it happens
  // to be sitting over has no business reading it.
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>${CSS}</style>
    <div class="wrap" part="wrap">
      <div class="glass">
        <header>
          <div class="mark">op</div>
          <div class="title">OpenPosse</div>
          <div class="spacer"></div>
          <div class="key"></div>
        </header>
        <div class="orbwrap">
          <canvas width="168" height="168"></canvas>
          <div class="deadmic" hidden>NOT HEARING ANYTHING — CHECK INPUT</div>
        </div>
        <div class="transcript"></div>
        <div class="divider"></div>
        <div class="roster">
          <div class="avatars"></div>
          <div class="status"></div>
        </div>
        <div class="answer"></div>
        <div class="coach" hidden>
          <div class="step"></div>
          <div class="say"></div>
          <div class="list"></div>
          <div class="name" hidden>
            <input type="text" placeholder="Give it a name" maxlength="24"
                   autocomplete="off" spellcheck="false">
            <button disabled>Add</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.documentElement.append(host);

  const $ = (sel) => root.querySelector(sel);
  const wrap = $('.wrap');
  const canvas = $('canvas');

  // ── State ────────────────────────────────────────────────────────────────────────────────

  let state = { phase: 'idle', agents: [], agentName: null, channel: null, transcript: '', volatile: '', answer: '', sub: '', message: '', shortcut: '' };
  let visible = false;
  let t = 0;
  let raf = null;

  /**
   * The microphone level: where it is, where it is heading, and whether there is one at all.
   *
   * `hasLevel` stays false until a reading arrives, so a browser or a device that cannot give
   * us a meter falls back to the synthetic curve rather than drawing a permanently dead orb.
   * An absent meter is not a silent room, and they must not look the same.
   */
  let shown = 0;
  let target = 0;
  let hasLevel = false;

  /** The design's six states, mapped from the loop's own vocabulary. */
  function modeFor(phase) {
    switch (phase) {
      case 'listening': return 'speak';
      case 'thinking': return 'think';
      case 'answering': return 'agent';
      case 'not-capturing': return 'dead';
      default: return 'rest';          // routing, needs-attention, idle
    }
  }

  function tick() {
    t += 1;
    // **Nothing is drawn while recording**, because the canvas is hidden behind the coaching
    // card and a recording lasts minutes. Sixty frames a second of an invisible sphere is real
    // CPU taken from the vendor's own page, at exactly the moment somebody is trying to use it.
    // The loop itself keeps running so the orb is animating again the instant it reappears.
    if (state.phase !== 'recording') {
      // Eased here rather than smoothed harder at the source: the meter already has the
      // design's 80 ms attack and 250 ms release, and this only bridges 20 Hz of messages to
      // 60 Hz of frames. Doing it twice would add lag somebody would read as the orb being slow.
      shown += (target - shown) * 0.25;
      draw(canvas, t, modeFor(state.phase), state.channel ?? 'none');
    }
    raf = requestAnimationFrame(tick);
  }

  function show(on) {
    if (on === visible) return;
    visible = on;
    wrap.classList.toggle('up', on);
    if (on && raf === null) raf = requestAnimationFrame(tick);
    // Rendering stops when the panel is hidden, per the design's performance note. A 60fps
    // canvas on someone else's page is not something to leave running.
    if (!on && raf !== null) { cancelAnimationFrame(raf); raf = null; }
  }

  const STATUS = {
    listening: () => ({ text: 'Listening' }),
    routing: () => ({ text: "Working out who that's for…", pulse: true }),
    thinking: (s) => ({ text: `${s.agentName} is thinking…`, pulse: true, tinted: true }),
    answering: (s) => ({ text: `${s.agentName} answered`, tinted: true }),
    'needs-attention': () => ({ text: 'Needs attention', bad: true }),
    'not-capturing': () => ({ text: 'No input', bad: true }),
    idle: () => ({ text: '' }),
  };

  function render() {
    $('.key').textContent = state.shortcut ?? '';

    // **Recording takes the whole card**, because it is a different activity rather than a
    // different turn state: there is no transcript, no roster to re-route to, and an orb
    // pulsing at a microphone nobody is speaking into would be an animation pretending to be
    // an instrument. `renderCoach` returns early for that reason.
    const recording = state.phase === 'recording';
    for (const part of ['.orbwrap', '.transcript', '.divider', '.roster', '.answer']) {
      $(part).hidden = recording;
    }
    $('.coach').hidden = !recording;
    if (recording) return renderCoach();

    // Transcript: committed white, the tail the recogniser is still revising dimmed, and a
    // caret only while actually listening.
    const tr = $('.transcript');
    tr.textContent = '';
    if (state.transcript) tr.append(document.createTextNode(state.transcript));
    if (state.volatile) {
      const v = document.createElement('span');
      v.className = 'volatile';
      v.textContent = state.volatile;
      tr.append(v);
    }
    if (state.phase === 'listening') {
      const caret = document.createElement('span');
      caret.className = 'caret';
      tr.append(caret);
    }

    const avatars = $('.avatars');
    avatars.textContent = '';
    for (const agent of state.agents) {
      const holdsFloor = agent.name === state.agentName;
      const a = document.createElement('div');
      a.className = `avatar${holdsFloor ? ' lit' : ''}`;
      a.style.setProperty('--channel', agent.channel);
      a.textContent = agent.initial;
      // Re-routing to whoever is already answering is a no-op, so it does not offer itself as
      // one: no pointer, no click. The design says the click is ignored in that case, and a
      // button that looks pressable and is ignored is worse than one that does not.
      a.title = holdsFloor ? `${agent.name} has the floor` : `Ask ${agent.name} instead`;
      if (!holdsFloor) {
        a.addEventListener('click', () => {
          chrome.runtime.sendMessage({ kind: 'openposse.orb.reroute', agentName: agent.name })
            .catch(() => {});
        });
      } else {
        a.style.cursor = 'default';
      }
      avatars.append(a);
    }

    const look = (STATUS[state.phase] ?? STATUS.idle)(state);
    const status = $('.status');
    status.className = `status${look.tinted ? ' tinted' : ''}${look.bad ? ' bad' : ''}`;
    if (state.channel) status.style.setProperty('--channel', state.channel);
    status.textContent = '';
    if (look.pulse) {
      const dot = document.createElement('div');
      dot.className = 'pulse';
      status.append(dot);
    }
    status.append(document.createTextNode(state.message || look.text));

    $('.deadmic').hidden = state.phase !== 'not-capturing';

    const answer = $('.answer');
    answer.textContent = '';
    if (state.answer) {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = state.answer;
      answer.append(bubble);
      if (state.sub) {
        const sub = document.createElement('div');
        sub.className = 'sub';
        sub.textContent = state.sub;
        answer.append(sub);
      }
    }
  }

  /**
   * The wizard, drawn from what `coaching.js` decided.
   *
   * Nothing here judges anything — the step, the sentence and the tick-list all arrive in the
   * patch. That is the same split the Mac side had, and the reason it is worth keeping is that
   * the rules are testable without a window and this is not.
   */
  function renderCoach() {
    const coach = state.coach ?? {};

    $('.coach .step').textContent = coach.label ?? '';

    const say = $('.coach .say');
    say.textContent = coach.instruction ?? '';
    say.classList.toggle('bad', coach.bad === true);

    // **Every capture stays on screen once it is made.** Confirmation is the whole reason the
    // list exists: somebody who cannot see that their shortcut registered will press it again,
    // and on a toggle the second press closes the assistant and records the wrong thing.
    const list = $('.coach .list');
    list.textContent = '';
    for (const row of coach.captures ?? []) {
      const el = document.createElement('div');
      el.className = 'row';

      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.textContent = '✓';

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = row.label;

      const detail = document.createElement('span');
      detail.className = `detail${row.isKeys ? ' keys' : ''}`;
      detail.textContent = row.detail;
      // The full selector on hover, since the row truncates and a truncated selector is not
      // something anyone can check.
      if (!row.isKeys) detail.title = row.detail;

      el.append(tick, label, detail);
      list.append(el);
    }

    const naming = $('.coach .name');
    naming.hidden = !coach.naming;
    if (coach.naming && document.activeElement !== host) {
      const input = naming.querySelector('input');
      // Focused once, not on every patch: re-focusing mid-typing would move the caret to the
      // end of what somebody is halfway through writing.
      if (!input.dataset.focused) {
        input.dataset.focused = '1';
        input.focus();
      }
    }
  }

  // ── Moving it out of the way ────────────────────────────────────────────────────────────
  //
  // The panel sits over somebody else's application, and where it sits is sometimes exactly
  // where they need to look — during a recording especially, since the whole task is reading
  // and clicking the page underneath.
  //
  // The offset is kept in `chrome.storage.local`, which is **ours**: the panel is injected
  // fresh on every turn, so a position held in a variable would be forgotten between them, and
  // writing to the page's own `localStorage` would leave our furniture in a vendor's storage.
  {
    const header = $('header');
    let dx = 0;
    let dy = 0;
    let grab = null;

    const apply = () => {
      wrap.style.setProperty('--dx', `${Math.round(dx)}px`);
      wrap.style.setProperty('--dy', `${Math.round(dy)}px`);
    };

    /**
     * Keeps the panel reachable.
     *
     * Dragging something entirely off screen is easy and there is no way back — the panel has
     * no chrome of its own to drag it home by, and a recording in progress would be stranded
     * with it. So at least a corner stays on screen, measured from where the panel actually is
     * rather than from where it was designed to be.
     */
    const clamp = () => {
      const rect = wrap.getBoundingClientRect();
      const width = rect.width || 452;
      const height = rect.height || 400;
      const restLeft = (window.innerWidth - width) / 2;
      const restTop = window.innerHeight - 40 - height;
      const keep = 80;

      dx = Math.min(Math.max(dx, keep - width - restLeft), window.innerWidth - keep - restLeft);
      // Upward is bounded by the top of the viewport; downward by keeping the header visible,
      // since the header is the only part you can grab.
      dy = Math.min(Math.max(dy, -restTop), window.innerHeight - 48 - restTop);
    };

    chrome.storage?.local?.get('orbOffset').then(({ orbOffset }) => {
      if (!orbOffset) return;
      dx = orbOffset.dx ?? 0;
      dy = orbOffset.dy ?? 0;
      clamp();                      // the window may be a different size than last time
      apply();
    }).catch(() => { /* no stored position is the normal first case, not a failure */ });

    header.addEventListener('pointerdown', (event) => {
      grab = { x: event.clientX - dx, y: event.clientY - dy };
      header.setPointerCapture(event.pointerId);
      wrap.classList.add('dragging');
      // Or the gesture starts a text selection across the title, which then drags instead.
      event.preventDefault();
    });

    header.addEventListener('pointermove', (event) => {
      if (!grab) return;
      dx = event.clientX - grab.x;
      dy = event.clientY - grab.y;
      clamp();
      apply();
    });

    const release = (event) => {
      if (!grab) return;
      grab = null;
      wrap.classList.remove('dragging');
      try { header.releasePointerCapture(event.pointerId); } catch { /* already released */ }
      chrome.storage?.local?.set({ orbOffset: { dx, dy } })
        .catch((error) => console.warn('[openposse] panel position not saved —', error));
    };

    header.addEventListener('pointerup', release);
    header.addEventListener('pointercancel', release);
  }

  // ── Naming ─────────────────────────────────────────────────────────────────────────────
  //
  // A text field in the panel, which the Mac app could not have: the summon panel was never
  // key by construction (D16), so it could not receive a keystroke. A closed shadow root has no
  // such constraint, and keeping the name here means the recording never leaves the page it
  // was made on.
  {
    const input = $('.coach .name input');
    const button = $('.coach .name button');
    const trimmed = () => input.value.trim();
    const submit = () => {
      if (!trimmed()) return;
      button.disabled = true;
      chrome.runtime
        .sendMessage({ kind: 'openposse.record.name', name: trimmed() })
        .catch(() => { button.disabled = false; });
    };

    // Whitespace is not a name.
    input.addEventListener('input', () => { button.disabled = trimmed() === ''; });
    input.addEventListener('keydown', (event) => {
      // The page never sees these keystrokes: this input is inside a closed shadow root, and
      // stopping propagation keeps a vendor's own global shortcut handler out of the way of
      // somebody typing "Ivan".
      event.stopPropagation();
      if (event.key === 'Enter') submit();
    });
    button.addEventListener('click', submit);
  }

  // Clicking the orb re-arms listening, per the design. The one control the panel has.
  $('.orbwrap').addEventListener('click', () => {
    chrome.runtime.sendMessage({ kind: 'openposse.listen.toggle' }).catch(() => {});
  });

  // Terminal phases fade themselves out after the design's idle beat.
  //
  // **Owned here rather than by the worker**, because MV3 kills an idle service worker after
  // ~30 seconds and a `setTimeout` there would sometimes never fire — leaving a panel parked
  // over someone else's page with no way to dismiss it. A timer in the page cannot be killed
  // by the worker's lifecycle.
  const DISMISS_MS = 6500;
  let dismiss = null;
  let speaking = false;

  function armDismiss(phase) {
    clearTimeout(dismiss);
    // **Never while the agent is still talking.** The answer is read aloud after the panel
    // reaches `answering`, and a shortened sentence can easily outlast 6.5 seconds — so the
    // panel would fade out mid-word, taking the text with it. The timer restarts from the end
    // of speech instead, which is when someone actually has the answer.
    if (speaking) return;
    if (phase === 'answering' || phase === 'needs-attention' || phase === 'not-capturing') {
      dismiss = setTimeout(() => show(false), DISMISS_MS);
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    // Its own branch, before the state merge and returning early: this arrives 20 times a
    // second, and letting it fall through to `render()` would rebuild the avatars, the status
    // line and the answer bubble each time, to move a sphere's radius.
    if (message?.kind === 'openposse.orb.level') {
      target = message.level;
      hasLevel = true;
      return false;
    }
    if (message?.kind === 'openposse.orb.speaking') {
      speaking = message.speaking === true;
      // **Cancelled, not merely suppressed.** `armDismiss` refuses to *start* a timer while
      // speaking, but the answer arrives before the voice does — so the timer was already
      // running by the time this said "an agent is talking", and the guard had nothing to
      // stop. The panel faded out mid-sentence.
      if (speaking) clearTimeout(dismiss);
      else armDismiss(state.phase);
      return false;
    }
    if (message?.kind !== 'openposse.orb') return false;
    state = { ...state, ...message.state };
    // A new turn starts from silence. Without this the orb opens at whatever the last one
    // ended on, which reads as it hearing something before anyone has spoken.
    if (message.state.phase === 'listening') { shown = 0; target = 0; hasLevel = false; }
    render();
    show(message.state.visible ?? visible);
    armDismiss(state.phase);
    return false;
  });

  render();
}
