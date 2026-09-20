// Watching a user set up an assistant, once.
//
// This is the mechanism that makes "support a new SaaS assistant" a user action rather than an
// engineering task (`docs/recording-flow.md`). It arms three listeners scoped to one tab, emits
// a `RecordingEvent` per capture, and disarms itself.
//
// ── PRIVACY: this file listens to every keystroke on the page, so read this before editing ──
//
// A capture-phase `keydown` listener is, structurally, a keylogger. Three rules keep it from
// being one, and all three are load-bearing:
//
//   1. **Only modifier-bearing keys are ever examined.** A plain letter, or shift+letter, is
//      ordinary typing: it is ignored before anything is read from the event, and never leaves
//      the page. Assistant shortcuts always carry ⌘/⌃/⌥, so nothing is lost.
//   2. **The shortcut listener removes itself the moment it fires.** The user types their test
//      question in the *next* step, by which point there is no listener to see it.
//   3. **`event.key` and the modifier flags, nothing else.** Never `target.value`, never the
//      surrounding text.
//
// The Enter-key listener that replaces it is narrower still: it reacts to exactly one key and
// records one bit — "they submitted with Enter" — with no payload at all.

import { deepQuerySelectorAll, isVisible } from './dom.js';
import { selectorFor, selectorForBoth, describePair, roleAttributes } from './selector.js';

/** Text long enough to be an answer rather than a label or a spinner. */
const MIN_ANSWER_TEXT = 40;

/** How long after a submit we keep waiting for the answer before giving up. */
const REPLY_WINDOW_MS = 120_000;

/**
 * Mutations must stop for this long before we decide which element was the answer.
 *
 * **Deciding on the first qualifying element does not work**, and Notion is where that showed:
 * it recorded a reply element **59ms** after Enter — page churn, a loading state, the prompt
 * echoing back — while the actual answer was still seconds away. The capture that looked
 * structurally perfect (`matches 0→1`) named the wrong thing, and the measured timing that the
 * response ceiling is derived from was nonsense.
 *
 * Longer than `Recipe.quietPeriodMs` (~900ms) on purpose. That one decides when an answer has
 * *finished* during a recording we already trust; this one decides *what the answer was*, from
 * nothing, once. Being slow here costs a second at setup; being wrong costs the recipe.
 */
const SETTLE_MS = 2500;

/** Ceiling on waiting for quiet, for a page that never stops mutating. */
const SETTLE_CEILING_MS = 45_000;

/** The live recording, or null. One per tab, and a tab records one thing at a time. */
let session = null;

/**
 * Arms the three listeners.
 *
 * `emit` receives `RecordingEvent`-shaped objects (`Sources/OpenPosseShared/Recording.swift`).
 */
export function arm({ emit }) {
  disarm();

  session = {
    emit,
    input: null,
    opened: false,
    /// The most recent click, so a composer that appears just after one can be attributed to
    /// it. See `armInput`.
    lastClick: null,
    submittedAt: null,
    // Everything on the page at submit time. The reply selector's `matchesBefore` is the
    // number of its matches that were already here — which is what proves the selector gained
    // one, rather than naming the transcript that merely grew longer.
    preexisting: null,
    // Every answer banked so far. Two are needed before a reply selector can be computed —
    // see `recordAnswer`.
    answers: [],
    replyTimer: null,
    listeners: [],
    observer: null,
  };

  armShortcut();
  armClickTracking();
  armInput();
  armSubmit();
  armNavigation();

  // **Adopt a composer that is already focused.**
  //
  // Everything downstream keys off `session.input`, and the only thing that sets it is a
  // `focusin` — which never fires when the assistant was already open and focused before we
  // armed. The submit handler then returns early on every click, nothing starts watching for a
  // reply, and the recording runs to its deadline reporting "missing submit" for a button the
  // user plainly pressed. Worse, the first `focusin` that *does* arrive is the re-focus after
  // sending, which then gets read as the click that opened the assistant.
  const focused = document.activeElement;
  const alreadyOpen = isEditable(focused) && isVisible(focused);
  if (alreadyOpen) {
    session.input = focused;
    session.emit({ kind: 'input', selector: selectorFor(focused) });
  }

  // Reported so the app can say so. An assistant that was already open cannot teach us how to
  // open it, and `design/NOTES.md` already names this as a wizard state: press the shortcut
  // now and it *closes* the panel, because these controls are toggles.
  emit({ kind: 'armed', alreadyOpen });
  return true;
}

/** Detaches everything. Safe to call when nothing is armed. */
export function disarm() {
  if (!session) return false;
  for (const [target, type, handler, options] of session.listeners) {
    target.removeEventListener(type, handler, options);
  }
  session.observer?.disconnect();
  clearTimeout(session.replyTimer);
  session = null;
  return true;
}

export function isArmed() {
  return session !== null;
}

/** Registers a listener and remembers it, so `disarm` cannot miss one. */
function listen(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  session.listeners.push([target, type, handler, options]);
}

function unlisten(target, type, handler, options) {
  target.removeEventListener(type, handler, options);
  session.listeners = session.listeners.filter(([t, ty, h]) =>
    !(t === target && ty === type && h === handler));
}

// MARK: - 1. The shortcut

function armShortcut() {
  const handler = (event) => {
    // A bare modifier press is not a shortcut.
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;

    // THE PRIVACY GATE. Shift alone does not count — shift+letter is capital letters, which
    // is typing. Nothing below this line runs for ordinary keystrokes, so ordinary keystrokes
    // are never read, let alone transmitted.
    if (!event.metaKey && !event.ctrlKey && !event.altKey) return;

    // Fires once. By the time the user types their test question in the next step there is no
    // shortcut listener attached at all.
    unlisten(window, 'keydown', handler, true);

    session.opened = true;
    session.emit({
      kind: 'open',
      openMethod: 'shortcut',
      shortcut: {
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
      },
    });
  };

  // Capture phase: an app that owns a shortcut usually calls `stopPropagation`, so a bubbling
  // listener never sees the very keys we are here to record.
  listen(window, 'keydown', handler, true);
}

// MARK: - 1b. …or the button that opens it

/**
 * Remembers the last click, so a composer appearing right after one can be attributed to it.
 *
 * **Not every assistant has a keyboard shortcut.** Notion's opens from a button, and requiring
 * a shortcut was LeanIX's shape generalised into a rule — it would have excluded most of the
 * long tail. There is no event for "the assistant opened", so the attribution is: the composer
 * appeared, nobody pressed a shortcut, and this is what was clicked just before.
 *
 * A heuristic, and the dry run is what verifies it — the same division as everywhere else here.
 */
/** Shapes a control usually takes. Checked before falling back to `cursor: pointer`. */
const CONTROL_SELECTOR =
  'button, a, [role="button"], [role="menuitem"], [role="tab"], [type="submit"]';

/**
 * The control a click landed on, or null if it did not land on one.
 *
 * **`closest('button, [role=button]')` alone is not enough**, and Notion is where that showed:
 * clicking its send control captured nothing at all, so the recorder never started watching for
 * a reply and the whole recording timed out. Plenty of apps build controls from plain `div`s
 * with no role — Notion's composer buttons among them.
 *
 * `cursor: pointer` is the fallback because it is the one signal that is nearly universal:
 * a thing you can click is styled as a thing you can click, whatever element it is made of.
 */
function clickableTarget(event) {
  const direct = event.target?.closest?.(CONTROL_SELECTOR);
  if (direct) return direct;

  // Walk a few levels for a pointer cursor. Bounded: the cursor is usually set on the control
  // or its immediate wrapper, and `body` often has one on some sites.
  let node = event.target;
  for (let depth = 0; node?.nodeType === 1 && depth < 4; depth += 1) {
    if (node === document.body) break;
    const style = node.ownerDocument?.defaultView?.getComputedStyle(node);
    if (style?.cursor === 'pointer') return node;
    node = node.parentElement;
  }
  return null;
}

function armClickTracking() {
  const handler = (event) => {
    const target = clickableTarget(event);
    if (!target) return;

    // **The selector is computed now, not when it is needed.**
    //
    // Attribution happens later, when the composer appears — and by then the control is often
    // gone: a click that opens a panel usually re-renders the thing that was clicked, leaving
    // a detached node. `selectorFor` on a detached element walks up to a null parent
    // immediately and returns an empty string, which is what `open click  via structure` in the
    // log was: a capture that succeeded and recorded nothing.
    session.lastClick = { element: target, selector: selectorFor(target), at: Date.now() };
  };
  listen(window, 'click', handler, true);
}

/** How long after a click a composer can appear and still be blamed on it. */
const OPEN_ATTRIBUTION_MS = 5000;

// MARK: - 2. The message box

function armInput() {
  // `focusin`, not `click`. The common case is that the panel opens and focuses its composer
  // for you — no click happens at all, and a click listener would sit waiting through a
  // perfectly normal interaction.
  const handler = (event) => {
    const el = event.target;
    if (!isEditable(el) || !isVisible(el)) return;
    if (session.input === el) return;

    // The composer just appeared and no shortcut was pressed, so something was clicked to open
    // it. Attribute it to the most recent click — excluding a click *inside* the composer,
    // which is someone focusing a box that was already there rather than opening anything.
    // Only the *first* composer we ever see can have been opened by a click.
    //
    // Without `session.input === null` this misfires on a re-render: sending a message
    // re-creates the composer and refocuses it, so a second `focusin` arrives moments after
    // the send click — and the send button gets recorded as the control that opens the
    // assistant. Measured on Notion, which recorded `agent-send-message-button` as its open
    // control while the actual submit was never captured at all.
    if (!session.opened && session.input === null && session.lastClick
        && Date.now() - session.lastClick.at < OPEN_ATTRIBUTION_MS
        && !el.contains(session.lastClick.element)
        && session.lastClick.element !== el) {
      session.opened = true;
      // The selector was computed at click time — see `armClickTracking`. Recomputing it here
      // would be too late: the control that opened the panel is usually detached by now.
      session.emit({
        kind: 'open',
        openMethod: 'click',
        selector: session.lastClick.selector,
      });
    }

    session.input = el;
    session.emit({ kind: 'input', selector: selectorFor(el) });
  };
  listen(window, 'focusin', handler, true);
}

function isEditable(el) {
  if (!el?.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && ['text', 'search', ''].includes(el.type ?? '');
}

// MARK: - 3. The submit, and the answer

function armSubmit() {
  // A click anywhere; we work out whether it was the send control by where it landed.
  const onClick = (event) => {
    if (!session.input) return;
    // Same broadened test as the open control. `closest('button, [role=button]')` missed
    // Notion's send button entirely, so nothing was recorded, nothing started watching for a
    // reply, and the recording ran to its 90s deadline reporting "missing submit" — for a
    // button the user had plainly clicked.
    const button = clickableTarget(event);
    if (!button || !isVisible(button)) return;
    // Clicking inside the composer itself is not sending — formatting controls, attachment
    // buttons and emoji pickers all live there.
    if (session.input.contains(button)) return;

    onSubmitted({ kind: 'submit', submitMethod: 'click', selector: selectorFor(button) });
  };

  // Enter, and only Enter. One key, one bit, no payload — see the privacy note at the top.
  const onEnter = (event) => {
    if (!session.input || event.key !== 'Enter' || event.shiftKey) return;
    if (event.target !== session.input && !session.input.contains(event.target)) return;

    onSubmitted({ kind: 'submit', submitMethod: 'enterKey' });
  };

  listen(window, 'click', onClick, true);
  listen(window, 'keydown', onEnter, true);
}

/**
 * Records how the message was sent, then starts watching for the answer.
 *
 * The `preexisting` snapshot is taken here rather than at arm time because it must reflect the
 * page as it was *immediately before this question* — the assistant's own greeting, and any
 * earlier turns, are legitimately already present.
 */
function onSubmitted(event) {
  session.emit(event);

  // A second submit re-baselines rather than being ignored: the user may have sent something
  // that did not produce an answer and tried again.
  clearTimeout(session.replyTimer);
  session.observer?.disconnect();

  session.submittedAt = Date.now();
  session.preexisting = new WeakSet(deepQuerySelectorAll('*'));

  watchForReply();
}

function watchForReply() {
  // Every element added since the submit, with when it first appeared.
  //
  // Accumulating rather than judging each batch on its own is load-bearing. A vendor adds the
  // reply element **empty** and fills it afterwards, so at the moment it appears in
  // `addedNodes` it has no text and fails the "is this an answer?" test — and by the time it
  // has text, the mutations are happening *inside* it and it is never in `addedNodes` again.
  //
  // The timestamp is what `elapsedMs` reports: when the chosen element *appeared*, which is
  // what the runtime's `waitForNewMatch` actually waits for — not when the answer finished.
  const addedSinceSubmit = new Map();
  let settleTimer = null;

  const decide = () => {
    clearTimeout(settleTimer);
    clearTimeout(ceiling);
    clearTimeout(session.replyTimer);
    observer.disconnect();
    session.observer = null;

    for (const el of [...addedSinceSubmit.keys()]) {
      if (!el.isConnected) addedSinceSubmit.delete(el);
    }

    const pool = [...addedSinceSubmit.keys()];
    const reply = chooseReplyElement(pool);

    if (reply) {
      recordAnswer(reply, addedSinceSubmit.get(reply) ?? Date.now());
      return;
    }

    // **Silence here was wrong, and it stranded a recording.** The old comment argued that
    // saying nothing was the honest option because the wizard already lists what is
    // outstanding — but the wizard lists "reply" as outstanding whether we looked and found
    // nothing or never looked at all. A user who has sent a question and watched it answered
    // is then staring at a panel still asking for the thing they just did.
    //
    // Measured: a second question was sent, the page answered, no candidate passed the
    // filters, and the panel sat on "Watching for your second question…" while the user sent
    // it three more times.
    //
    // So: say we looked. Counts only — how many elements were added, how many were visible,
    // how many held enough text — which is what names the filter that ate it.
    session.emit({
      kind: 'reply_pending',
      repliesSoFar: session.answers.length,
      noAnswerFound: true,
      shape: describeCandidates(pool),
    });
  };

  const observer = new MutationObserver((records) => {
    const now = Date.now();
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (!addedSinceSubmit.has(node)) addedSinceSubmit.set(node, now);

        // **Descendants too, and this is not defensive padding.**
        //
        // `MutationRecord.addedNodes` holds only the nodes inserted *directly into the
        // target* — never their descendants. A vendor that builds its answer and attaches it
        // in one go therefore produces a single record naming one subtree root, and every
        // element inside it is invisible to us.
        //
        // Measured on Notion: the one node reported was a plain `div` with no attributes, so
        // the only candidate had no usable selector and we fell to a 20-segment structural
        // path. The `div[data-content-editable-root="true"]` container that identifies the
        // answer exactly was three levels inside it, and was never even a candidate — we were
        // ranking a set of one and calling it a choice.
        const descendants = node.querySelectorAll?.('*') ?? [];
        // A page-level re-render can insert thousands of elements at once. That is not an
        // answer, and walking it would cost more than it could ever be worth.
        if (descendants.length > 2000) continue;
        for (const child of descendants) {
          if (!addedSinceSubmit.has(child)) addedSinceSubmit.set(child, now);
        }
      }
    }

    // Restart the settle timer on every mutation. The answer is still being written while
    // these keep arriving, so the moment they stop is the first moment the page can be asked
    // what it produced.
    clearTimeout(settleTimer);
    settleTimer = setTimeout(decide, SETTLE_MS);
  });

  // `characterData` as well as `childList`: an element that was added empty gains its text
  // through character-data mutations, and without this the observer is never called again
  // after the initial insertion.
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  session.observer = observer;

  // A page with a spinner, a clock or a blinking cursor never goes quiet, and waiting for
  // silence that will not come is indistinguishable from a broken recorder.
  const ceiling = setTimeout(decide, SETTLE_CEILING_MS);

  session.replyTimer = setTimeout(() => {
    observer.disconnect();
    session.observer = null;
    clearTimeout(settleTimer);
    clearTimeout(ceiling);
  }, REPLY_WINDOW_MS);
}

/**
 * Picks which newly-added element is "the answer".
 *
 * **This is the least certain capture in the recorder, and the dry run is what verifies it.**
 * A vendor adds a whole subtree when it answers, and which node in that subtree is the reply
 * is a judgement. Three rules, in order, each earning its place:
 *
 * 1. **Never an element containing the composer.** That is the panel, not a reply, and it
 *    would make the agent read its own input box aloud.
 * 2. **Prefer a custom element** (`lx-agentic-chat-assistant-message`). On a web-components
 *    app that tag is the vendor's own semantic unit for exactly this, and it is the most
 *    durable selector on the page.
 * 3. **Otherwise the outermost added element** with enough text to be an answer, so a
 *    multi-paragraph reply is not truncated to its first `<p>`.
 */
/**
 * Why nothing qualified as an answer — counts only, never text.
 *
 * Each number is one of `chooseReplyElement`'s filters, in the order it applies them, so the
 * first one that collapses to zero is the one that ate the answer. `longest` is the decisive
 * figure when `enoughText` is zero: a page that produced 900 elements whose biggest holds 12
 * characters was still rendering, while one holding 38 means `MIN_ANSWER_TEXT` is simply too
 * high for this vendor's shorter replies.
 */
function describeCandidates(added) {
  const visible = added.filter((el) => isVisible(el));
  const notComposer = visible.filter((el) => !(session.input && el.contains(session.input)));
  const lengths = notComposer.map((el) => (el.innerText ?? '').length);
  const enoughText = lengths.filter((n) => n >= MIN_ANSWER_TEXT).length;

  return [
    `added=${added.length}`,
    `visible=${visible.length}`,
    `notComposer=${notComposer.length}`,
    `enoughText=${enoughText}`,
    `longest=${lengths.length ? Math.max(...lengths) : 0}`,
    `threshold=${MIN_ANSWER_TEXT}`,
  ].join(' ');
}

function chooseReplyElement(added) {
  const candidates = added.filter((el) => {
    if (!isVisible(el)) return false;
    if (session.input && el.contains(session.input)) return false;
    return (el.innerText ?? '').length >= MIN_ANSWER_TEXT;
  });
  if (candidates.length === 0) return null;

  // Prefer a candidate we can actually *name*.
  //
  // Choosing the element and then computing a selector for it treats the two as independent
  // decisions, and they are not. On Notion the structurally tidiest candidate had no usable
  // attribute and produced a 20-segment path, while the container three levels inside it
  // carried `data-content-editable-root` and identified the answer exactly. An element we can
  // name durably beats a marginally tidier one reachable only by counting divs.
  //
  // **"Nameable" means carrying a role attribute, not producing a stable selector on its own.**
  // Those came apart the moment per-message values were rejected: Notion's answer container is
  // marked `data-agent-service-scroll-anchor="event_34s3…"`, whose value is correctly refused —
  // and reading that refusal as "cannot be identified" dropped the best candidate on the page.
  // What was chosen instead was `div.xdt5ytf`: a build-generated class matching twenty-four
  // elements and gaining three per answer, which passed the dry run and would have broken on
  // Notion's next deploy.
  //
  // Two samples are what make the value dispensable — `selectorForBoth` drops it and keeps the
  // attribute — so the element has to survive this filter to get there.
  const nameable = candidates.filter(
    (el) => selectorFor(el, { allowMultiple: true }).isStable || roleAttributes(el).length > 0
  );
  const pool = nameable.length > 0 ? nameable : candidates;

  // The tightest element that still holds essentially the whole answer.
  //
  // "Outermost" was the first rule here and it is wrong in the same way `openposseDiff`'s
  // comment already warned: every ancestor up to `<body>` also contains the answer, so the
  // outermost candidate drags in the page chrome around it and the agent reads that aloud too.
  // "Innermost" is wrong in the other direction — it lands on the first `<p>` of a
  // multi-paragraph reply.
  //
  // So: take the largest text any candidate holds, keep the ones within 10% of it — those all
  // contain the answer and differ only in how much extra they carry.
  const textLength = (el) => (el.innerText ?? '').length;
  const largest = Math.max(...pool.map(textLength));
  const holdsTheAnswer = pool.filter((el) => textLength(el) >= largest * 0.9);

  // A custom element's tag is the most durable identifier a page can offer, so prefer one —
  // but only among the elements that actually hold the answer.
  //
  // This used to be an early return on the *first* custom element found anywhere in the
  // candidate set, which was safe only because LeanIX had exactly one. Now that descendants
  // are candidates too, a web-components page offers many, and "first" is arbitrary.
  const custom = holdsTheAnswer.find((el) => el.tagName.includes('-'));
  if (custom) return custom;

  // Otherwise the one nothing else contains: the answer with the least wrapper around it.
  return holdsTheAnswer.find(
    (el) => !holdsTheAnswer.some((other) => other !== el && el.contains(other))
  ) ?? holdsTheAnswer[0];
}

/**
 * Banks one answer, and emits the reply capture once there are two of them.
 *
 * **Two, because one cannot distinguish an answer from where answers appear.** Both attempts
 * against Notion named a single message — first a per-message id, then a seventeen-segment
 * positional path — and both looked healthy: `0→1 PER-REPLY`, a selector that resolved, a
 * recipe that validated. The next question matched nothing in each case. No test applied to one
 * element can separate the two, because on a page holding one answer they are the same element.
 *
 * With two, the constraint does the work: a selector matching both cannot be naming either.
 * It also makes the existing before/after check mean something — the second exchange reports
 * `1→2`, which is the real signal that was being approximated by `0→1`.
 *
 * The first answer emits `reply_pending` instead, so the panel can ask for one more rather than
 * looking like it has stopped noticing.
 */
function recordAnswer(element, firstSeenAt) {
  session.answers.push({ element, firstSeenAt });

  if (session.answers.length < 2) {
    session.emit({ kind: 'reply_pending', repliesSoFar: session.answers.length });
    return;
  }

  const [first, second] = session.answers.slice(-2);
  const selector = selectorForBoth(first.element, second.element);

  // Nothing described both. Say so rather than falling back to one of them — a selector for
  // one answer is exactly the failure this whole path exists to prevent, and it is worse than
  // no capture because it validates.
  if (!selector) {
    session.emit({
      kind: 'reply_pending',
      repliesSoFar: session.answers.length,
      noCommonSelector: true,
      // Shape, not content — see `describePair`. Without it this failure is a dead end, which
      // is the same gap that cost two rounds on the reply selector already.
      shape: describePair(first.element, second.element),
    });
    return;
  }

  // Timed and measured from the *second* answer, which is the one seen under normal
  // conditions: the first often lands on a freshly opened panel that is still warming up.
  emitReply(selector, second.element, second.firstSeenAt);
}

function emitReply(selector, element, firstSeenAt) {
  const matches = deepQuerySelectorAll(selector.css);

  // The check the whole design turns on. `matchesBefore` counts only those matches that were
  // already on the page when the question was sent, so a selector naming the transcript rather
  // than one reply comes back with before === after, and `RecipeDraft` refuses it.
  const matchesBefore = matches.filter((el) => session.preexisting.has(el)).length;

  session.emit({
    kind: 'reply',
    reply: {
      selector,
      matchesBefore,
      matchesAfter: matches.length,
      // How long the vendor took, so the recipe's response ceiling is measured rather than
      // guessed. Guessing it is how M2 shipped a 15s ceiling against a cold path that needed
      // 14.8s, which passed on every warm tab and looked intermittent.
      //
      // When the chosen element *appeared*, not when the answer finished — that is what the
      // runtime's `waitForNewMatch` waits for, so it is the quantity the ceiling should be
      // derived from.
      //
      // Reported for the element we settled on, which is why it is passed in rather than read
      // off the clock here. Timing the *decision* instead would report the settle period
      // rather than the vendor, and timing the first qualifying element reported 59ms on
      // Notion for a loading state.
      elapsedMs: Math.max(0, firstSeenAt - session.submittedAt),
      // Length only, never the text. A number here is what makes a wrong pick obvious: an
      // answer is hundreds of characters, a loading label is tens. Reading the selector alone
      // cannot tell those apart, which is how the 59ms capture looked fine.
      textLength: (element.innerText ?? '').length,
    },
  });
}

// MARK: - Leaving the page

function armNavigation() {
  // Capture is scoped to one tab and one page. A user who wanders off should be told, not left
  // watching a checklist that will never advance.
  const handler = () => session?.emit({ kind: 'navigated_away' });
  listen(window, 'pagehide', handler, false);
}
