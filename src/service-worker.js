// MV3 service worker — the extension's only long-lived code.
//
// It is deliberately close to empty at M2. The job of this milestone is to prove the
// transport: extension → native host → Unix socket → OpenPosse, and back. Vendor modules and
// intent dispatch arrive at M3, once there is a recorded recipe to dispatch.
//
// Note the lifecycle constraint that shapes everything here: an MV3 service worker is
// **not** persistent. Chrome terminates it after roughly 30 seconds of inactivity, and a
// native messaging port held by a dead worker dies with it. An active port does reset that
// timer, so a port kept open for an in-flight request survives — but the worker must be able
// to reconstruct its state from nothing after any idle gap, and must never assume a variable
// set on one event still exists on the next.

import { loadRoster, recipeFor, findAgent } from './storage.js';
import {
  handleOffscreenMessage, toggleListening, startListening, stopListening,
  isListening, currentTurn, setBias,
} from './listening.js';

/**
 * Replies in flight, by correlation id.
 *
 * **V1 has no transport.** Intents used to arrive from a native host over a Unix socket and
 * their answers went back the same way; now they originate inside the extension — from the
 * popup, and from the voice loop — so a reply is a promise resolving in this same process.
 *
 * The correlation-id discipline is kept anyway, because `dispatchIntent` streams partial
 * results alongside its final answer and those still have to be told apart.
 */
const pending = new Map();

function replyTo(id) {
  return (type, body) => {
    const sink = pending.get(id);
    if (!sink) return;
    if (type === 'event') {
      sink.onEvent?.(body);
      return;
    }
    pending.delete(id);
    sink.resolve({ type, payload: body });
  };
}

/**
 * Puts a question to an agent and returns its answer.
 *
 * The entry point everything user-facing goes through — the popup's text box today, the voice
 * loop at E3. It loads the recipe the recorder produced, finds the tab that recipe is for, and
 * hands the work to `dispatchIntent`.
 *
 * `onPartial` receives text as it streams. Speech can start on the first chunk rather than the
 * finished answer, which is the whole latency argument for driving a page instead of calling
 * an API — see `docs/protocol.md`.
 */
export async function ask(agentName, prompt, { onPartial } = {}) {
  const { agents } = await loadRoster();
  const agent = findAgent(agents, agentName);
  if (!agent) return { type: 'error', payload: { code: ERROR.unsupportedIntent, message: `no agent called ${agentName}` } };

  const recipe = await recipeFor(agent);
  if (!recipe) {
    // The `broken` state made concrete. The agent exists and routes; its recipe does not.
    return {
      type: 'error',
      payload: { code: ERROR.elementNotFound, message: `${agent.name} needs re-recording` },
    };
  }

  const id = crypto.randomUUID();
  const answer = new Promise((resolve) => {
    pending.set(id, { resolve, onEvent: (event) => onPartial?.(event?.text ?? '') });
  });

  dispatchIntent({ id, agent: agent.name, payload: { intent: 'ask_assistant', recipe, prompt } });
  return answer;
}

/**
 * Which frame can actually see the assistant, or undefined if none can.
 *
 * **This exists because broadcasting was silently answering with the wrong frame.**
 * `chrome.tabs.sendMessage` without a `frameId` goes to every frame, the content script is
 * registered `all_frames: true`, and the promise resolves with whichever responds *first*.
 * On Notion — two iframes — that played out the same way twice: the frame holding the
 * composer typed the prompt, sent it, and got an answer, while a frame with no composer
 * pressed the shortcut into nothing, timed out after three seconds, and reported "the
 * assistant did not open".
 *
 * The three-second failure beats any real exchange, which needs typing, sending, model
 * latency and a quiet period. So the wrong answer did not merely sometimes win — it won by
 * construction, every time, and the page visibly disagreed with the report.
 *
 * `executeScript` rather than another `sendMessage`, because it returns a result for *every*
 * frame with its `frameId` instead of just the first to answer — which is the whole problem.
 * It runs in the same isolated world as our content script, so it can call the query the
 * content script already installed rather than duplicating a shadow-piercing visibility check
 * that would then drift from it. A frame with no content script has no such global and
 * answers false, which is the right answer from a frame that could not have handled the
 * intent anyway.
 */
async function frameOwningAssistant(tabId, selector) {
  if (!selector) return undefined;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      args: [selector],
      func: (sel) => Boolean(globalThis.__openposseSeesAssistant?.(sel)),
    });
    return results.find((entry) => entry.result === true)?.frameId;
  } catch {
    // A frame we are not allowed to inject into, or a tab that has gone. Falling back to the
    // top frame is what the code did before this existed, so this is never worse.
    return undefined;
  }
}

/** Wire error codes the worker itself can originate. */
const ERROR = {
  tabNotFound: 'TAB_NOT_FOUND',
  unsupportedIntent: 'UNSUPPORTED_INTENT',
  timeout: 'TIMEOUT',
};

// ── Recording (M3) ──────────────────────────────────────────────────────────────────────
//
// Recording intents are handled *here* rather than in the content script, because they are
// browser-level: enumerating tabs and focusing a window are things only the worker can do, and
// the chosen tab may not have run a content script yet.

/** The recording in progress, or null. `{ id, agent, tabId, keepAlive }` — one at a time. */
let recording = null;

/** Enumerates every open tab so the wizard can offer them. */
async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    ok: true,
    tabs: tabs
      // Only pages we could ever drive. A `chrome://` page or a local file cannot host an
      // assistant and cannot receive a content script, so offering them is offering a dead end.
      .filter((tab) => tab.url?.startsWith('https://') && tab.id != null)
      .map((tab) => ({
        id: tab.id,
        windowID: tab.windowId,
        title: tab.title ?? '',
        // Origin and path only. A query string routinely carries session identifiers and
        // search terms, and nobody needs either to recognise their own tab.
        url: stripQuery(tab.url),
        favIconURL: tab.favIconUrl ?? null,
        isActive: !!tab.active,
      })),
  };
}

function stripQuery(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/** Brings the chosen tab forward so the user can act in it. */
async function focusTab({ tabId }) {
  const tab = await chrome.tabs.get(tabId);
  // Activate the tab first, then raise its window. The other order shows the window's
  // previously-active tab for a frame before switching, which reads as landing on the wrong
  // page at exactly the moment the user is being asked to trust that we picked the right one.
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return { ok: true, windowID: tab.windowId };
}

/**
 * Arms the recorder in one specific tab and relays its captures to the app.
 *
 * The relay is a module-level listener rather than one scoped to a `sendMessage` round trip:
 * arming returns immediately and the captures arrive over the following minutes, so a listener
 * torn down when the arming call resolves would miss every one of them.
 */
async function armRecording({ tabId }, { id, agent }) {
  await ensureContentScript(tabId);
  await chrome.tabs.sendMessage(tabId, { intent: 'arm_recording' });
  recording = { id, agent, tabId, keepAlive: startKeepAlive() };
  return { ok: true, tabId };
}

/**
 * Guarantees a content script is running in `tabId`, injecting it if not.
 *
 * **`registerContentScripts` only injects on page load.** The tab the user picked was open
 * before they granted access to its site, so it has no content script and every intent fails
 * with "Receiving end does not exist". Telling them to reload the page they just chose is both
 * a bad step and a lossy one — a reload can lose exactly the state that made them pick it.
 *
 * So: ping, and inject only if nobody answers. The registration still handles every *future*
 * load; this handles the one tab already in front of the user.
 *
 * Injecting unconditionally would be simpler and wrong — a tab covered by the static manifest
 * already has the script, and a second copy would add a second `onMessage` listener and answer
 * every intent twice. `content.js` guards against that too, but not needing the guard is
 * better than relying on it.
 */
async function ensureContentScript(tabId) {
  try {
    const alive = await chrome.tabs.sendMessage(tabId, { intent: 'ping' });
    if (alive?.ok) return { injected: false };
  } catch {
    // No listener. That is the case this function exists for.
  }

  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['dist/content.js'],
  });
  return { injected: true };
}

async function disarmRecording({ tabId }) {
  stopRecording();
  // Best-effort: the tab may already be gone, which is not a failure of disarming.
  try {
    await chrome.tabs.sendMessage(tabId, { intent: 'disarm_recording' });
  } catch { /* tab closed or navigated — nothing left to disarm */ }
  return { ok: true };
}

function stopRecording() {
  if (!recording) return;
  clearInterval(recording.keepAlive);
  recording = null;
}

/**
 * Keeps the service worker alive for the length of a recording.
 *
 * MV3 terminates an idle worker after ~30 seconds, and a recording is a human being finding a
 * menu item, typing a question and waiting for an answer — minutes, with no traffic of our own.
 * A terminated worker takes the native port with it, so the captures would simply stop arriving
 * partway through with nothing to explain why.
 *
 * Any extension API call resets the idle timer, which is what this buys. `chrome.alarms` is the
 * wrong tool here: its practical floor is one minute, which is *longer* than the timeout it
 * would be defending against.
 */
function startKeepAlive() {
  return setInterval(() => { chrome.runtime.getPlatformInfo(); }, 20_000);
}

/** Relays one capture from the content script to whoever armed the recorder. */
chrome.runtime.onMessage.addListener((message, _sender, _respond) => {
  if (message?.kind !== 'openposse.recording' || !recording) return false;

  // Broadcast rather than resolved: captures arrive for minutes after arming, so they are
  // events on an open channel, not the answer to a request. The recorder UI listens.
  chrome.runtime.sendMessage({
    kind: 'openposse.capture',
    id: recording.id,
    event: message.event,
  }).catch(() => {
    // Nothing listening — the wizard was closed mid-recording. Disarming is handled on that
    // path; losing a capture nobody is watching for is not a failure.
  });

  // The page is gone, so the listeners went with it. Stopping here means the keepalive does
  // not outlive the thing it was keeping alive.
  if (message.event?.kind === 'navigated_away') stopRecording();
  return false;
});

// ── Site access (M3d) ───────────────────────────────────────────────────────────────────
//
// A content script's `matches` are static in the manifest, so adding a vendor by editing that
// file is exactly the engineering task M3 exists to abolish. Runtime registration
// (`chrome.scripting.registerContentScripts`) plus an optional host permission replaces it.
//
// **The permission needs a Chrome user gesture, and a native macOS window cannot make one.**
// So the grant is bound to the extension's toolbar button: the user clicks it, and the click's
// gesture is what lets `permissions.request` run. This is the one beat of setup that cannot
// happen in OpenPosse's own window.
//
// **The app decides which origin to ask for, not us.** It sends `prepare_access` with a
// pattern before the user clicks, and we request exactly that. Deriving it here would mean a
// second implementation of `DomainPattern` — and a public-suffix mistake in either copy is a
// grant over every site under `co.uk`. It also keeps this file to its rule: the extension
// "never decides anything a user would care about".

/** What the app has asked us to request on the next toolbar click. */
let pendingAccess = null;

/** Origins covered by the static manifest, which must never also be registered dynamically. */
function staticOrigins() {
  return new Set(chrome.runtime.getManifest().host_permissions ?? []);
}

/** Records what the app wants granted, so the toolbar click knows what to ask for. */
function prepareAccess({ tabId, pattern }) {
  pendingAccess = { tabId, pattern };
  return { ok: true, pattern };
}

/** Whether a pattern is already granted, so the wizard can skip a step nobody needs. */
async function checkAccess({ pattern }) {
  const granted = await chrome.permissions.contains({ origins: [pattern] });
  return { ok: true, pattern, granted };
}

/**
 * The toolbar click: the gesture that makes a permission request possible.
 *
 * `chrome.action.onClicked` only fires when the action has no `default_popup`, which is why
 * the manifest declares a title and nothing else.
 */
chrome.action.onClicked.addListener(async (tab) => {
  // Falls back to this tab's exact origin when the app has not asked for anything — clicking
  // the button outside setup should still do the obvious thing. Deliberately narrower than
  // what the wizard requests: an exact host can never be over-broad, and guessing a wildcard
  // here would be the second `DomainPattern` implementation this design exists to avoid.
  let pattern = pendingAccess?.pattern;
  if (!pattern || (pendingAccess.tabId != null && pendingAccess.tabId !== tab.id)) {
    try {
      pattern = `https://${new URL(tab.url).host}/*`;
    } catch {
      return;                        // not an addressable page
    }
  }

  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: [pattern] });
  } catch (error) {
    // The reported-but-unverified claim this milestone rests on: that a gesture propagates
    // into the service worker. If it does not, this throws "must be called during a user
    // gesture" and the grant has to move to a popup page instead. Say which, loudly — the
    // difference decides the shape of the wizard's second step.
    console.error('[openposse] permissions.request failed in the worker:', error?.message ?? error);
    notifyAccess(pattern, false, String(error?.message ?? error));
    return;
  }

  pendingAccess = null;
  if (granted) await reconcileRegistrations();
  notifyAccess(pattern, granted, null);
});

/** Announces that a grant landed, so the recorder advances without polling for it. */
function notifyAccess(pattern, granted, error) {
  chrome.runtime.sendMessage({
    kind: 'openposse.access', pattern, granted, error,
  }).catch(() => {
    // Nobody listening. The grant still happened and `check_access` will find it.
  });
}

/**
 * Registers a content script for every granted origin that the manifest does not already cover.
 *
 * **Dynamic registrations are cleared on extension update, and the `chrome://extensions` reload
 * button counts as an update for an unpacked extension.** Permissions survive; registrations do
 * not. During development that reads as "the agent worked yesterday and does nothing today",
 * with nothing in the logs — so this runs on install, on startup, and whenever a permission is
 * added, and derives its list from `permissions.getAll()` rather than from stored state.
 * The granted origins are the durable half, which makes them the right source of truth.
 *
 * **Serialised, because the body is check-then-act.** It reads the registered scripts, decides
 * what is missing, and registers it — and two overlapping runs both read "nothing registered"
 * and both register the same id, so the second fails with `Duplicate script ID`. Three events
 * can start it (install, startup, a permission being granted) and a reload fires more than one
 * of them, which is exactly when it was seen. Queuing rather than sharing one in-flight promise:
 * a caller reacting to a *new* permission needs a fresh read, not the answer from a run that
 * started before the grant existed.
 */
let reconcileQueue = Promise.resolve();

function reconcileRegistrations() {
  reconcileQueue = reconcileQueue.then(runReconcile, runReconcile);
  return reconcileQueue;
}

async function runReconcile() {
  const [{ origins = [] }, existing] = await Promise.all([
    chrome.permissions.getAll(),
    chrome.scripting.getRegisteredContentScripts(),
  ]);

  const covered = staticOrigins();
  const already = new Set(existing.map((script) => script.id));

  const wanted = origins.filter((origin) => !covered.has(origin));
  const toAdd = wanted
    .filter((origin) => !already.has(registrationID(origin)))
    .map((origin) => ({
      id: registrationID(origin),
      matches: [origin],
      js: ['dist/content.js'],
      runAt: 'document_idle',
      allFrames: true,
      persistAcrossSessions: true,
    }));

  // One call per origin, not one call for the batch.
  //
  // `registerContentScripts` is atomic: a single bad entry — an origin whose grant has just
  // been revoked, or an id Chrome has already restored while an update was still settling —
  // rejects the whole array, and every *other* vendor silently loses its registration too.
  // Seen once during an extension reload, and it self-corrected on the next reconcile, which
  // is exactly what makes the batched version dangerous: the failure is transient, plausible,
  // and takes out bystanders.
  //
  // Registering separately costs one extra round trip per vendor and confines the damage to
  // the origin that actually had a problem.
  for (const script of toAdd) {
    try {
      await chrome.scripting.registerContentScripts([script]);
    } catch (error) {
      const message = String(error?.message ?? error);

      // A duplicate is not a failure — it is the state we were trying to reach, reported by
      // Chrome because `getRegisteredContentScripts` had not caught up. The serialisation
      // above removes the case we can cause ourselves; this covers the one we cannot, where
      // Chrome restores a persisted registration while an update is still settling.
      //
      // Updated rather than left alone, so a registration persisted from an older build is
      // brought to the shape this build intends — `allFrames` and `matches` have both changed
      // during M3, and a stale registration injecting into the wrong frames would be the same
      // class of invisible bug the frame fix was for.
      if (message.includes('Duplicate script ID')) {
        try {
          await chrome.scripting.updateContentScripts([script]);
        } catch (updateError) {
          console.warn(
            `[openposse] could not refresh the registration for ${script.matches[0]}:`,
            updateError?.message ?? updateError
          );
        }
        continue;
      }

      // Registration succeeds without host permission and then silently never injects, so a
      // failure here is the *loud* case and worth keeping.
      console.error(
        `[openposse] could not register content script for ${script.matches[0]}:`,
        message
      );
    }
  }

  // Drop registrations whose permission the user revoked, or the script outlives the grant and
  // fails silently from then on.
  const stale = existing
    .filter((script) => script.id.startsWith('openposse:') && !wanted.includes(originOf(script.id)))
    .map((script) => script.id);
  if (stale.length > 0) {
    try { await chrome.scripting.unregisterContentScripts({ ids: stale }); } catch { /* gone */ }
  }

  return { registered: wanted.length };
}

const registrationID = (origin) => `openposse:${origin}`;
const originOf = (id) => id.slice('openposse:'.length);

chrome.permissions.onAdded.addListener(() => { reconcileRegistrations(); });
chrome.permissions.onRemoved.addListener(() => { reconcileRegistrations(); });

/** Recording intents, handled by the worker rather than by a content script. */
const WORKER_INTENTS = {
  list_tabs: listTabs,
  focus_tab: focusTab,
  arm_recording: armRecording,
  disarm_recording: disarmRecording,
  prepare_access: prepareAccess,
  check_access: checkAccess,
};

/**
 * Turns a recipe's domain pattern into a Chrome match pattern.
 *
 * Note this is *not* the security boundary — the content script's `matches` in the manifest
 * is, and it is static. This only decides which already-permitted tab to talk to, so a recipe
 * naming a domain we were not built for finds no tab rather than injecting anywhere.
 */
function matchPattern(domainPattern) {
  return `https://${domainPattern.replace(/^\*\./, '*.')}/*`;
}

/**
 * Runs one intent against the right tab and reports the outcome to the app.
 *
 * Every failure is a specific wire error rather than a generic one, because they need
 * different responses from a user: `TAB_NOT_FOUND` means "open LeanIX", while
 * `ELEMENT_NOT_FOUND` from the content script means the vendor changed their UI and the
 * recipe needs re-recording.
 */
async function dispatchIntent(request) {
  const { id, agent, payload } = request;
  const recipe = payload?.recipe;

  const reply = replyTo(id);

  // Recording intents are browser-level and carry no recipe — there is not one yet. Checked
  // before the recipe guard below, which would otherwise reject every one of them as
  // "intent carried no recipe".
  const workerHandler = WORKER_INTENTS[payload?.intent];
  if (workerHandler) {
    try {
      reply('response', await workerHandler(payload ?? {}, { id, agent }));
    } catch (error) {
      // `tabs.get` and `tabs.sendMessage` both reject when the tab has gone — the user closed
      // it between picking it and us reaching for it. That is `TAB_NOT_FOUND` and not a
      // generic failure, because the fix is to pick a different tab.
      reply('error', {
        code: ERROR.tabNotFound,
        message: String(error?.message ?? error),
      });
    }
    return;
  }

  if (!recipe?.domainPattern) {
    reply('error', { code: ERROR.unsupportedIntent, message: 'intent carried no recipe' });
    return;
  }

  const tabs = await chrome.tabs.query({ url: matchPattern(recipe.domainPattern) });
  const tab = tabs.find((t) => t.active) ?? tabs[0];
  if (!tab) {
    reply('error', {
      code: ERROR.tabNotFound,
      message: `no open tab matching ${recipe.domainPattern}`,
    });
    return;
  }

  // Relays this exchange's partial results. Registered before the intent is sent so an
  // assistant that answers instantly cannot beat the listener into place.
  const onStream = (note) => {
    if (note?.kind !== 'openposse.stream' || note.id !== id) return;
    reply('event', note.event);
  };
  chrome.runtime.onMessage.addListener(onStream);

  try {
    // Same guarantee the recorder needs, and it retires a standing annoyance: after an
    // extension reload, every already-open tab is running the old content script or none at
    // all, and the documented workaround was "reload the page too". Ensuring it here means a
    // reload is no longer part of anyone's routine.
    await ensureContentScript(tab.id);

    const message = { intent: payload.intent, recipe, prompt: payload.prompt, id };

    let frameId = await frameOwningAssistant(tab.id, recipe.inputSelector);
    let result = await chrome.tabs.sendMessage(tab.id, message, { frameId: frameId ?? 0 });

    // The assistant was shut, so nobody owned it and the top frame took the shortcut — but
    // the panel may have opened in an iframe, where the top frame cannot see it. Re-locate
    // once and let whoever has it now finish the job.
    if (!result?.ok && frameId === undefined) {
      frameId = await frameOwningAssistant(tab.id, recipe.inputSelector);
      if (frameId !== undefined && frameId !== 0) {
        result = await chrome.tabs.sendMessage(tab.id, message, { frameId });
      }
    }

    if (result?.ok) {
      reply('response', {
        text: result.text ?? '',
        repliesBefore: result.repliesBefore,
        repliesAfter: result.repliesAfter,
        openedBy: result.openedBy,
      });
    } else {
      reply('error', {
        code: result?.code ?? ERROR.timeout,
        message: result?.message ?? 'failed',
        openedBy: result?.openedBy,
      });
    }
  } catch (error) {
    // `sendMessage` rejects when no content script is listening — almost always a tab that
    // was open before the extension was installed or reloaded. Say that, rather than letting
    // it read as a page problem.
    reply('error', {
      code: ERROR.tabNotFound,
      message: 'the tab has no OpenPosse content script — reload the page',
    });
  } finally {
    chrome.runtime.onMessage.removeListener(onStream);
  }
}

/**
 * What the popup and the voice loop ask this worker to do.
 *
 * Everything arrives as a runtime message rather than over a socket now. The worker still has
 * to be able to reconstruct its state from nothing on every wake — MV3 terminates it after
 * about thirty seconds idle — which is why the roster is read from storage per request rather
 * than held in a variable.
 */
chrome.runtime.onMessage.addListener((request, _sender, respond) => {
  // Offscreen traffic first: it is the highest-volume kind by far — an interim result every
  // few hundred milliseconds — and none of it wants a reply. Returning false hands the message
  // on without holding a port open for an answer nobody is going to send.
  if (handleOffscreenMessage(request)) return false;

  if (request?.kind === 'openposse.listen.toggle') {
    toggleListening().then((problem) => respond({ ok: !problem, failure: problem ?? null }));
    return true;
  }
  if (request?.kind === 'openposse.listen.query') {
    // What a popup needs the moment it opens: are we listening, what has been heard so far, and
    // what went wrong last time. It may have opened halfway through a turn the shortcut began.
    isListening().then((listening) => respond({ listening, ...currentTurn() }));
    return true;
  }

  if (request?.kind === 'openposse.ask') {
    ask(request.agentName, request.prompt).then(respond);
    return true;          // keeps the channel open for the async reply
  }
  if (request?.kind === 'openposse.record') {
    // E8 wires the recorder's own UI to this. Acknowledged rather than silently dropped, so
    // the popup's button is honest about doing nothing yet.
    console.info('[openposse] record requested for tab', request.tabId, '— not wired until E8');
    respond({ ok: false, reason: 'not-wired' });
    return true;
  }
  return false;
});

/**
 * The summon shortcut — **⌥V where the user has set it, ⌘⇧9 out of the box.**
 *
 * A toggle, because it is the only control available when nothing of ours is on screen: the
 * same press has to be both "listen" and "never mind". That was M1's finding and it transfers
 * unchanged, along with its consequence — cancelling discards the half-sentence rather than
 * sending it (see `offscreen.js`).
 *
 * **The restriction binds what we may suggest, not what the user may assign**, and the
 * difference is the whole story. Chrome permits `global: true` in a *manifest* only on
 * `Ctrl+Shift+[0-9]`, converting `Ctrl` to Command on macOS — so the entire suggestible space
 * is ⌘⇧0 through ⌘⇧9, of which macOS Screenshot already owns **3, 4, 5 and 6**. (The plan
 * specified 5, the screenshot toolbar, so the shortcut opened screen recording and never
 * reached Chrome at all.) 9 is clear and deliberately at the far end: a slip from 2 to 3, or 7
 * to 6, takes a screenshot; a slip from 9 hits 0 and does nothing.
 *
 * At `chrome://extensions/shortcuts` **none of that applies** — confirmed by doing it, not by
 * reading. ⌥V can be assigned there and marked Global, which is what M1 always wanted and what
 * `HotKeyCenter` still registers on the Mac side. So the two halves of this project use the
 * same gesture after all; we simply cannot ship it as the default.
 *
 * Nothing else in this codebase names a key. Every surface that shows one reads
 * `chrome.commands.getAll()`, so whatever the user actually bound is what they are told.
 */
chrome.commands.onCommand.addListener((command) => {
  if (command === 'summon') toggleListening();
});

chrome.runtime.onInstalled.addListener(() => {
  console.info('[openposse] extension installed');
  // A reload destroys the offscreen document and clears session storage, but the badge is the
  // browser's and survives — so without this the toolbar claims a microphone is open that
  // nothing is holding.
  chrome.action.setBadgeText({ text: '' }).catch(() => {});
  // An update — which the chrome://extensions reload button performs — clears every dynamic
  // registration while leaving the permissions in place. Without this, every vendor added
  // through the recorder stops working after a reload, silently.
  reconcileRegistrations();
});

chrome.runtime.onStartup.addListener(() => {
  reconcileRegistrations();
});

// Console handle for development.
//
// `chrome.runtime.sendMessage` from the service worker's own DevTools console does NOT reach
// this worker: Chrome excludes the sender from `onMessage` delivery, so it fails with
// "Receiving end does not exist" even when everything is working. That error names the
// messaging API rather than the thing that is actually wrong, which sends you looking in the
// wrong place — hence a handle that can be called directly.
globalThis.openposse = {
  roster: () => loadRoster(),
  // Listening, without the hotkey — useful when the shortcut is taken by something else, and
  // the only way to drive a turn while the popup is open to watch it. Note that none of these
  // return what was heard: the transcript goes to the popup and nowhere else, and a console
  // handle that printed it would be a logging path this project does not have.
  listen: () => startListening(),
  hush: () => stopListening(),
  listening: () => isListening(),
  /**
   * `openposse.bias(3)` to sweep the weight, `openposse.bias(false)` to hear the recogniser
   * unbiased. The scale is logarithmic — see `NAME_BOOST` — so the steps that matter are small.
   */
  bias: (on = true) => setBias(on),
  ask: (name, prompt) => ask(name, prompt, { onPartial: (t) => console.debug('…', t.length) }),
  // What is granted, and what is actually registered. The two disagreeing is the silent
  // failure the recorder is built around — a grant with no registration and a registration
  // with no grant both look like nothing happening.
  access: async () => ({
    granted: (await chrome.permissions.getAll()).origins,
    registered: (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.id),
    static: [...staticOrigins()],
    pending: pendingAccess,
  }),
  reconcile: () => reconcileRegistrations(),
};
