// What the side panel says while you are over in the vendor's page.
//
// Ported from `Sources/OpenPosseUI/CoachingState.swift`, pure and already tested there.
//
// **The side panel does the coaching because it stays beside the page.** The recording happens
// in the vendor's own tab, and a popup closes the moment focus leaves it – someone standing in a
// page with nothing telling them what to do. Until 2026-10-24 the in-page orb could do it too;
// it was retired and the panel is the only surface. Naming happens in Settings.
//
// Free of any view, deliberately. This is the part with rules in it.

import { isComplete, problems } from './draft.js';

/**
 * How long to wait for the assistant to open before offering a way out.
 *
 * `design/NOTES.md` left this unset with a reason – *"wants a real observation, not a guess"* –
 * so here is the observation. Arm-to-open, across five recordings on 2026-09-07:
 *
 * | Run | Seconds |
 * |---|---|
 * | LeanIX-style shortcut | 5 |
 * | Notion ⌘O | 5 |
 * | Notion ⌘O | 6 |
 * | Notion, opened by clicking | 13 |
 * | Notion, opened by clicking | 14 |
 *
 * Clicking takes markedly longer than a shortcut, because finding a button is a search and
 * pressing keys you already know is not.
 *
 * **45 seconds – roughly three times the slowest observed.** The margin is deliberate and the
 * reason is the sample: five runs by someone who built the thing and knew exactly where to
 * click. A first-time user hunting an unfamiliar menu is the case this has to serve, and
 * nothing here measures them. Erring long costs a few seconds of an offer nobody needed;
 * erring short interrupts someone mid-search to tell them they failed.
 *
 * Revisit when there is data from somebody who has not seen this before.
 */
export const PATIENCE_MS = 45_000;

/**
 * The state to show, from what has been captured so far.
 *
 * Pure, so the rules can be checked without a window: given a draft, whether the assistant was
 * already open when recording armed, and how long ago that was.
 *
 * `patienceMs` is a parameter rather than a read of the constant because the caller arms a
 * timer with it – and a threshold living in two places is a threshold that can disagree with
 * itself. It did: a coordinator waiting 20 ms against a `derive` comparing 45 s never produced
 * `nothing-happened` at all.
 */
export function derive(draft, { alreadyOpen = false, sinceArmedMs = 0, patienceMs = PATIENCE_MS } = {}) {
  if (draft.abandonedMidCapture) return { step: 'abandoned' };
  if (isComplete(draft)) return { step: 'done', captures: captures(draft) };

  // Checked before the open-step states below: by the time an answer has arrived the assistant
  // is plainly open, and asking about opening it again would be absurd.
  if (draft.noCommonReplySelector) return { step: 'replies-share-nothing' };
  if (!draft.reply && draft.repliesSeen > 0) return { step: 'needs-second-answer' };

  // Nothing captured and the panel was already open when we armed. **These controls are usually
  // toggles** (an M2 finding), so pressing the shortcut now would *close* it and record the
  // wrong thing. Say that rather than waiting for a press that cannot help.
  if (!draft.openMethod && alreadyOpen) return { step: 'already-open' };

  if (draft.openMethod) {
    // Confirmation is load-bearing: someone who cannot see that the shortcut registered will
    // press it again, and the second press shuts the panel.
    return {
      step: 'opened',
      keys: draft.openMethod === 'shortcut' ? keycaps(draft.shortcut) : [],
      control: draft.openMethod === 'click' ? (draft.openSelector?.css ?? null) : null,
    };
  }

  // Only while waiting for the *open* step. Once it is open we are waiting for a person to type
  // a question, which has no business being hurried – the recording's own deadline covers
  // someone who wandered off.
  if (sinceArmedMs >= patienceMs) return { step: 'nothing-happened' };

  return { step: 'await-open' };
}

/** `SETTING UP · 1 OF 2`, above the instruction. */
export function stepLabel(state) {
  switch (state.step) {
    case 'await-open':
    case 'already-open':
    case 'nothing-happened':
      return 'SETTING UP · 1 OF 2';
    case 'opened':
    case 'needs-second-answer':
    case 'replies-share-nothing':
      return 'SETTING UP · 2 OF 2';
    case 'done':
      return 'SETTING UP · DONE';
    default:
      return 'SETTING UP';
  }
}

/**
 * `Lassoing Notion…`, the side panel's heading for the whole recording.
 *
 * `product` is `productLabel` of the site being recorded, passed in so this stays pure. Past
 * tense once it is saved, because the ellipsis promises something still happening.
 */
export function heading(step, product) {
  const what = product || 'an AI assistant';
  return step === 'done' ? `Lassoed ${what}` : `Lassoing ${what}…`;
}

/** Whether this can still be abandoned. `done` is already leaving. */
export function isCancellable(state) {
  return state.step !== 'done';
}

/**
 * The sentence shown to the person doing the recording.
 *
 * Drawn from `problems()` where one applies, so the wording that was written once for the
 * wizard is not written a second time here and allowed to drift from it.
 */
export function instruction(state, draft) {
  const says = (id) => problems(draft).find((p) => p.id === id)?.message;

  switch (state.step) {
    case 'await-open':
      // An ask, not `says('open')`: that sentence reports a missing step ("We didn’t see the AI
      // assistant open"), and it is always true here, so it greeted every recording as though
      // something had already gone wrong. The click preference stays, for the reason `problems()`
      // gives.
      return 'Open the AI assistant. Click its button if it has one – we can’t always press a '
        + 'keyboard shortcut on your behalf.';
    case 'already-open':
      return 'The AI assistant is already open. Close it first – the shortcut usually toggles, so '
        + 'pressing it now would shut it and we’d record the wrong thing.';
    case 'opened':
      return says('input') ?? says('submit') ?? says('reply')
        ?? 'Now ask it something.';
    case 'needs-second-answer':
      return says('needs-second-answer');
    case 'replies-share-nothing':
      return says('replies-share-nothing');
    case 'nothing-happened':
      // **The `isTrusted` case and the wrong-keys case are indistinguishable from here**, so
      // this offers both answers rather than guessing which happened.
      return 'We haven’t seen it open yet. If it opens from a button, click that instead – and '
        + 'if you pressed a shortcut, try it once more.';
    case 'abandoned':
      return says('navigated-away');
    case 'done':
      return 'That’s everything. Checking it works…';
    default:
      return '';
  }
}

/** A shortcut as the glyphs on the keys, in the order macOS writes them. */
export function keycaps(shortcut) {
  if (!shortcut) return [];
  const caps = [];
  if (shortcut.ctrlKey) caps.push('⌃');
  if (shortcut.altKey) caps.push('⌥');
  if (shortcut.shiftKey) caps.push('⇧');
  if (shortcut.metaKey) caps.push('⌘');
  caps.push(shortcut.key?.length === 1 ? shortcut.key.toUpperCase() : shortcut.key);
  return caps;
}

/**
 * The checklist shown when everything is in hand, in the order the captures were made.
 *
 * `isKeys` renders as keycaps rather than a code chip – a shortcut is something you pressed,
 * not page structure.
 */
export function captures(draft) {
  const rows = [];

  if (draft.openMethod === 'shortcut') {
    rows.push({
      id: 'open', label: 'Opens with', detail: keycaps(draft.shortcut).join(' '), isKeys: true,
    });
  } else if (draft.openMethod === 'click') {
    rows.push({ id: 'open', label: 'Opens from', detail: draft.openSelector?.css ?? '' });
  }

  if (draft.input) {
    rows.push({ id: 'input', label: 'Message box', detail: draft.input.css });
  }

  if (draft.submitMethod === 'click') {
    rows.push({ id: 'submit', label: 'Send button', detail: draft.submitSelector?.css ?? '' });
  } else if (draft.submitMethod === 'enterKey') {
    rows.push({ id: 'submit', label: 'Sends with', detail: '↩', isKeys: true });
  }

  if (draft.reply) {
    rows.push({ id: 'reply', label: 'Answer appears', detail: draft.reply.selector?.css ?? '' });

    // **Shown whether or not it was found, which is the point of the row.**
    //
    // This is the one capture that is optional – a vendor showing nothing while it works is
    // ordinary, not a failure – and that is exactly why its absence has to be visible. A row
    // that only appears on success cannot answer "did it get it?", and the alternative was
    // reading a service-worker console that is not always there to read.
    //
    // It is also the difference between a turn that waits ~900 ms after an answer and one that
    // waits ~4 s, so it is worth a line on the card that says which of those you just bought.
    rows.push(draft.reply.busySelector
      ? {
        id: 'busy',
        label: 'Knows when done',
        detail: draft.reply.busySelector,
        // Which signal found it. A send-button state is the vendor saying what it is doing; a
        // vanished element is an inference from what the page happened to remove, and the two
        // deserve different amounts of confidence when one of them turns out to be wrong.
        kind: draft.reply.busyFrom === 'button' ? 'THE SEND CONTROL' : 'APPEARS WHILE BUSY',
      }
      : {
        id: 'busy',
        label: 'Knows when done',
        detail: 'nothing to watch – using a timer',
        absent: true,
      });
  }

  return rows;
}
