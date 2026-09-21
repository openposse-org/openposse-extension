// Content script — the only code that touches a vendor's page.
//
// It is driven entirely by the recipe the service worker hands it. There are no vendor
// selectors in this file, and there must never be: selectors come from recordings, so a
// literal `[data-testid=…]` here would mean the recorder is missing a capture step
// (`extension/CLAUDE.md`).
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

/** Wire error codes this script can originate. Mirrors `docs/protocol.md`. */
const ERROR = {
  elementNotFound: 'ELEMENT_NOT_FOUND',
  timeout: 'TIMEOUT',
  unsupportedIntent: 'UNSUPPORTED_INTENT',
  authRequired: 'AUTH_REQUIRED',
};

function failure(code, message, extra = {}) {
  // `extra` carries diagnostics that survive a failure. Without it, a later step failing
  // hides what earlier steps established — the shortcut measurement vanished the moment the
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
 * @returns the method that worked, for `Recipe.triggerMethod`, or null if nothing happened.
 */
async function openAssistant(recipe) {
  if (recipe.openMethod === 'click') {
    if (!recipe.openSelector) return null;
    // Wait rather than demand it instantly: the control may be behind a menu that is still
    // rendering, and a page that is working perfectly can fail an immediate lookup.
    const control = await waitForElement(recipe.openSelector, { timeoutMs: 3000 });
    if (!control) return null;
    control.click();
    return 'click';
  }

  if (!recipe.shortcut) return null;
  pressShortcut(recipe.shortcut, document.activeElement ?? document.body);
  // Names the route so `Recipe.triggerMethod` never has to guess. A null from the caller is
  // the `isTrusted` rejection: the browser marks JS-dispatched key events untrusted and some
  // vendors ignore them silently, with no error to catch — the panel not appearing is the
  // only signal there is.
  return 'synthetic';
}

/**
 * Puts a question to the assistant and streams the answer back.
 *
 * Each step reports its own specific failure. A single "couldn't ask the assistant" would be
 * useless here: a missing input means the recipe needs re-recording, while a missing response
 * container after a successful submit usually means the vendor renamed one class — different
 * diagnosis, different fix.
 */
async function askAssistant({ recipe, prompt }, emit) {
  // Open the assistant if it is closed, rather than failing.
  //
  // Checking first is what makes the shortcut safe to send at all: these shortcuts are
  // usually *toggles*, so pressing one blind would close a panel that was already open —
  // turning a working request into a failure, and doing it more reliably the better the
  // rest of the code works.
  let openedBy = 'already-open';
  // Visible, not merely present. LeanIX keeps the panel mounted when closed, so a presence
  // check reports "already open" for a shut panel — which is exactly what happened the first
  // time this was measured, and it silently skipped the thing under test.
  let input = deepQuerySelectorVisible(recipe.inputSelector);

  if (!input) {
    openedBy = await openAssistant(recipe);
    input = await waitForElement(recipe.inputSelector, { timeoutMs: 3000 });
    if (!input) openedBy = null;
  }

  if (!input) {
    return failure(
      ERROR.timeout,
      recipe.openMethod === 'click'
        ? 'the assistant did not open when its button was clicked'
        : 'assistant did not open from a synthetic shortcut — needs the app to post a real event',
      { openedBy: null }
    );
  }

  // Count existing replies BEFORE submitting. On a chat page the previous answers are still
  // in the DOM, so "wait for the response container" would match one of those immediately and
  // we would stream last turn's answer back as though it were this one.
  const repliesBefore = deepQuerySelectorAll(recipe.responseContainerSelector).length;

  // Named so it can be re-applied: when the assistant has *just* opened, the framework may
  // not have bound to the input yet, and a value set before that is silently discarded.
  const applyPrompt = () => {
    if (input.isContentEditable) {
      setEditableText(input, prompt);
    } else {
      setInputValue(input, prompt);
    }
  };
  applyPrompt();

  // Prefer the button. A click is far less likely to be gated on `isTrusted` than a
  // synthetic Enter, which is why the recorder records the button when one exists.
  if (recipe.submitMethod === 'click') {
    // Wait rather than demand it instantly. A panel that just opened is often still
    // rendering, and some vendors only mount or enable the send control once the input has
    // content — so an immediate lookup fails on a page that is working perfectly.
    const button = recipe.submitSelector
      ? await waitForElement(recipe.submitSelector, { timeoutMs: 3000 })
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
        'send button stayed disabled — the input never registered',
        { openedBy }
      );
    }
    button.click();
  } else {
    pressShortcut({ key: 'Enter' }, input);
  }

  // From the recipe, not a constant. The vendor decides how long it thinks for, and a
  // hardcoded ceiling reports a healthy-but-slow answer as a broken agent.
  const responseTimeoutMs = recipe.responseTimeoutMs ?? 60000;

  /**
   * Which of the rows that appeared is the answer.
   *
   * **Some vendors do not let a selector name answers at all.** Measured on Notion: after one
   * exchange the transcript holds three rows — the question, the answer, and a seven-character
   * trailer — and all three carry an identical set of attributes. The recorder tried every
   * strategy it has and `div[data-agent-service-find-row]` was genuinely the tightest thing
   * that described both recorded answers. There is nothing tighter to find.
   *
   * So the recipe names rows and this decides which row, using the one thing the page cannot
   * confuse us about: **we know what we typed.** The row echoing our own prompt is the
   * question, by construction rather than by guess.
   *
   * It does not read anything the user wrote — only our own prompt, and only to exclude it.
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
    // 45-character status row — which is true, and was the wrong conclusion. The status row
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

  let container = await waitForNewMatch(
    recipe.responseContainerSelector, repliesBefore,
    // `quietPeriodMs` is the vendor's own measured "things have stopped changing", recorded
    // per recipe rather than guessed — the right order of magnitude for how long to wait in
    // case a status row is about to be followed by the real answer.
    {
      timeoutMs: responseTimeoutMs,
      settleMs: recipe.quietPeriodMs ?? 900,
      choose: withoutOurQuestion,
    }
  );
  if (!container) {
    // Distinguish "sent, and the vendor never answered" from "never actually sent".
    //
    // A synthetic Enter is `isTrusted: false` and some vendors ignore it exactly the way they
    // ignore a synthetic shortcut — the text lands in the composer and simply sits there. Both
    // failures time out identically, and they need opposite fixes: one is a slow or broken
    // assistant, the other means this recipe should have recorded the send *button*.
    //
    // Our own prompt, not page content: checking for it reads nothing the user wrote.
    const remaining = (input.value ?? input.textContent ?? '');
    const submitRejected = prompt.length > 0 && remaining.includes(prompt.slice(0, 24));

    return failure(
      ERROR.timeout,
      submitRejected
        ? 'the message was typed but sending it did nothing — the vendor ignored a synthetic Enter'
        : `no new response within ${Math.round(responseTimeoutMs / 1000)}s`,
      { openedBy, submitRejected }
    );
  }

  // Read, then look again — because a status row is only knowable as one in hindsight.
  //
  // Notion shows "Working on your request" before it shows the answer, and from the DOM that
  // row is indistinguishable from a reply: same attributes, same shape, and at 45 characters
  // it clears any sensible minimum length. Waiting longer does not separate them either, since
  // the gap between the two is the model thinking — seconds, not the few hundred milliseconds
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
  let text = '';
  let readFrom = null;
  for (let pass = 0; pass < 3; pass += 1) {
    const current = pass === 0
      ? container
      : withoutOurQuestion(deepQuerySelectorAll(recipe.responseContainerSelector));

    // The same row twice means the page has settled on it. That is the answer.
    if (!current || current === readFrom) break;

    readFrom = current;
    container = current;
    text = await streamResponse(current, {
      quietPeriodMs: recipe.quietPeriodMs ?? 900,
      // Partials keep flowing so speech can start early, which is the whole latency argument
      // for driving a page. The cost is that a status row can be spoken before it is known to
      // be one; the app replaces the answer on `.done`, so what is left on screen is right.
      onDelta: (delta) => emit({ kind: 'partial_result', text: delta }),
    });
  }

  // Transport diagnostics, not content: how many reply elements existed before and after.
  // Without these, "Andy answered" and "Andy re-read the previous answer" are the same
  // observation — the text alone cannot distinguish them, especially when the question is
  // the same each time.
  return {
    ok: true,
    text,
    repliesBefore,
    repliesAfter: deepQuerySelectorAll(recipe.responseContainerSelector).length,
    openedBy,
  };
}

/** Reads the last answer without asking anything — "say that again". */
function getLastResponse({ recipe }) {
  const all = deepQuerySelectorAll(recipe.responseContainerSelector);
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
 * key, or decide the retry worked — the app owns the `CGEventPost` fallback, because the host
 * inherits no TCC permissions from Chrome and the extension cannot post a trusted event at
 * all.
 */
async function invokeViaShortcut({ recipe }) {
  // Never act blind. These controls are usually *toggles*, so opening one that is already open
  // closes it — turning a working state into a broken one, and looking like the trigger failed.
  if (deepQuerySelectorVisible(recipe.inputSelector)) {
    return { ok: true, openedBy: 'already-open' };
  }

  const openedBy = await openAssistant(recipe);

  const input = await waitForElement(recipe.inputSelector, { timeoutMs: 3000 });
  if (!input) {
    // For a shortcut this is very likely `isTrusted: false` being rejected. Say so truthfully
    // and stop — the app owns the CGEventPost fallback, and the extension cannot post a
    // trusted event at all.
    return failure(ERROR.timeout, recipe.openMethod === 'click'
      ? 'the assistant did not open when its button was clicked'
      : 'assistant did not open from a synthetic shortcut');
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
      chrome.runtime.sendMessage({ kind: 'openposse.recording', event }).catch(() => {
        // The worker may have been terminated. Losing one capture is survivable and the
        // wizard's checklist already shows what is still outstanding; throwing here would
        // tear down the recording over it.
      });
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

const INTENTS = {
  ask_assistant: askAssistant,
  get_last_response: getLastResponse,
  invoke_via_shortcut: invokeViaShortcut,
  arm_recording: armRecording,
  disarm_recording: disarmRecording,
  ping,
};

// Runs once per page, however many times the file is injected.
//
// A dynamically-registered content script only injects on *page load*, so a tab that was
// already open when the user granted access has none — and asking someone to reload the page
// they just chose is both bad and lossy. The worker therefore injects into the open tab with
// `executeScript`, which means this file can arrive twice: once from the injection, once from
// the registration on the next load. Without this guard the second copy adds a second
// `onMessage` listener and every intent is answered twice.
if (globalThis.__openposseContentScript) {
  console.debug('[openposse] content script already present');
} else {
  globalThis.__openposseContentScript = true;
  install();
}

function install() {
  chrome.runtime.onMessage.addListener((request, _sender, respond) => {
  const handler = INTENTS[request?.intent];
  if (!handler) {
    respond(failure(ERROR.unsupportedIntent, `unknown intent: ${request?.intent}`));
    return false;
  }

  // Streams progress back on its own channel so the app can start speaking before the
  // answer is complete — the entire latency argument for driving a browser at all.
  const emit = (event) => {
    chrome.runtime.sendMessage({
      kind: 'openposse.stream',
      id: request.id,
      event,
    }).catch(() => {
      // The worker may have been terminated mid-answer. Losing a partial is survivable;
      // throwing here would abandon the rest of the answer, which is not.
    });
  };

  Promise.resolve(handler(request, emit))
    .then(respond)
    .catch((error) => respond(failure(ERROR.timeout, String(error?.message ?? error))));
  return true;              // keeps the channel open for the async reply
  });

  // Lets the worker ask *this frame* whether it can see the assistant, before sending it an
  // intent it has no way to carry out. See `frameOwningAssistant` in the service worker —
  // without it, every frame answers and the fastest failure wins.
  //
  // Installed on `globalThis` rather than exposed as an intent because the worker reads it
  // with `executeScript`, which returns one result per frame. An intent would go back through
  // `sendMessage`, which returns only the first — the very thing being fixed.
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
