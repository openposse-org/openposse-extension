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

    // Synthetic, with the per-mode floors the design specifies so an idle orb still breathes.
    // **The design asks for the real mic RMS here** — "so a dead mic can never look healthy" —
    // which needs an AnalyserNode alongside the recogniser in the offscreen document. Deferred
    // rather than forgotten: the honest half of that promise, the `dead` state, is driven by
    // real signals already (see `modeFor`), so a mic that is not granted or has failed reads
    // as dead rather than as a healthy idle orb.
    const amp = mode === 'speak' ? 0.80 + 0.16 * Math.sin(t / 13) + 0.09 * Math.sin(t / 4.1)
      : mode === 'agent' ? 0.58 + 0.16 * Math.sin(t / 9.5) + 0.10 * Math.sin(t / 3.3)
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
      opacity: 0; transform: translateX(-50%) translateY(8px);
      transition: opacity .22s ease, transform .22s cubic-bezier(.22,1,.36,1);
    }
    .wrap.up { opacity: 1; transform: translateX(-50%) translateY(0); }

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

    header { display: flex; align-items: center; gap: 9px; }
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
    draw(canvas, t, modeFor(state.phase), state.channel ?? 'none');
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

  function armDismiss(phase) {
    clearTimeout(dismiss);
    if (phase === 'answering' || phase === 'needs-attention' || phase === 'not-capturing') {
      dismiss = setTimeout(() => show(false), DISMISS_MS);
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.kind !== 'openposse.orb') return false;
    state = { ...state, ...message.state };
    render();
    show(message.state.visible ?? visible);
    armDismiss(state.phase);
    return false;
  });

  render();
}
