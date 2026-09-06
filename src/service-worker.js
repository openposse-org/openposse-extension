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

import { Bridge, envelope } from './bridge.js';

/** Transport-level status, readable by the popup and by tests. Never message content. */
const status = {
  connected: false,
  lastError: null,
  lastEventAt: null,
};

const bridge = new Bridge({
  onMessage: (message) => {
    status.lastEventAt = Date.now();
    handleFromApp(message);
  },
  onDisconnect: (reason) => {
    status.connected = false;
    status.lastError = reason;
    console.warn('[openposse] native port closed:', reason);
    scheduleReconnect();
  },
});

/**
 * Handles one message from the app.
 *
 * Transport errors are distinguished from page errors here because they mean different
 * things to a user: `APP_NOT_RUNNING` is fixed by launching OpenPosse, while
 * `ELEMENT_NOT_FOUND` means a vendor changed their UI and the recipe needs re-recording.
 */
function handleFromApp(message) {
  if (message?.type === 'error') {
    const code = message.payload?.code;
    if (code === 'APP_NOT_RUNNING' || code === 'APP_DISCONNECTED') {
      status.connected = false;
      status.lastError = code;
      return;
    }
  }

  // The handshake reply — and the only thing that sets `connected`. See `ensureConnected`.
  if (message?.id === 'handshake') {
    status.connected = message.type === 'response' && message.payload?.accepted === true;
    status.lastError = status.connected ? null : (message.payload?.message ?? 'handshake refused');
    console.info('[openposse] handshake:', status.connected ? 'app is running' : status.lastError);
    if (status.connected) chrome.alarms.clear('openposse.reconnect');
    return;
  }

  if (message?.type === 'request') {
    dispatchIntent(message);
    return;
  }

  console.debug('[openposse] message type:', message?.type);
}

/**
 * Retries the connection on a slow alarm.
 *
 * `protocol.md` says "no reconnect loop", and that was written about the *host*, which is
 * right: a browser-spawned relay must not sit retrying a socket, because Chrome respawns it
 * on the next `connectNative` anyway.
 *
 * Applying the same rule to the extension turned out to be wrong. The port dies whenever
 * OpenPosse restarts, and with no retry the browser bridge then stays dead until the user
 * opens `chrome://extensions` and reloads the extension by hand — which is not a thing anyone
 * should have to know. Quitting and reopening an app must not require servicing the browser.
 *
 * An alarm rather than a timer: MV3 workers are terminated when idle, taking any `setTimeout`
 * with them, and `chrome.alarms` is the only scheduling that survives that. One minute is
 * Chrome's practical floor, and it is cheap — the worker is asleep in between, and a
 * successful connection cancels the alarm.
 */
function scheduleReconnect() {
  chrome.alarms.create('openposse.reconnect', { periodInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'openposse.reconnect') return;
  if (bridge.connected) {
    chrome.alarms.clear('openposse.reconnect');
    return;
  }
  ensureConnected();
});

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
  await chrome.tabs.sendMessage(tabId, { intent: 'arm_recording' });
  recording = { id, agent, tabId, keepAlive: startKeepAlive() };
  return { ok: true, tabId };
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

/** Relays one capture from the content script to the app, on the arming correlation id. */
chrome.runtime.onMessage.addListener((message, _sender, _respond) => {
  if (message?.kind !== 'openposse.recording' || !recording) return false;

  try {
    bridge.send(envelope({
      id: recording.id,
      type: 'event',
      agent: recording.agent,
      payload: { kind: 'recording', event: message.event },
    }));
  } catch (error) {
    console.warn('[openposse] could not relay a capture:', error?.message ?? error);
  }

  // The page is gone, so the listeners went with it. Stopping here means the keepalive does
  // not outlive the thing it was keeping alive.
  if (message.event?.kind === 'navigated_away') stopRecording();
  return false;
});

/** Recording intents, handled by the worker rather than by a content script. */
const WORKER_INTENTS = {
  list_tabs: listTabs,
  focus_tab: focusTab,
  arm_recording: armRecording,
  disarm_recording: disarmRecording,
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

  const reply = (type, body) => {
    try {
      bridge.send(envelope({ id, type, agent, payload: body }));
    } catch (error) {
      console.warn('[openposse] could not reply:', error?.message ?? error);
    }
  };

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
    const result = await chrome.tabs.sendMessage(tab.id, {
      intent: payload.intent,
      recipe,
      prompt: payload.prompt,
      id,
    });

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
 * Opens the port and confirms the app is really there.
 *
 * Connecting is not the same as being connected: `connectNative` succeeds as soon as Chrome
 * spawns the host, which happens even when OpenPosse is not running — the host then replies
 * `APP_NOT_RUNNING` and exits. So the port opening tells us nothing, and the handshake reply
 * is what actually answers the question.
 */
export async function ensureConnected() {
  if (bridge.connected) return status;

  try {
    bridge.connect();
    bridge.send(envelope({
      id: 'handshake',
      type: 'request',
      agent: 'openposse.host',
      payload: { intent: 'handshake' },
    }));
    status.lastError = null;
    // `status.connected` is deliberately NOT set here. Sending proves only that Chrome
    // spawned the host — which it does whether or not OpenPosse is running. `handleFromApp`
    // sets it when the app itself answers.
  } catch (error) {
    status.connected = false;
    status.lastError = String(error?.message ?? error);
  }
  return status;
}

// The popup and any future content script ask for status through here rather than reaching
// into the worker's variables, which may not exist after an idle termination.
chrome.runtime.onMessage.addListener((request, _sender, respond) => {
  if (request?.kind === 'openposse.status') {
    ensureConnected().then(respond);
    return true;          // keeps the channel open for the async reply
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  console.info('[openposse] extension installed');
  ensureConnected();
});

// Reconnect when the browser restarts, not only when the extension is first installed.
chrome.runtime.onStartup.addListener(() => {
  ensureConnected();
});

// Connect as soon as the worker runs.
//
// This is not eagerness for its own sake — it falls out of the direction of the
// architecture. OpenPosse cannot reach into the browser: the host is spawned by *Chrome* via
// `connectNative`, and the socket runs host → app. So for the app to drive a page at all, the
// extension must already be holding a port open. A lazily-connected extension would be
// unreachable exactly when the user says "Andy, ..." — the moment it needs to work.
ensureConnected();

// Console handle for development.
//
// `chrome.runtime.sendMessage` from the service worker's own DevTools console does NOT reach
// this worker: Chrome excludes the sender from `onMessage` delivery, so it fails with
// "Receiving end does not exist" even when everything is working. That error names the
// messaging API rather than the bridge, which sends you looking in the wrong place — hence a
// handle that can be called directly.
globalThis.openposse = {
  status: () => status,
  connect: () => ensureConnected(),
  disconnect: () => bridge.disconnect(),
};
