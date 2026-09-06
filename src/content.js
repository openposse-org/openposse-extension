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
import { arm as armRecorder, disarm as disarmRecorder, isArmed } from './recorder.js';

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
    pressShortcut(recipe.shortcut, document.activeElement ?? document.body);
    input = await waitForElement(recipe.inputSelector, { timeoutMs: 3000 });
    // Names the method that actually worked, which is what `Recipe.triggerMethod` records so
    // the runtime never has to guess. A null here is the `isTrusted` rejection: the browser
    // marks JS-dispatched key events untrusted and some vendors ignore them silently, with
    // no error to catch — absence of the panel is the only signal there is.
    openedBy = input ? 'synthetic' : null;
  }

  if (!input) {
    return failure(
      ERROR.timeout,
      'assistant did not open from a synthetic shortcut — needs the app to post a real event',
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
  const container = await waitForNewMatch(
    recipe.responseContainerSelector, repliesBefore, { timeoutMs: responseTimeoutMs }
  );
  if (!container) {
    return failure(
      ERROR.timeout,
      `no new response within ${Math.round(responseTimeoutMs / 1000)}s`,
      { openedBy }
    );
  }

  const text = await streamResponse(container, {
    quietPeriodMs: recipe.quietPeriodMs ?? 900,
    onDelta: (delta) => emit({ kind: 'partial_result', text: delta }),
  });

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
  // Never press blind. A toggle pressed while the panel is open closes it, so a blind press
  // turns a working state into a broken one — and looks like the shortcut failing.
  if (deepQuerySelectorVisible(recipe.inputSelector)) {
    return { ok: true, openedBy: 'already-open' };
  }

  pressShortcut(recipe.shortcut, document.activeElement ?? document.body);

  const input = await waitForElement(recipe.inputSelector, { timeoutMs: 3000 });
  if (!input) {
    // Very likely `isTrusted: false` being rejected. Say so truthfully and stop — the app
    // owns the CGEventPost fallback, and the extension cannot post a trusted event at all.
    return failure(ERROR.timeout, 'assistant did not open from a synthetic shortcut');
  }
  return { ok: true, openedBy: 'synthetic' };
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
}
