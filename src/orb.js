// The summon panel, floating over whatever page you are on.
//
// A transposition of `design/README.md`, not a reinvention – the colours, spacing, motion
// timings and the orb algorithm are specified there as final, and the renderer below is ported
// from `draw()`/`points()`/`lut()` in the design file rather than re-derived.
//
// **It lives in a shadow root, and that is structural.** This markup sits inside the vendor's
// document, where their stylesheet has the same origin advantage over ours that popup.html's
// `.mic-fix { display: block }` had over `[hidden]` – one `div { margin: 0 }` in Notion's CSS
// and the panel is silently wrong. A closed shadow root is the only boundary CSS cannot cross,
// and it costs nothing here because nothing outside needs to style this.
//
// Injected per turn rather than registered as a content script: the panel belongs over the tab
// you are *looking at*, which is usually not a vendor's tab and so is not an origin we hold a
// permission for. Pressing the shortcut grants `activeTab` for exactly that tab, for exactly
// as long as this needs.

// Top level, not inside the guard below: an `import` declaration cannot sit in a block. esbuild
// folds it into the IIFE, so the shipped content script is still one file.
import { MARK_SVG, MARK_CSS } from './mark.js';
import { tell } from './tell.js';
import { drawSphere, modeFor } from './sphere.js';

// **The sentinel is set at the end of this block, not here.** Claiming success before doing the
// work meant a throw anywhere below left the page asserting an orb it does not have: every later
// injection saw the flag, did nothing, and said nothing, so fixing the extension changed nothing
// for that tab until the page itself was reloaded. That is precisely what the stray backtick did
// – the flag was set on the first line and the throw came four hundred lines later, which turned
// one broken build into tabs that stayed broken after it was fixed.
//
// Safe to defer because this block is synchronous throughout: the bundle is `format: iife`, which
// forbids top-level await, so a second injection cannot interleave with a first still running.
if (!globalThis.__openposseOrb) {

  // ── The orb renderer lives in `sphere.js` ────────────────────────────────────────────────
  //
  // Lifted there at E14 so the side panel draws the same sphere rather than a second copy of
  // its mathematics. It is a pure function and this file is still the only thing that owns the
  // orb's *state* – see the note at the top of that module for why this is not the shared
  // renderer E14's corollary forbids.

  // ── The typeface ─────────────────────────────────────────────────────────────────────────

  /** Registered once per page, not once per panel. */
  let fontRegistered = false;

  /**
   * Puts Inter on **the vendor's document**, which is the one thing here that is not obvious.
   *
   * Everything else about this panel is sealed inside a closed shadow root. A font cannot be:
   * `@font-face` declared inside a shadow root is not reliably honoured, and font loading is a
   * document-level register either way. So the face is added to the page's own `document.fonts`
   * and the shadow CSS then just names it.
   *
   * **Which is why the family is "OpenPosse Inter" and not "Inter".** Plenty of vendors ship
   * their own Inter. Adding a second face under that name to their document would leave two
   * competing definitions and could change *their* typography – this panel is a guest and must
   * not redecorate. A name nobody else uses cannot collide, and nothing in the page references
   * it, so the page renders exactly as it did.
   *
   * Failure is cosmetic – the CSS falls through to the system stack – but it is **reported**,
   * because "the panel looks wrong on this one site" with nothing in the console is a bug
   * somebody would spend an afternoon on.
   */
  function ensureFont() {
    if (fontRegistered) return;
    fontRegistered = true;
    try {
      const url = chrome.runtime.getURL('vendor/inter/InterVariable.woff2');
      const face = new FontFace('OpenPosse Inter', `url(${url})`, {
        weight: '100 900',
        display: 'swap',
      });
      face.load()
        .then((loaded) => document.fonts.add(loaded))
        .catch((error) => {
          console.warn('[openposse] Inter would not load –', error?.message ?? error);
        });
    } catch (error) {
      console.warn('[openposse] Inter could not be registered –', error?.message ?? error);
    }
  }

  // ── The panel ────────────────────────────────────────────────────────────────────────────

  const CSS = `
    :host { all: initial; }
    .wrap {
      position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%);
      z-index: 2147483647;
      width: 452px;
      /* Defined here rather than on :host, which is \`all: initial\` on purpose so nothing the
         page sets can reach in. Kept identical to \`ui.css\` – the panel and the settings page
         disagreeing about their own typeface would be visible and pointless. */
      --ui: "OpenPosse Inter", -apple-system, system-ui, "Segoe UI", sans-serif;
      --figures: "ss02", "tnum";
      font: 400 13px/1.45 var(--ui);
      font-optical-sizing: auto;
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
    /* Sheen, explicitly not hit-testable – it covers the whole panel. */
    .glass::after {
      content: ''; position: absolute; inset: 0; border-radius: 32px; pointer-events: none;
      background: linear-gradient(114deg, rgba(255,255,255,.12) 0%, transparent 30%,
                  transparent 72%, rgba(255,255,255,.045) 100%);
    }

    /* The title bar is the handle. It opts into hit-testing, which the rest of the card does
       not – so the page underneath stays usable everywhere except the strip you grab. */
    header {
      display: flex; align-items: center; gap: 9px;
      pointer-events: auto; cursor: grab; user-select: none; touch-action: none;
    }
    .wrap.dragging header { cursor: grabbing; }
    ${MARK_CSS}
    .title { font-size: 13.5px; font-weight: 600; letter-spacing: -.008em; }
    .spacer { flex: 1; }
    .key { font-size: 10.5px; color: rgba(235,235,245,.58); }

    .orbwrap {
      position: relative; display: flex; flex-direction: column; align-items: center;
      margin: -4px 0 0;
      pointer-events: auto; cursor: pointer;
    }
    canvas { width: 168px; height: 168px; display: block; }
    .deadmic {
      position: absolute; bottom: 14px;
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
      font: 600 9.5px/1 var(--ui);
      letter-spacing: .08em; color: rgba(235,235,245,.42); margin-bottom: 10px;
    }
    .coach .say { font-size: 14px; line-height: 1.45; color: rgba(255,255,255,.92); }
    .coach .say.bad { color: #FF453A; }
    .coach .list { margin-top: 14px; display: flex; flex-direction: column; gap: 7px; }
    .coach .row { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
    .coach .row .tick { color: #30D158; font-size: 11px; }
    .coach .row .tick.none { color: rgba(235,235,245,.35); }
    /* "there is none" is prose, not a selector – same no-op fix as \`.keys\` below. */
    .coach .row .detail.none { color: rgba(235,235,245,.42); font-feature-settings: normal; }
    .coach .row .label { color: rgba(235,235,245,.55); flex: 0 0 92px; }
    .coach .row .kind {
      font: 600 8.5px/1 var(--ui);
      letter-spacing: .06em; color: rgba(235,235,245,.34); flex: 0 0 auto;
      align-self: center;
    }
    /* **Wraps rather than truncates.** These are the recording's whole output, and the one
       thing somebody might want to check against their page. An ellipsis put the interesting
       half of a selector out of reach – and "hover for the rest" is no answer to a screenshot.
       A taller card is the cheaper cost. */
    .coach .row .detail {
      font: 11px/1.4 var(--ui);
      /* Selectors, so the disambiguated glyphs earn their place here exactly as they do in the
         roster's lasso dump: I, l and 1 are one bar in Inter's default set. */
      font-feature-settings: var(--figures);
      color: rgba(255,255,255,.75); flex: 1 1 auto;
      white-space: normal; overflow-wrap: anywhere;
    }
    /* A shortcut is something you pressed, not page structure, so it is not a code chip.
       **This opt-out used to be \`font-family: inherit\`**, which escaped a monospace face that
       no longer exists – one family now, so that line had quietly become a no-op. What it has
       to turn off is the feature set. */
    .coach .row .detail.keys {
      font-feature-settings: normal; font-size: 13px; letter-spacing: .12em;
    }
    /* **Opted back in.** The wrap is pointer-events: none so the page underneath stays usable,
       and every interactive part has to say otherwise for itself. Without this the field is
       visible, looks focusable, and every click lands in the vendor's page behind it – which
       reads as the panel being frozen rather than as it not being there. */
    .coach .name { margin-top: 14px; display: flex; gap: 8px; pointer-events: auto; }
    /* **[hidden] is only a UA rule, so any author display declaration outranks it on origin.**
       The line above would otherwise leave this row on screen through every step of the
       recording, offering a name field before there is anything to name. This is the same bug
       that opened the project – a .mic-fix { display: block } that outranked [hidden] and put
       an empty red card in the popup – and it is worth a rule per shadow root rather than
       remembering it each time. */
    [hidden] { display: none !important; }
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

  ensureFont();

  const host = document.createElement('div');
  // `closed`, not `open`: nothing outside needs to reach in, and a closed root cannot be
  // queried by the page either – this panel shows what someone said, and the page it happens
  // to be sitting over has no business reading it.
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>${CSS}</style>
    <div class="wrap" part="wrap">
      <div class="glass">
        <header>
          ${MARK_SVG}
          <div class="title">OpenPosse</div>
          <div class="spacer"></div>
          <div class="key"></div>
        </header>
        <div class="orbwrap">
          <canvas width="168" height="168"></canvas>
          <div class="deadmic" hidden>NOT HEARING ANYTHING – CHECK INPUT</div>
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
      // `level: null` is *no meter at all*, which the renderer draws as the synthetic curve –
      // a browser or a device that cannot measure must not look like a silent room.
      drawSphere(canvas, {
        t,
        mode: modeFor(state.phase),
        tint: state.channel ?? 'none',
        level: hasLevel ? shown : null,
      });
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
          tell({ kind: 'openposse.orb.reroute', agentName: agent.name });
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
   * Nothing here judges anything – the step, the sentence and the tick-list all arrive in the
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
      // A dash rather than a tick for something optional that was not found: a red cross would
      // say a recording had failed when it has not, and a green tick would claim something we
      // do not have.
      tick.className = row.absent ? 'tick none' : 'tick';
      tick.textContent = row.absent ? '–' : '✓';

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = row.label;

      const detail = document.createElement('span');
      // Plain type, not the mono face, when it is a sentence rather than page structure.
      detail.className = `detail${row.isKeys ? ' keys' : ''}${row.absent ? ' none' : ''}`;
      detail.textContent = row.detail;
      // The full selector on hover, since the row truncates and a truncated selector is not
      // something anyone can check.
      if (!row.isKeys && !row.absent) detail.title = row.detail;

      el.append(tick, label, detail);
      if (row.kind) {
        const kind = document.createElement('span');
        kind.className = 'kind';
        kind.textContent = row.kind;
        el.append(kind);
      }
      list.append(el);
    }

  }

  // ── Keeping our clicks to ourselves ─────────────────────────────────────────────────────
  //
  // Stopped at `.wrap`, which every interactive part of the panel is inside, so our own
  // handlers (the orb, the avatars, the header's drag, the name field) have all run by the time
  // this fires. What it prevents is the event continuing out of the shadow root and into the
  // vendor's document-level listeners – where "a click landed outside my editor" is answered by
  // taking focus back, which is exactly what stopped the name field being typed into.
  //
  // Bubble phase only, so a vendor listening in the capture phase still sees it. That is not
  // fixable from here and is why the popup path exists.
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    wrap.addEventListener(type, (event) => event.stopPropagation());
  }

  // ── Moving it out of the way ────────────────────────────────────────────────────────────
  //
  // The panel sits over somebody else's application, and where it sits is sometimes exactly
  // where they need to look – during a recording especially, since the whole task is reading
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
     * Dragging something entirely off screen is easy and there is no way back – the panel has
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
        .catch((error) => console.warn('[openposse] panel position not saved –', error));
    };

    header.addEventListener('pointerup', release);
    header.addEventListener('pointercancel', release);
  }

  // ── There is no name field here, and that is the design ────────────────────────────────
  //
  // There was one, and it could not be typed into. Measured rather than guessed in the end:
  // the pointer reached it and focus landed, and Notion pulled focus back to its own `body`
  // within 150 ms, every time. Stopping the click reaching the page helped; taking focus back
  // helped; neither held.
  //
  // **The right reading of that is not "win the fight harder".** A page is entitled to manage
  // its own focus, every vendor will do it differently, and a recording that cannot finish
  // without a text field is a recording held hostage by whichever application it was made in.
  // The recording is complete and verified without a name – so it is saved under the vendor's
  // product name, and renaming happens in Settings, where nothing can interfere.

  // Clicking the orb re-arms listening, per the design. The one control the panel has.
  $('.orbwrap').addEventListener('click', () => {
    tell({ kind: 'openposse.listen.toggle' });
  });

  // Terminal phases fade themselves out after the design's idle beat.
  //
  // **Owned here rather than by the worker**, because MV3 kills an idle service worker after
  // ~30 seconds and a `setTimeout` there would sometimes never fire – leaving a panel parked
  // over someone else's page with no way to dismiss it. A timer in the page cannot be killed
  // by the worker's lifecycle.
  const DISMISS_MS = 6500;
  let dismiss = null;
  let speaking = false;

  function armDismiss(phase) {
    clearTimeout(dismiss);
    // **Never while the agent is still talking.** The answer is read aloud after the panel
    // reaches `answering`, and a shortened sentence can easily outlast 6.5 seconds – so the
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
      // speaking, but the answer arrives before the voice does – so the timer was already
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

  // Last statement in the block, deliberately. See the note on the guard above: anything that
  // throws before this line leaves the page injectable again rather than permanently poisoned.
  globalThis.__openposseOrb = true;
}
