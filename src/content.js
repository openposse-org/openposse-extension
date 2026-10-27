// Content script – the only code that touches a vendor's page.
//
// It is driven entirely by the lasso the service worker hands it. There are no vendor
// selectors in this file, and there must never be: selectors come from recordings, so a
// literal `[data-testid=…]` here would mean the recorder is missing a capture step.
//
// It also exposes no generic primitives. `click(selector)` and `type(selector, text)` would
// be a much larger security surface and would fail silently in the wrong place; the intents
// below fail loudly and specifically instead.

import {
  deepQuerySelector,
  deepQuerySelectorAll,
  deepQuerySelectorVisible,
  pressShortcut,
  setEditableText,
  setInputValue,
  streamResponse,
  waitForElement,
  waitForEnabled,
  waitForNewMatch,
} from './dom.js';
import {
  arm as armRecorder, disarm as disarmRecorder, isArmed, MIN_ANSWER_TEXT,
} from './recorder.js';
import { tell } from './tell.js';
import { graceWindow } from './grace.js';
import { DONE_IN_VIEW_MS, DONE_MS, original, STATES, withState } from './title.js';

/** Error codes this script can originate, unchanged from the Mac app's wire protocol. */
const ERROR = {
  elementNotFound: 'ELEMENT_NOT_FOUND',
  timeout: 'TIMEOUT',
  unsupportedIntent: 'UNSUPPORTED_INTENT',
  authRequired: 'AUTH_REQUIRED',
};

function failure(code, message, extra = {}) {
  // `extra` carries diagnostics that survive a failure. Without it, a later step failing
  // hides what earlier steps established – the shortcut measurement vanished the moment the
  // send button lookup failed, which is precisely when it was most worth knowing.
  return { ok: false, code, message, ...extra };
}

/**
 * Opens a closed assistant, by whichever route was recorded.
 *
 * **A click is the better route where a vendor offers both**, for the same reason
 * `submitMethod` prefers a button over a synthetic Enter: browsers mark JS-dispatched key
 * events `isTrusted: false` and some vendors ignore them silently, while a synthetic click on
 * a real control is almost never gated that way. The recorder records what the user did; this
 * just executes it.
 *
 * @returns the method that worked, for `Lasso.triggerMethod`, or null if nothing happened.
 */
async function openAssistant(lasso) {
  // A message box that is always on the page has nothing to open. Missing, it means the page
  // has changed, which the callers say with the lasso's date.
  if (lasso.openMethod === 'alwaysOpen') return null;
  if (lasso.openMethod === 'click') {
    if (!lasso.openSelector) return null;
    // Wait rather than demand it instantly: the control may be behind a menu that is still
    // rendering, and a page that is working perfectly can fail an immediate lookup.
    const control = await waitForElement(lasso.openSelector, { timeoutMs: 3000 });
    if (!control) return null;
    control.click();
    return 'click';
  }

  if (!lasso.shortcut) return null;
  pressShortcut(lasso.shortcut, document.activeElement ?? document.body);
  // Names the route so `Lasso.triggerMethod` never has to guess. A null from the caller is
  // the `isTrusted` rejection: the browser marks JS-dispatched key events untrusted and some
  // vendors ignore them silently, with no error to catch – the panel not appearing is the
  // only signal there is.
  return 'synthetic';
}

/**
 * Puts a question to the assistant and streams the answer back.
 *
 * Each step reports its own specific failure. A single "couldn't ask the assistant" would be
 * useless here: a missing input means the lasso needs re-recording, while a missing response
 * container after a successful submit usually means the vendor renamed one class – different
 * diagnosis, different fix.
 */
/**
 * Follows the element a vendor shows while it is working – a spinner, a "stop generating".
 *
 * Polled rather than observed, at 150 ms. A `MutationObserver` would need the whole document
 * with `subtree`, because the indicator can be anywhere and is usually nowhere near the answer,
 * and that fires on every keystroke of a streaming reply. One `deepQuerySelectorAll` six times
 * a second is the cheaper of the two by a wide margin, and it crosses shadow roots, which the
 * observer would have to be told about one root at a time.
 *
 * Returns `{ selector, finished(), everSeen(), stop() }` – the same four from both branches,
 * including the one for a lasso with no indicator at all. This comment described a `settled()`
 * that had already been replaced, and the stale name is part of why the no-indicator branch was
 * left returning it for so long.
 *
 * `finished()` is **true only when the indicator was seen and then left.** Never having seen it
 * is not the same claim: a vendor may show nothing, the lasso may predate this, or the selector
 * may have drifted – and in all three the honest answer is "I don't know", which is what the
 * clock is for.
 */
function watchBusy(selector, { timeoutMs, steadyMs = 900 }) {
  // **The same shape as the watching version, and it has to be checked by eye.**
  //
  // This branch returned `{ selector, settled, stop }` long after `settled()` was replaced by
  // `finished()` – the refactor documented below changed the object the other return builds and
  // left this one behind. Nothing calls `settled` any more, and `finished` was simply absent
  // here, so `busy.finished()` at the top of the answer loop threw `busy.finished is not a
  // function` for **every lasso without a busy indicator**.
  //
  // It went unseen because the vendor recorded at E8 has one, so the path that breaks is the one
  // a lasso recorded *before* indicators existed takes – and that is the shape every imported
  // lasso from the `lassos/` directory has. The symptom was a vendor answering normally while
  // the turn reported TIMEOUT.
  //
  // `finished()` is false rather than true on purpose, per the note above: never having seen an
  // indicator is not a claim that the vendor has stopped. The honest answer is "I don't know",
  // and the clock is what that answer costs.
  if (!selector) {
    return {
      selector: null,
      finished: () => false,
      everSeen: () => false,
      stop() {},
    };
  }

  let seen = false;
  let gone = false;
  // **When it went away, not merely that it did.** An answer is not one continuous act: Notion
  // reports "Working on your request", then "Taking a closer look", and the stop control goes
  // away *between* those phases. Treating the first disappearance as the end made the settle
  // fire while a status row was still the newest thing on the page, and that row was read out
  // as the answer.
  //
  // So the control has to be absent and *stay* absent. A gap between phases resets the clock;
  // only a steady absence counts as finished.
  let goneSince = null;
  const startedAt = Date.now();

  const timer = setInterval(() => {
    if (gone) return;
    if (deepQuerySelectorAll(selector).length > 0) {
      seen = true;
      goneSince = null;
    } else if (seen) {
      goneSince ??= Date.now();
      if (Date.now() - goneSince >= steadyMs) { gone = true; clearInterval(timer); }
    }
    if (Date.now() - startedAt > timeoutMs) clearInterval(timer);
  }, 150);

  return {
    selector,
    /**
     * Whether the vendor has finished – **read, never waited on.**
     *
     * The first version blocked here until the indicator cleared, and that was the mistake
     * that made a recorded vendor worse than an unrecorded one. It sat between reading the
     * first row and the re-pick loop, so every row that arrived during it was already counted
     * as "before" by the time the loop took its baseline – and the loop then waited for a
     * further row that was never coming, breaking with a status row as the answer. Measured:
     * two passes where the same vendor without an indicator took three and answered correctly.
     *
     * An indicator is information about the wait, not a substitute for it. Read at the moment
     * the loop decides how long to be patient, it can only ever shorten that patience, and it
     * cannot consume the window the loop needs.
     */
    finished() { return gone; },
    /** Whether it was ever there, so "no indicator" can be told from "still working". */
    everSeen() { return seen; },
    stop() { clearInterval(timer); },
  };
}

async function askAssistant({ lasso, prompt, graceMs = null }, emit) {
  // Open the assistant if it is closed, rather than failing.
  //
  // Checking first is what makes the shortcut safe to send at all: these shortcuts are
  // usually *toggles*, so pressing one blind would close a panel that was already open –
  // turning a working request into a failure, and doing it more reliably the better the
  // rest of the code works.
  let openedBy = 'already-open';
  // Visible, not merely present. LeanIX keeps the panel mounted when closed, so a presence
  // check reports "already open" for a shut panel – which is exactly what happened the first
  // time this was measured, and it silently skipped the thing under test.
  let input = deepQuerySelectorVisible(lasso.inputSelector);

  // What the page no longer has, for a lasso that opens by click: the button it clicks, or the
  // box that should have appeared. That is the sign the page has changed since the recording, and
  // the worker says so with the lasso's date. A shortcut that opened nothing is more likely the
  // page ignoring synthetic keys, which its own message below explains.
  let missing = null;
  if (!input) {
    openedBy = await openAssistant(lasso);
    input = await waitForElement(lasso.inputSelector, { timeoutMs: 3000 });
    if (!input && lasso.openMethod === 'click') missing = openedBy ? 'input' : 'open';
    if (!input && lasso.openMethod === 'alwaysOpen') missing = 'input';
    if (!input) openedBy = null;
  }

  if (!input) {
    return failure(
      ERROR.timeout,
      lasso.openMethod === 'alwaysOpen'
        ? 'the AI assistant’s message box is not on the page'
        : lasso.openMethod === 'click'
        ? 'the AI assistant did not open when its button was clicked'
        // **The old text here told the user to rely on the Mac app**, which is parked – it
        // said "needs the app to post a real event", describing a retry path that no longer
        // exists and cannot be reached. A message naming a fix that is unavailable is worse
        // than a bare failure: it sends somebody looking for a setting they do not have.
        //
        // What is true: some vendors check `isTrusted` and ignore keystrokes that came from a
        // script, and there is nothing this extension can do about that. Notion is one of
        // them, and it also offers a button – so the fix is a re-recording that opens it by
        // clicking, which is exactly what the message now says.
        : 'this AI assistant ignores keyboard shortcuts it did not get from a person. '
          + 'Re-record it from Settings and open the AI assistant by clicking its button '
          + 'instead of using the shortcut.',
      { openedBy: null, missing }
    );
  }

  // Count existing replies BEFORE submitting. On a chat page the previous answers are still
  // in the DOM, so "wait for the response container" would match one of those immediately and
  // we would stream last turn's answer back as though it were this one.
  const repliesBefore = deepQuerySelectorAll(lasso.responseContainerSelector).length;

  // Named so it can be re-applied: when the assistant has *just* opened, the framework may
  // not have bound to the input yet, and a value set before that is silently discarded.
  const applyPrompt = () => {
    if (input.isContentEditable) {
      setEditableText(input, prompt);
    } else {
      setInputValue(input, prompt);
    }
  };
  // The tab's title follows the turn: `typing…` now, `answering…` once it is sent. Reported
  // rather than written here, because this frame may be an iframe, and only the top frame's
  // title is the tab's. The worker passes it on; see `show_turn_state` below.
  emit({ kind: 'tab_state', state: 'typing' });
  applyPrompt();

  // Prefer the button. A click is far less likely to be gated on `isTrusted` than a
  // synthetic Enter, which is why the recorder records the button when one exists.
  if (lasso.submitMethod === 'click') {
    // Wait rather than demand it instantly. A panel that just opened is often still
    // rendering, and some vendors only mount or enable the send control once the input has
    // content – so an immediate lookup fails on a page that is working perfectly.
    const button = lasso.submitSelector
      ? await waitForElement(lasso.submitSelector, { timeoutMs: 3000 })
      : null;
    if (!button) {
      return failure(ERROR.elementNotFound, 'send button not found', { openedBy });
    }
    // Wait for it to enable rather than checking once. On a freshly opened panel the button
    // exists but the framework is still binding, so an instant check reports the
    // React-setter trap for what is only a race with hydration.
    const enabled = await waitForEnabled(button, { timeoutMs: 3000, reapply: applyPrompt });
    if (!enabled) {
      // Now it means something: the value was applied twice, three seconds apart, and the
      // control never accepted it.
      return failure(
        ERROR.elementNotFound,
        'send button stayed disabled – the input never registered',
        { openedBy }
      );
    }
    button.click();
  } else {
    pressShortcut({ key: 'Enter' }, input);
  }
  emit({ kind: 'tab_state', state: 'answering' });

  // From the lasso, not a constant. The vendor decides how long it thinks for, and a
  // hardcoded ceiling reports a healthy-but-slow answer as a broken agent.
  const responseTimeoutMs = lasso.responseTimeoutMs ?? 60000;

  // How long to keep waiting for a row *after* the one we read has gone quiet.
  //
  // It has to cover a model thinking, which is why it is seconds rather than the few hundred
  // milliseconds a render takes. Bounded rather than given the whole remaining budget, because
  // this is also the latency a vendor that only ever adds one row pays on every exchange, and
  // a minute of that would be unusable.
  //
  // The honest fix is to record the vendor's own "still generating" indicator during setup –
  // Notion shows one – and wait on that disappearing instead of on a clock. That is a recorder
  // change, so it belongs to E8. Until then this is a guess with a ceiling.
  //
  // The number, and why it is that number, live in `grace.js`. `graceMs` is the panel's debug
  // override when one is set, carried here by the worker because this script cannot read session
  // storage; `graceWindow` turns anything absent or malformed back into the default.
  const grace = graceWindow(graceMs);

  /**
   * Which of the rows that appeared is the answer.
   *
   * **Some vendors do not let a selector name answers at all.** Measured on Notion: after one
   * exchange the transcript holds three rows – the question, the answer, and a seven-character
   * trailer – and all three carry an identical set of attributes. The recorder tried every
   * strategy it has and `div[data-agent-service-find-row]` was genuinely the tightest thing
   * that described both recorded answers. There is nothing tighter to find.
   *
   * So the lasso names rows and this decides which row, using the one thing the page cannot
   * confuse us about: **we know what we typed.** The row echoing our own prompt is the
   * question, by construction rather than by guess.
   *
   * It does not read anything the user wrote – only our own prompt, and only to exclude it.
   */
  const withoutOurQuestion = (all) => {
    const fresh = all.slice(repliesBefore);
    const needle = prompt.slice(0, 48);

    // Not the row echoing our own question.
    const notOurs = fresh.filter(
      (el) => !needle || !(el.innerText ?? '').includes(needle)
    );
    // Falling back to `fresh` matters: a vendor that does not echo the question at all would
    // otherwise filter away nothing and, on a page that does, filter away everything.
    let pool = notOurs.length > 0 ? notOurs : fresh;

    // ...and not the furniture around it.
    //
    // **The last row on Notion is a timestamp.** Excluding the question left the answer *and*
    // a seven-character "6:44 PM", and taking the last of those read the clock aloud. The
    // trailing seven-character row from the recorded shape was that, all along.
    //
    // This was considered and dropped once, on the grounds that it cannot exclude the
    // 45-character status row – which is true, and was the wrong conclusion. The status row
    // and the timestamp are different problems: one is transient and is caught by re-picking
    // after the page settles, the other is permanent and is caught by its size. Two rows, two
    // rules; keeping only one of them left the other in place.
    const substantial = pool.filter(
      (el) => (el.innerText ?? '').length >= MIN_ANSWER_TEXT
    );
    // Only when something qualifies. An assistant that genuinely answers "Yes." is rare but
    // real, and filtering it to nothing would be worse than reading it.
    if (substantial.length > 0) pool = substantial;

    return pool[pool.length - 1] ?? null;
  };

  // **Watching the vendor say it is working, from the moment the question goes in.**
  //
  // Started here rather than when we come to need it, because by then it may already be over:
  // the first pass spends a quiet period reading the first row, and a fast answer can have
  // come and gone inside it. "Never appeared" and "appeared and finished" need opposite
  // responses, and only something watching the whole time can tell them apart.
  // `steadyMs` is the vendor's own measured quiet period, so "it has stopped for as long as it
  // ever pauses mid-answer" is the test, rather than a number invented here.
  const busy = watchBusy(lasso.busySelector, {
    timeoutMs: responseTimeoutMs,
    steadyMs: lasso.quietPeriodMs ?? 900,
  });

  // Timed and returned, not logged. This runs in the vendor's page, so a console line lands in
  // *their* DevTools – which is why "vendor answered +8068ms" could not be split into how much
  // was the model thinking and how much was us waiting out quiet periods.
  const waitedAt = Date.now();
  let passes = 0;

  let container = await waitForNewMatch(
    lasso.responseContainerSelector, repliesBefore,
    // `quietPeriodMs` is the vendor's own measured "things have stopped changing", recorded
    // per lasso rather than guessed – the right order of magnitude for how long to wait in
    // case a status row is about to be followed by the real answer.
    {
      timeoutMs: responseTimeoutMs,
      settleMs: lasso.quietPeriodMs ?? 900,
      choose: withoutOurQuestion,
    }
  );
  const firstRowAt = Date.now();
  if (!container) {
    // Distinguish "sent, and the vendor never answered" from "never actually sent".
    //
    // A synthetic Enter is `isTrusted: false` and some vendors ignore it exactly the way they
    // ignore a synthetic shortcut – the text lands in the composer and simply sits there. Both
    // failures time out identically, and they need opposite fixes: one is a slow or broken
    // assistant, the other means this lasso should have recorded the send *button*.
    //
    // Our own prompt, not page content: checking for it reads nothing the user wrote.
    const remaining = (input.value ?? input.textContent ?? '');
    const submitRejected = prompt.length > 0 && remaining.includes(prompt.slice(0, 24));

    return failure(
      ERROR.timeout,
      submitRejected
        ? 'the message was typed but sending it did nothing – the vendor ignored a synthetic Enter'
        : `no new response within ${Math.round(responseTimeoutMs / 1000)}s`,
      { openedBy, submitRejected }
    );
  }

  // Read, then look again – because a status row is only knowable as one in hindsight.
  //
  // Notion shows "Working on your request" before it shows the answer, and from the DOM that
  // row is indistinguishable from a reply: same attributes, same shape, and at 45 characters
  // it clears any sensible minimum length. Waiting longer does not separate them either, since
  // the gap between the two is the model thinking – seconds, not the few hundred milliseconds
  // a render takes to settle.
  //
  // What *is* decidable is what happened afterwards. Once the page goes quiet, we pick again:
  // if the best row is no longer the one we read, the one we read was transient and the answer
  // has since arrived. This works whether the vendor removes the status row or overwrites it,
  // which matters because we do not know which Notion does and guessing has already cost four
  // rounds.
  //
  // Bounded at three passes. Each ends in a quiet period, so a page that never settles is
  // still held by `responseTimeoutMs` in the wait above rather than by this loop.
  // **The grace exists only because we could not tell when the vendor had stopped.** Where it
  // tells us, ask it: if its own indicator has been and gone, nothing further is coming and
  // there is nothing to wait for. Measured before this, `settling` was a flat ~4 s on every
  // successful turn, most of it spent discovering that a row which was never going to arrive
  // had not arrived.
  //
  // **Nothing is awaited here.** The grace is decided inside the loop, from the indicator's
  // state at the moment each pass begins – see `watchBusy.finished`.
  let text = '';
  let readFrom = null;
  for (let pass = 0; pass < 3; pass += 1) {
    const current = pass === 0
      ? container
      // **Wait for a further row rather than looking again immediately.**
      //
      // Re-picking on the spot was the bug: the status row goes quiet after ~900 ms, but the
      // gap before the answer is the model *thinking* – seconds. So the second pass ran while
      // the transcript still held exactly what the first pass had read, found the same element,
      // and broke with the status text as the answer. Notion's own screen disagreed, because
      // by then it had replaced "Working on your request" with the joke.
      //
      // `waitForNewMatch` returns the moment a row arrives, so a vendor that adds one costs
      // nothing. A vendor that never adds another pays the grace once and then returns
      // null, ending the loop with the text we already had – which is the right answer for it.
      : await waitForNewMatch(
        lasso.responseContainerSelector,
        deepQuerySelectorAll(lasso.responseContainerSelector).length,
        {
          // **The grace shrinks after the first extra pass.** It exists for the gap between a
          // status row and the answer, which is the model thinking – seconds, and only once.
          // Applying it again on every later pass meant a successful exchange still paid the
          // full ceiling before reporting, so an answer visible in the vendor's tab took ten
          // more seconds to reach the panel. That was measured as lag by the person using it,
          // not by a test.
          // **The grace only shrinks once the vendor has actually stopped**, read here rather
          // than waited for earlier. While it is still working, this pass is the one that
          // catches the answer row, and shortening it is how a status row got spoken instead.
          timeoutMs: Math.min(
            pass === 1 && !busy.finished() ? grace : (lasso.quietPeriodMs ?? 900),
            responseTimeoutMs,
          ),
          settleMs: lasso.quietPeriodMs ?? 900,
          choose: withoutOurQuestion,
        },
      );

    passes = pass + 1;
    // The same row twice means the page has settled on it. That is the answer.
    if (!current || current === readFrom) break;

    readFrom = current;
    container = current;
    text = await streamResponse(current, {
      quietPeriodMs: lasso.quietPeriodMs ?? 900,
      // Partials keep flowing so speech can start early, which is the whole latency argument
      // for driving a page. The cost is that a status row can be spoken before it is known to
      // be one; the app replaces the answer on `.done`, so what is left on screen is right.
      onDelta: (delta) => emit({ kind: 'partial_result', text: delta }),
      // Picked the same way as the first time, for a page that replaces the element mid-answer.
      refind: () => withoutOurQuestion(deepQuerySelectorAll(lasso.responseContainerSelector)),
    });
  }

  // The poll is only useful while a turn is in flight, and a turn that ended without stopping
  // it would leave one running every 150 ms for the life of the page.
  busy.stop();

  // Transport diagnostics, not content: how many reply elements existed before and after.
  // Without these, "Andy answered" and "Andy re-read the previous answer" are the same
  // observation – the text alone cannot distinguish them, especially when the question is
  // the same each time.
  return {
    ok: true,
    text,
    repliesBefore,
    repliesAfter: deepQuerySelectorAll(lasso.responseContainerSelector).length,
    openedBy,
    // How long the first row took to appear against how long the re-pick loop then spent. The
    // first is the vendor thinking and is not ours to fix; the second is quiet periods and
    // grace windows, and is entirely ours.
    ms: {
      firstRow: firstRowAt - waitedAt,
      settling: Date.now() - firstRowAt,
      passes,
      // Which of the three cases decided the settle, because they produce very different
      // numbers and are otherwise indistinguishable from the outside: the vendor told us it had
      // finished, it has an indicator we never saw, or it has none recorded at all.
      // The selector is included when it did not work, because "there is an indicator recorded
      // and it never cleared" is only actionable if you can see which element was recorded.
      busy: !lasso.busySelector
        ? 'none'
        : (busy.finished()
          ? 'watched'
          : `never cleared: ${lasso.busySelector}`),
    },
  };
}

/** Reads the last answer without asking anything – "say that again". */
function getLastResponse({ lasso }) {
  const all = deepQuerySelectorAll(lasso.responseContainerSelector);
  // The *last* match. On a chat page the first is the opening reply of the conversation,
  // which is not what "say that again" means.
  const container = all[all.length - 1];
  if (!container) return failure(ERROR.elementNotFound, 'no response container on the page');
  return { ok: true, text: container.innerText ?? '' };
}

/**
 * Opens the assistant via its keyboard shortcut.
 *
 * Reports `TIMEOUT` and stops when nothing changes. It does **not** retry, try a different
 * key, or decide the retry worked – the app owns the `CGEventPost` fallback, because the host
 * inherits no TCC permissions from Chrome and the extension cannot post a trusted event at
 * all.
 */
async function invokeViaShortcut({ lasso }) {
  // Never act blind. These controls are usually *toggles*, so opening one that is already open
  // closes it – turning a working state into a broken one, and looking like the trigger failed.
  if (deepQuerySelectorVisible(lasso.inputSelector)) {
    return { ok: true, openedBy: 'already-open' };
  }

  const openedBy = await openAssistant(lasso);

  const input = await waitForElement(lasso.inputSelector, { timeoutMs: 3000 });
  if (!input) {
    // For a shortcut this is very likely `isTrusted: false` being rejected. There is no
    // fallback: the `CGEventPost` retry belonged to the Mac app, which is parked, and nothing
    // in a browser can post a trusted event. So the honest remedy is a different recording.
    if (lasso.openMethod === 'alwaysOpen') {
      return failure(ERROR.timeout, 'the AI assistant’s message box is not on the page');
    }
    return failure(ERROR.timeout, lasso.openMethod === 'click'
      ? 'the AI assistant did not open when its button was clicked'
      : 'this AI assistant ignores keyboard shortcuts it did not get from a person – '
        + 'record it again, opening the AI assistant by clicking its button');
  }
  return { ok: true, openedBy };
}

/**
 * Arms the recorder on this page (M3).
 *
 * Returns as soon as the listeners are attached. The captures themselves arrive over the next
 * few minutes on their own channel, because what they are waiting for is a person finding a
 * menu item and typing a question.
 */
function armRecording() {
  armRecorder({
    emit: (event) => {
      // The worker may have been terminated, or this page may be running a previous build.
      // Losing one capture is survivable and the wizard's checklist already shows what is
      // still outstanding; throwing here would tear down the recording over it.
      tell({ kind: 'openposse.recording', event });
    },
  });
  return { ok: true };
}

function disarmRecording() {
  return { ok: true, wasArmed: isArmed() && disarmRecorder() };
}

/// Answers "are you there?" so the worker can tell an un-injected tab from a broken one.
function ping() {
  return { ok: true, href: location.origin };
}

/**
 * The tab's title during a turn, in the top frame only: `typing…`, `answering…`, `done`, then the
 * page's own title again. The words are in `title.js`; see `docs/tab-titles.md`.
 *
 * The worker sends the states, but everything that ends one lives here, in the page:
 * - **`done` ends when the page is looked at**, which `visibilitychange` reports however that
 *   happens: a click on the tab, "show me", or raising its window.
 * - **Every state has a ceiling**, timed in the page. The worker is stopped after about 30 s idle
 *   and an extension reload cuts it off from this script, so a title that waited for the worker
 *   could keep saying `answering…` for good.
 * - **A page that writes its own title keeps it.** Notion renames the tab after navigating, mail
 *   clients add counts. That title becomes the one to restore, with the state put back on top.
 *
 * A closed set of words, not a way to set a title: `state` is a key of `STATES`, or null.
 */
const turnTitle = {
  base: null,
  written: null,
  observer: null,
  timer: null,
  onVisible: null,
};

function writeTitle(state) {
  turnTitle.written = withState(turnTitle.base, state);
  document.title = turnTitle.written;
  // Setting the title can create the element, so the observer goes on after the write.
  watchTitle(state);
}

function watchTitle(state) {
  turnTitle.observer?.disconnect();
  turnTitle.observer = new MutationObserver(() => {
    if (document.title === turnTitle.written) return;
    turnTitle.base = original(document.title);
    writeTitle(state);
  });
  const element = document.querySelector('title');
  if (element) {
    turnTitle.observer.observe(element, { childList: true, characterData: true, subtree: true });
  }
  // A page that replaces the element rather than its text. Not `subtree`: the head is where
  // style tags come and go on every render, and only the title matters here.
  if (document.head) turnTitle.observer.observe(document.head, { childList: true });
}

function restoreTitle() {
  turnTitle.observer?.disconnect();
  clearTimeout(turnTitle.timer);
  if (turnTitle.onVisible) document.removeEventListener('visibilitychange', turnTitle.onVisible);
  if (turnTitle.base !== null && document.title === turnTitle.written) {
    document.title = turnTitle.base;
  }
  Object.assign(turnTitle, { base: null, written: null, observer: null, timer: null, onVisible: null });
}

function showTurnState({ state, clearAfterMs }) {
  if (state === null || state === undefined) {
    restoreTitle();
    return { ok: true };
  }
  if (!STATES[state]) return failure(ERROR.unsupportedIntent, `no tab-title state called ${state}`);
  if (window !== window.top) {
    return failure(ERROR.unsupportedIntent, 'the tab title belongs to the top frame');
  }

  turnTitle.base ??= original(document.title);
  writeTitle(state);

  clearTimeout(turnTitle.timer);
  // A missing ceiling would be `setTimeout(…, undefined)`, which fires at once.
  let ceiling = Number.isFinite(clearAfterMs) && clearAfterMs > 0 ? clearAfterMs : DONE_MS;
  // A tab already in view never becomes visible, so the listener below would never clear `done`
  // there and it sat for the whole 90 s. In view, it only has to show that the turn finished.
  if (state === 'done' && document.visibilityState === 'visible') {
    ceiling = Math.min(ceiling, DONE_IN_VIEW_MS);
  }
  turnTitle.timer = setTimeout(restoreTitle, ceiling);

  if (turnTitle.onVisible) {
    document.removeEventListener('visibilitychange', turnTitle.onVisible);
    turnTitle.onVisible = null;
  }
  if (state === 'done') {
    turnTitle.onVisible = () => { if (document.visibilityState === 'visible') restoreTitle(); };
    document.addEventListener('visibilitychange', turnTitle.onVisible);
  }
  return { ok: true };
}

const INTENTS = {
  ask_assistant: askAssistant,
  get_last_response: getLastResponse,
  invoke_via_shortcut: invokeViaShortcut,
  arm_recording: armRecording,
  disarm_recording: disarmRecording,
  show_turn_state: showTurnState,
  ping,
};

// Runs once per page, however many times the file is injected.
//
// A dynamically-registered content script only injects on *page load*, so a tab that was
// already open when the user granted access has none – and asking someone to reload the page
// they just chose is both bad and lossy. The worker therefore injects into the open tab with
// `executeScript`, which means this file can arrive twice: once from the injection, once from
// the registration on the next load. Without this guard the second copy adds a second
// `onMessage` listener and every intent is answered twice.
if (globalThis.__openposseContentScript) {
  console.debug('[openposse] content script already present');
} else {
  // Installed first, flagged second. The same rule as the orb's guard: a sentinel set before the
  // work claims a listener the page may not have, and every later injection then skips silently.
  install();
  globalThis.__openposseContentScript = true;
}

function install() {
  chrome.runtime.onMessage.addListener((request, _sender, respond) => {
  const handler = INTENTS[request?.intent];
  if (!handler) {
    respond(failure(ERROR.unsupportedIntent, `unknown intent: ${request?.intent}`));
    return false;
  }

  // Streams progress back on its own channel so the app can start speaking before the
  // answer is complete – the entire latency argument for driving a browser at all.
  const emit = (event) => {
    // The worker may have been terminated mid-answer. Losing a partial is survivable;
    // abandoning the rest of the answer over it is not.
    tell({ kind: 'openposse.stream', id: request.id, event });
  };

  Promise.resolve(handler(request, emit))
    .then(respond)
    .catch((error) => respond(failure(ERROR.timeout, String(error?.message ?? error))));
  return true;              // keeps the channel open for the async reply
  });

  // Lets the worker ask *this frame* whether it can see the assistant, before sending it an
  // intent it has no way to carry out. See `frameOwningAssistant` in the service worker –
  // without it, every frame answers and the fastest failure wins.
  //
  // Installed on `globalThis` rather than exposed as an intent because the worker reads it
  // with `executeScript`, which returns one result per frame. An intent would go back through
  // `sendMessage`, which returns only the first – the very thing being fixed.
  //
  // Visible, not merely present: LeanIX keeps its composer mounted while the panel is shut,
  // so presence would nominate a frame that cannot actually be typed into.
  globalThis.__openposseSeesAssistant = (selector) => {
    try {
      return Boolean(deepQuerySelectorVisible(selector));
    } catch {
      return false;
    }
  };
}
