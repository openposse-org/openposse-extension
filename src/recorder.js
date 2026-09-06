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
import { selectorFor } from './selector.js';

/** Text long enough to be an answer rather than a label or a spinner. */
const MIN_ANSWER_TEXT = 40;

/** How long after a submit we keep waiting for the answer before giving up. */
const REPLY_WINDOW_MS = 120_000;

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
    submittedAt: null,
    // Everything on the page at submit time. The reply selector's `matchesBefore` is the
    // number of its matches that were already here — which is what proves the selector gained
    // one, rather than naming the transcript that merely grew longer.
    preexisting: null,
    replyTimer: null,
    listeners: [],
    observer: null,
  };

  armShortcut();
  armInput();
  armSubmit();
  armNavigation();

  emit({ kind: 'armed' });
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

    session.emit({
      kind: 'shortcut',
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

// MARK: - 2. The message box

function armInput() {
  // `focusin`, not `click`. The common case is that the panel opens and focuses its composer
  // for you — no click happens at all, and a click listener would sit waiting through a
  // perfectly normal interaction.
  const handler = (event) => {
    const el = event.target;
    if (!isEditable(el) || !isVisible(el)) return;
    if (session.input === el) return;

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
    const button = event.target?.closest?.('button, [role="button"]');
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
  const observer = new MutationObserver((records) => {
    const added = [];
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1) added.push(node);
      }
    }
    if (added.length === 0) return;

    const reply = chooseReplyElement(added);
    if (!reply) return;

    observer.disconnect();
    clearTimeout(session.replyTimer);
    session.observer = null;
    emitReply(reply);
  });

  observer.observe(document.body, { childList: true, subtree: true });
  session.observer = observer;

  session.replyTimer = setTimeout(() => {
    observer.disconnect();
    session.observer = null;
    // No event. The draft stays missing its reply and the wizard already says what is
    // outstanding — inventing a failure event here would give the app two things to explain.
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
function chooseReplyElement(added) {
  const candidates = added.filter((el) => {
    if (!isVisible(el)) return false;
    if (session.input && el.contains(session.input)) return false;
    return (el.innerText ?? '').length >= MIN_ANSWER_TEXT;
  });
  if (candidates.length === 0) return null;

  const custom = candidates.find((el) => el.tagName.includes('-'));
  if (custom) return custom;

  // Outermost: no other candidate contains it.
  return candidates.find((el) => !candidates.some((other) => other !== el && other.contains(el)))
    ?? candidates[0];
}

function emitReply(element) {
  const selector = selectorFor(element);
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
      elapsedMs: Date.now() - session.submittedAt,
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
