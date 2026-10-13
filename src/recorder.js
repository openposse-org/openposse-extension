// Watching a user set up an assistant, once.
//
// This is the mechanism that makes "support a new SaaS assistant" a user action rather than an
// engineering task. It arms three listeners scoped to one tab, emits
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
// records one bit – "they submitted with Enter" – with no payload at all.

import { deepQuerySelectorAll, isVisible } from './dom.js';
import {
  selectorFor, selectorForBoth, describePair, roleAttributes, isGeneratedID, STABLE_ATTRS,
} from './selector.js';

/** Text long enough to be an answer rather than a label or a spinner. */
export const MIN_ANSWER_TEXT = 40;

/** How long after a submit we keep waiting for the answer before giving up. */
const REPLY_WINDOW_MS = 120_000;

/**
 * Mutations must stop for this long before we decide which element was the answer.
 *
 * **Deciding on the first qualifying element does not work**, and Notion is where that showed:
 * it recorded a reply element **59ms** after Enter – page churn, a loading state, the prompt
 * echoing back – while the actual answer was still seconds away. The capture that looked
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
/**
 * Says what the recorder just captured, in the console of the page being recorded.
 *
 * **Here rather than in the service worker**, and not as a second-best. This code runs in the
 * vendor's page, so this is its own console – the same window the person recording already has
 * open, and one that does not vanish when an idle service worker is terminated. A recording is
 * minutes long with no traffic of ours, which is exactly the condition MV3 kills a worker in,
 * and its DevTools detaches with it.
 *
 * **Event kinds, selectors and counts only – never page text.** The project's rule is "log
 * event types and error codes only", and a recorder is the one place that rule is easy to
 * break: the thing being captured is somebody's own question to their own assistant.
 */
function note(what, detail) {
  if (detail === undefined) console.info(`[openposse] recording: ${what}`);
  else console.info(`[openposse] recording: ${what}`, detail);
}

/** The parts of a capture worth reading, with nothing in them that came from the page's text. */
function summarise(event) {
  switch (event.kind) {
    case 'armed':
      return { assistantAlreadyOpen: event.alreadyOpen };
    case 'open':
      return event.openMethod === 'shortcut'
        ? { by: 'shortcut', keys: keyDescription(event.shortcut) }
        : { by: 'click', control: event.selector?.css };
    case 'input':
      return { box: event.selector?.css };
    case 'submit':
      return { by: event.submitMethod, button: event.selector?.css };
    case 'reply_pending':
      return {
        answersSoFar: event.repliesSoFar,
        ...(event.noCommonSelector ? { problem: 'no selector described both answers' } : {}),
        ...(event.noAnswerFound ? { problem: 'nothing on the page looked like an answer' } : {}),
        ...(event.shape ? { shape: event.shape } : {}),
      };
    case 'reply':
      return {
        answer: event.reply?.selector?.css,
        matches: `${event.reply?.matchesBefore} → ${event.reply?.matchesAfter}`,
        tookMs: event.reply?.elapsedMs,
        // The characters, never the characters themselves.
        answerLength: event.reply?.textLength,
        knowsWhenDone: event.reply?.busySelector ?? 'nothing found – a timer will be used',
        foundBy: event.reply?.busyFrom ?? 'n/a',
      };
    default:
      return undefined;
  }
}

function keyDescription(shortcut) {
  if (!shortcut) return '';
  return [shortcut.ctrlKey && '⌃', shortcut.altKey && '⌥', shortcut.shiftKey && '⇧',
    shortcut.metaKey && '⌘', shortcut.key?.toUpperCase()].filter(Boolean).join(' ');
}

export function arm({ emit }) {
  disarm();
  note('armed – watching this page');

  session = {
    emit: (event) => {
      // Logged as it goes out, so what the panel shows and what the console says cannot drift.
      note(event.kind, summarise(event));
      emit(event);
    },
    input: null,
    opened: false,
    /// The most recent click, so a composer that appears just after one can be attributed to
    /// it. See `armInput`.
    lastClick: null,
    submittedAt: null,
    // Everything on the page at submit time. The reply selector's `matchesBefore` is the
    // number of its matches that were already here – which is what proves the selector gained
    // one, rather than naming the transcript that merely grew longer.
    preexisting: null,
    // Every answer banked so far. Two are needed before a reply selector can be computed –
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
  // `focusin` – which never fires when the assistant was already open and focused before we
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

    // THE PRIVACY GATE. Shift alone does not count – shift+letter is capital letters, which
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
 * a shortcut was LeanIX's shape generalised into a rule – it would have excluded most of the
 * long tail. There is no event for "the assistant opened", so the attribution is: the composer
 * appeared, nobody pressed a shortcut, and this is what was clicked just before.
 *
 * A heuristic, and the dry run is what verifies it – the same division as everywhere else here.
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
 * with no role – Notion's composer buttons among them.
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
    // Attribution happens later, when the composer appears – and by then the control is often
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
  // for you – no click happens at all, and a click listener would sit waiting through a
  // perfectly normal interaction.
  const handler = (event) => {
    const el = event.target;
    if (!isEditable(el) || !isVisible(el)) return;
    if (session.input === el) return;

    // The composer just appeared and no shortcut was pressed, so something was clicked to open
    // it. Attribute it to the most recent click – excluding a click *inside* the composer,
    // which is someone focusing a box that was already there rather than opening anything.
    // Only the *first* composer we ever see can have been opened by a click.
    //
    // Without `session.input === null` this misfires on a re-render: sending a message
    // re-creates the composer and refocuses it, so a second `focusin` arrives moments after
    // the send click – and the send button gets recorded as the control that opens the
    // assistant. Measured on Notion, which recorded `agent-send-message-button` as its open
    // control while the actual submit was never captured at all.
    if (!session.opened && session.input === null && session.lastClick
        && Date.now() - session.lastClick.at < OPEN_ATTRIBUTION_MS
        && !el.contains(session.lastClick.element)
        && session.lastClick.element !== el) {
      session.opened = true;
      // The selector was computed at click time – see `armClickTracking`. Recomputing it here
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
    // reply, and the recording ran to its 90s deadline reporting "missing submit" – for a
    // button the user had plainly clicked.
    const button = clickableTarget(event);
    if (!button || !isVisible(button)) return;
    // Clicking inside the composer itself is not sending – formatting controls, attachment
    // buttons and emoji pickers all live there.
    if (session.input.contains(button)) return;

    const selector = selectorFor(button);
    // Kept so the reply window can watch it change. A send control usually cycles
    // enabled → stop → enabled across one answer, which is the vendor saying when it is
    // working – see `watchSubmitState`.
    session.submitButton = { element: button, css: selector.css };
    onSubmitted({ kind: 'submit', submitMethod: 'click', selector });
  };

  // Enter, and only Enter. One key, one bit, no payload – see the privacy note at the top.
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
 * page as it was *immediately before this question* – the assistant's own greeting, and any
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
  // `addedNodes` it has no text and fails the "is this an answer?" test – and by the time it
  // has text, the mutations are happening *inside* it and it is never in `addedNodes` again.
  //
  // The timestamp is what `elapsedMs` reports: when the chosen element *appeared*, which is
  // what the runtime's `waitForNewMatch` actually waits for – not when the answer finished.
  const addedSinceSubmit = new Map();
  // When each of them left, so how long it was on screen can be measured. That span is what
  // separates a vendor's "working" indicator from the churn around it – see `decide`.
  const removedAt = new Map();
  let settleTimer = null;

  // **The send button is the better signal, and it was invisible to the one above.**
  //
  // A vendor's "working" state is usually not a new element at all: the send control changes –
  // enabled, then a stop button, then enabled again. Nothing appears and nothing leaves, so
  // watching for a vanishing element finds nothing and reports "nothing to watch", which is
  // what Notion did.
  //
  // Both reduce to the same thing for the runtime, which is why this needs no new concept:
  // a selector that matches while the vendor is busy and stops matching when it is done.
  // `div[data-testid="send"][aria-label="Stop"]` behaves exactly like a spinner that goes away.
  const submitStates = watchSubmitState();

  const decide = () => {
    clearTimeout(settleTimer);
    clearTimeout(ceiling);
    clearTimeout(session.replyTimer);
    observer.disconnect();
    session.observer = null;

    // **What appeared and then left is the vendor telling us it was busy.**
    //
    // These were already being found here and thrown away – an element added after the submit
    // and gone by the time the page settled is, almost by definition, a "thinking" spinner or a
    // "stop generating" control. That is the signal the runtime has been missing: without it,
    // "the answer is finished" is a 2.5 s clock that gets paid on every single turn whether or
    // not anything was still coming.
    //
    // Signatures rather than elements, because by now they are detached: `selectorFor` verifies
    // a candidate by counting matches, and a element that has left the page matches nothing.
    // `roleAttributes` names identifying attributes without their values, which is exactly what
    // survives the element itself – and two exchanges are what make a value unnecessary.
    // **How long it was on screen is what tells a busy indicator from the churn around it.**
    //
    // A spinner or a stop button exists from the question until the answer: it spans nearly the
    // whole window. A composer that re-renders produces an element that lives for a few
    // hundred milliseconds and is replaced by an identical one – which looks the same to a
    // "did it appear and leave?" test and is not an indicator at all.
    //
    // Notion produced exactly that: `agent-service-approval-mode-button`, a control that is
    // present whether or not it is working, captured because the node behind it was swapped.
    // Ranking by selector length picked it over anything else, which was never a reason for
    // preferring one element over an unrelated one – that tiebreak was about a container
    // versus its child and had no business deciding this.
    const now = Date.now();
    const vanished = [];
    for (const el of [...addedSinceSubmit.keys()]) {
      if (el.isConnected) continue;
      const sig = busySignature(el);
      if (sig) {
        vanished.push({
          sig,
          span: (removedAt.get(el) ?? now) - addedSinceSubmit.get(el),
          fromButton: false,
        });
      }
      addedSinceSubmit.delete(el);
    }

    // The send button's own transitions, in the same currency: selectors that matched during
    // the answer and do not match now that it is over. Credited with the full window, because
    // a state the control wore and has taken off *is* the vendor describing the whole answer.
    const windowMs = Math.max(1, now - session.submittedAt);
    vanished.push(...submitStates.finish()
      .map((sig) => ({ sig, span: windowMs, fromButton: true })));

    // **Everything that was considered, not only what was chosen.** Four attempts at this
    // capture were spent reasoning about why a mechanism found nothing, when the list it built
    // would have said so immediately. A candidate is only recorded if both exchanges produce
    // it, so a selector appearing here once and not in the recipe is the ordinary case rather
    // than a fault – and an empty list on both exchanges is the answer to "why is there no
    // indicator?".
    note('busy candidates', vanished.length === 0
      ? 'none – nothing appeared and left during this answer'
      : vanished.map(({ sig, span, fromButton }) => ({
        selector: sig,
        onScreenMs: span,
        from: fromButton ? 'the send control' : 'appeared while busy',
      })));

    const pool = [...addedSinceSubmit.keys()];
    const reply = chooseReplyElement(pool);

    if (reply) {
      recordAnswer(reply, addedSinceSubmit.get(reply) ?? Date.now(), vanished);
      return;
    }

    // **Silence here was wrong, and it stranded a recording.** The old comment argued that
    // saying nothing was the honest option because the wizard already lists what is
    // outstanding – but the wizard lists "reply" as outstanding whether we looked and found
    // nothing or never looked at all. A user who has sent a question and watched it answered
    // is then staring at a panel still asking for the thing they just did.
    //
    // Measured: a second question was sent, the page answered, no candidate passed the
    // filters, and the panel sat on "Watching for your second question…" while the user sent
    // it three more times.
    //
    // So: say we looked. Counts only – how many elements were added, how many were visible,
    // how many held enough text – which is what names the filter that ate it.
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
        // target* – never their descendants. A vendor that builds its answer and attaches it
        // in one go therefore produces a single record naming one subtree root, and every
        // element inside it is invisible to us.
        //
        // Measured on Notion: the one node reported was a plain `div` with no attributes, so
        // the only candidate had no usable selector and we fell to a 20-segment structural
        // path. The `div[data-content-editable-root="true"]` container that identifies the
        // answer exactly was three levels inside it, and was never even a candidate – we were
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

    // When things leave, for the same elements. Only those we already know about, because an
    // element removed that was never added since the submit was part of the page before the
    // question and tells us nothing about answering it.
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node.nodeType !== 1) continue;
        if (addedSinceSubmit.has(node) && !removedAt.has(node)) removedAt.set(node, now);
        const descendants = node.querySelectorAll?.('*') ?? [];
        if (descendants.length > 2000) continue;
        for (const child of descendants) {
          if (addedSinceSubmit.has(child) && !removedAt.has(child)) removedAt.set(child, now);
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
 * Why nothing qualified as an answer – counts only, never text.
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
  // marked `data-agent-service-scroll-anchor="event_34s3…"`, whose value is correctly refused –
  // and reading that refusal as "cannot be identified" dropped the best candidate on the page.
  // What was chosen instead was `div.xdt5ytf`: a build-generated class matching twenty-four
  // elements and gaining three per answer, which passed the dry run and would have broken on
  // Notion's next deploy.
  //
  // Two samples are what make the value dispensable – `selectorForBoth` drops it and keeps the
  // attribute – so the element has to survive this filter to get there.
  const nameable = candidates.filter(
    (el) => selectorFor(el, { allowMultiple: true }).isStable || roleAttributes(el).length > 0
  );
  const pool = nameable.length > 0 ? nameable : candidates;

  // The tightest element that still holds essentially the whole answer.
  //
  // "Outermost" was the first rule here and it is wrong in the same way `openposseDiff`'s
  // comment already warned: every ancestor up to `<body>` also contains the answer, so the
  // outermost candidate drags in the page chrome around it and the agent reads that aloud too.
  // "Innermost" is wrong in the other direction – it lands on the first `<p>` of a
  // multi-paragraph reply.
  //
  // So: take the largest text any candidate holds, keep the ones within 10% of it – those all
  // contain the answer and differ only in how much extra they carry.
  const textLength = (el) => (el.innerText ?? '').length;
  const largest = Math.max(...pool.map(textLength));
  const holdsTheAnswer = pool.filter((el) => textLength(el) >= largest * 0.9);

  // A custom element's tag is the most durable identifier a page can offer, so prefer one –
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
 * against Notion named a single message – first a per-message id, then a seventeen-segment
 * positional path – and both looked healthy: `0→1 PER-REPLY`, a selector that resolved, a
 * recipe that validated. The next question matched nothing in each case. No test applied to one
 * element can separate the two, because on a page holding one answer they are the same element.
 *
 * With two, the constraint does the work: a selector matching both cannot be naming either.
 * It also makes the existing before/after check mean something – the second exchange reports
 * `1→2`, which is the real signal that was being approximated by `0→1`.
 *
 * The first answer emits `reply_pending` instead, so the panel can ask for one more rather than
 * looking like it has stopped noticing.
 */
/**
 * Watches the send control change while the vendor works.
 *
 * Polled at 150 ms from the submit until the answer settles, keeping every distinct
 * attribute/value pair the button wore. At the end, whatever it wore *during* and is not
 * wearing *now* is a description of "still working".
 *
 * Attributes only, never text: a label reads "Stop" in one locale and something else in
 * another, and the promise is that page content does not leave the page. `aria-label` is a
 * borderline case and is included deliberately – it is the attribute most vendors use to say
 * which state a control is in, and it is the vendor's own word for its own button, not the
 * user's content.
 *
 * Returns candidates in the same form as a vanished element, so `recordAnswer` can intersect
 * the two exchanges without caring which kind it has.
 */
function watchSubmitState() {
  const button = session.submitButton;
  if (!button?.css) return { finish: () => [] };

  const WATCHED = ['aria-label', 'title', 'data-state', 'aria-disabled', 'disabled', 'role'];
  const seen = new Set();
  const replacements = new Set();

  /**
   * Every `data-testid` on the page at the moment the question was sent.
   *
   * **A baseline rather than a container reference, and the difference is what went wrong.**
   * The first version held the send button's parent and scanned inside it. Notion re-renders
   * the composer row, so that node is detached by the time the swap happens – and it was only
   * refreshed while the send button was *present*, which is never during the very period worth
   * watching. The scan silently did nothing for the whole answer.
   *
   * A set of strings cannot go stale. Anything wearing a testid that was not on the page when
   * the question went in has arrived because of the question, and one that arrives while the
   * send control is away has arrived *in its place*.
   *
   * It also excludes the near-miss that kept winning: `agent-service-approval-mode-button` is
   * in the baseline, because it is present whether or not the agent is working – it was only
   * ever captured because the node behind it gets swapped.
   */
  const baseline = new Set(
    deepQuerySelectorAll('[data-testid]').map((el) => el.getAttribute('data-testid')),
  );

  const sample = () => {
    // Re-queried rather than held, because a vendor may swap the node rather than mutate it –
    // and a detached reference would report the old state forever.
    const el = deepQuerySelectorAll(button.css)[0];

    if (el?.getAttribute) {
      for (const attr of WATCHED) {
        const value = el.getAttribute(attr);
        if (value === null || isGeneratedID(value)) continue;
        seen.add(`${attr}=${value}`);
      }
      return;
    }

    // **The send button is not on the page, so something is standing in for it.**
    //
    // This is the case the first version could not see, and it is the common one. Measured on
    // Notion: the control is `data-testid="agent-chat-send-button"` when idle or ready, and
    // while the model works that element is *replaced* by
    // `data-testid="agent-chat-stop-button"`. Re-querying the send button's own selector
    // therefore finds nothing at precisely the moment worth recording, and watching its
    // attributes change can never work – it is not the same element.
    //
    // Whatever is new on the page while it is gone has arrived in its place. Scanned only
    // during that window, so the cost falls on the seconds an answer takes rather than on
    // every tick of a recording.
    for (const node of deepQuerySelectorAll('[data-testid]')) {
      const id = node.getAttribute('data-testid');
      if (!id || isGeneratedID(id) || baseline.has(id)) continue;
      replacements.add(`${node.tagName.toLowerCase()}[data-testid="${CSS.escape(id)}"]`);
    }
  };

  sample();
  const timer = setInterval(sample, 150);

  return {
    finish() {
      clearInterval(timer);

      const el = deepQuerySelectorAll(button.css)[0];
      if (!el) return [];

      const atRest = new Set();
      for (const attr of WATCHED) {
        const value = el.getAttribute(attr);
        if (value !== null) atRest.add(`${attr}=${value}`);
      }

      // Anything worn during the answer and not worn now, plus anything that stood in for the
      // control while it was away.
      //
      // Every one is verified against the live page rather than trusted: a selector that still
      // matches now that the answer is over would tell the runtime the vendor is *permanently*
      // busy, which is far worse than having no indicator at all – it would turn every future
      // turn into a wait for the full ceiling.
      const states = [...seen]
        .filter((pair) => !atRest.has(pair))
        .map((pair) => {
          const [attr, ...rest] = pair.split('=');
          return `${button.css}[${attr}="${CSS.escape(rest.join('='))}"]`;
        });

      return [...states, ...replacements]
        .filter((css) => deepQuerySelectorAll(css).length === 0);
    },
  };
}

/**
 * A CSS selector for an element that is no longer on the page.
 *
 * Deliberately **not** `selectorFor`, which proves a candidate by counting how many elements it
 * matches. That contract is right for everything else here and useless for this one: a busy
 * indicator is identified precisely by having gone, so it matches nothing at the moment we want
 * to name it. Correctness comes from the other direction instead – two exchanges have to
 * produce the same signature, and the runtime re-checks it against a live page before relying
 * on it.
 *
 * A value is used where one is present and looks durable, and dropped otherwise, because
 * `[data-x]` is a role marker where `[data-x="event_34s3…"]` is one instance of it.
 */
function busySignature(el) {
  const tag = el.tagName?.toLowerCase();
  if (!tag) return null;

  for (const attr of STABLE_ATTRS) {
    const value = el.getAttribute?.(attr);
    if (!value || isGeneratedID(value)) continue;
    return `${tag}[${attr}="${CSS.escape(value)}"]`;
  }

  // No usable value: fall back to the presence of a role-ish attribute name.
  const [name] = roleAttributes(el);
  return name ? `${tag}[${name}]` : null;
}

function recordAnswer(element, firstSeenAt, vanished = []) {
  session.answers.push({ element, firstSeenAt, vanished });

  if (session.answers.length < 2) {
    session.emit({ kind: 'reply_pending', repliesSoFar: session.answers.length });
    return;
  }

  const [first, second] = session.answers.slice(-2);
  const selector = selectorForBoth(first.element, second.element);

  // Nothing described both. Say so rather than falling back to one of them – a selector for
  // one answer is exactly the failure this whole path exists to prevent, and it is worse than
  // no capture because it validates.
  if (!selector) {
    session.emit({
      kind: 'reply_pending',
      repliesSoFar: session.answers.length,
      noCommonSelector: true,
      // Shape, not content – see `describePair`. Without it this failure is a dead end, which
      // is the same gap that cost two rounds on the reply selector already.
      shape: describePair(first.element, second.element),
    });
    return;
  }

  // **Two exchanges have to name the same thing.** One vanished element is noise – a tooltip,
  // a scroll shadow, a re-render – and any page produces several. The one that appeared and
  // left during *both* answers is the vendor's own busy signal, and the same two-sample
  // discipline that stops a per-message id being mistaken for the answer container applies
  // here for the same reason.
  //
  // Optional throughout: a vendor that shows nothing while it works simply has no such element,
  // and the runtime falls back to the quiet period it uses today.
  // Matched on the selector and kept at its *shorter* span, so a candidate has to have covered
  // the answer in both exchanges rather than in the lucky one.
  const shared = first.vanished
    .map((a) => {
      const b = second.vanished.find((other) => other.sig === a.sig);
      return b ? { sig: a.sig, span: Math.min(a.span, b.span), fromButton: a.fromButton } : null;
    })
    .filter(Boolean);

  // **A send-button state beats a vanishing element**, and the reason is provenance rather than
  // shape. The button is an element the recording already captured and the dry run is about to
  // drive; its states are the vendor deliberately saying what it is doing. A vanished `div` is
  // whatever the page happened to remove while we were watching, which is often a tooltip or a
  // scroll shadow and is only ever circumstantial.
  //
  // Within a kind, the narrowest wins: a selector carrying a value names the control, while a
  // bare `[attr]` may also match its container – and stopping on a container means calling the
  // answer finished while the spinner inside it is still turning.
  // A flag rather than a string test, because the strongest candidate of all does *not* share
  // the send button's selector: Notion's stop button is a different element in the same place,
  // and prefix-matching would have ranked the vendor's own "I am working" control below a
  // random `div` that happened to come and go.
  const isButton = (candidate) => candidate.fromButton === true;

  // **Anything that covered less than half the answer is thrown away, not merely ranked last.**
  // A candidate that was on screen for 300 ms of a four-second answer is not describing that
  // answer, and recording it would leave the runtime watching for something that says nothing.
  // Having no indicator is an honest state with a working fallback; having a meaningless one is
  // a wrong answer wearing a tick.
  const answerMs = Math.max(1, second.firstSeenAt - session.submittedAt);
  const ranked = shared
    .filter((candidate) => isButton(candidate) || candidate.span >= answerMs * 0.5)
    .sort((a, b) => {
      // The vendor's own control first – it says what it is doing, where an element that came
      // and went is only ever an inference about what the page was up to.
      if (isButton(a) !== isButton(b)) return isButton(b) ? 1 : -1;
      // Then whichever covered more of the answer.
      return b.span - a.span;
    });

  const busySelector = ranked[0]?.sig ?? null;
  // Which of the two found it, shown on the card. They are not equally trustworthy, so "we have
  // one" is not the whole answer – a button state is the vendor saying what it is doing, and a
  // vanished element is an inference from what the page happened to remove.
  const busyFrom = ranked[0] ? (isButton(ranked[0]) ? 'button' : 'element') : null;

  // Timed and measured from the *second* answer, which is the one seen under normal
  // conditions: the first often lands on a freshly opened panel that is still warming up.
  emitReply(selector, second.element, second.firstSeenAt, busySelector, busyFrom);
}

function emitReply(selector, element, firstSeenAt, busySelector = null, busyFrom = null) {
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
      // When the chosen element *appeared*, not when the answer finished – that is what the
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
      // What the vendor showed while it was working, if anything. Null is an ordinary answer,
      // not a failure – see `recordAnswer`.
      busySelector,
      busyFrom,
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
