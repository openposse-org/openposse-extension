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

import {
  loadRoster, recipeFor, findAgent, addAgent, replaceRecipe, freeName, renameAgent, removeAgent,
  setAgentVoice,
} from './storage.js';
import {
  handleOffscreenMessage, toggleListening, startListening, stopListening,
  isListening, currentTurn, setBias, setTurnHandler, markThinking, markDone, say,
} from './listening.js';
import { needsShortening, spokenForm } from './saying.js';
import { summarise } from './summariser.js';
import { route, navigationTarget, productName, FLOOR_MS } from './routing.js';
import { matchPattern } from './domain.js';
import { newDraft, applyCapture, isComplete, finish } from './draft.js';
import {
  derive, stepLabel, instruction, captures, PATIENCE_MS,
} from './coaching.js';
import { panel, hidePanel, primePanel } from './panel.js';
import { trace } from './trace.js';
import { channelFor } from './channels.js';

/**
 * The last thing asked, so clicking a different avatar can put it to them instead.
 *
 * **Session storage, not a module variable.** MV3 terminates an idle worker after ~30 seconds,
 * and the panel can easily still be on screen after that — so a variable here would be empty
 * exactly when someone reaches for the avatar, and the click would do nothing with no way to
 * tell that from a dead button. It expires with the floor, because re-asking a question the
 * conversation has moved on from is not a repair.
 */
async function rememberPrompt(prompt) {
  await chrome.storage.session.set({ lastPrompt: prompt, lastPromptAt: Date.now() });
}

async function recallPrompt() {
  const { lastPrompt, lastPromptAt = 0 } = await chrome.storage.session.get(['lastPrompt', 'lastPromptAt']);
  return lastPrompt && Date.now() - lastPromptAt <= FLOOR_MS ? lastPrompt : '';
}

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

// ── The voice loop's other half (E3) ────────────────────────────────────────────────────
//
// E2 ends with a transcript sitting in a readout. This is what turns it into a question
// somebody actually gets asked — and it is short, because both ends already existed: `route`
// picks the agent, `ask` has been driving Notion since M3.

/** Session state, so it dies with the browser — a floor held across a restart is meaningless. */
async function floorHolder(agents) {
  const { floorHolder: name, floorAt = 0 } = await chrome.storage.session.get(['floorHolder', 'floorAt']);
  if (!name || Date.now() - floorAt > FLOOR_MS) return null;
  return findAgent(agents, name);
}

async function holdFloor(name) {
  await chrome.storage.session.set({ floorHolder: name, floorAt: Date.now() });
}

/**
 * Plain sentences for the ways an utterance can fail to name anybody.
 *
 * Separate strings rather than one "sorry, try again", because they send you to different
 * places: an empty roster wants the recorder, an unrecognised name wants you to say it again,
 * and a bare name wants nothing at all except for you to finish the sentence.
 */
const ROUTING_COPY = {
  'heard-nothing': "Didn't catch that.",
  'no-agents': 'No assistants yet — record one first.',
  'unknown-agent': "Didn't catch who you meant. Start with an assistant's name.",
};

/**
 * One spoken turn, end to end.
 *
 * **The tab is not switched, and that is a deliberate departure from the plan.** The plan says
 * "switch to the agent's tab", inherited from the Mac app, where driving a page meant posting
 * real keystrokes and therefore meant focusing it. The content script drives the DOM directly,
 * which works in a background tab on another window — measured, not assumed. So switching would
 * take somebody away from what they were doing to no purpose. The orb at E4 is how the answer
 * arrives; until then it is in the tab where it belongs.
 */
/**
 * The roster, plus what each agent's vendor is called out loud.
 *
 * Nobody says "take me to Ivan" — they say "Notion", and only the agent's name is in the
 * roster. The other name comes from the domain the recorder already captured.
 */
async function rosterWithProducts() {
  const { agents } = await loadRoster();
  return Promise.all(agents.map(async (agent) => ({
    ...agent,
    product: productName((await recipeFor(agent))?.domainPattern),
  })));
}

/**
 * Takes someone to an agent's tab, which is the one time we move them.
 *
 * `focusTab` rather than a bare `tabs.update`, so this inherits its ordering lesson: activate
 * the tab, *then* raise the window. The other order shows the window's previously-active tab
 * for a frame first, which reads as landing on the wrong page.
 */
async function goToAgent(nav) {
  if (nav.problem) {
    markDone(nav.problem);
    announceTurn({ phase: 'problem', message: 'Show you what? Ask an assistant something first.' });
    return;
  }

  const agent = nav.agent;
  const recipe = await recipeFor(agent);
  const tabs = recipe?.domainPattern
    ? await chrome.tabs.query({ url: matchPattern(recipe.domainPattern) })
    : [];
  const tab = tabs.find((t) => t.active) ?? tabs[0];

  if (!tab) {
    markDone('tab-not-found');
    announceTurn({ phase: 'problem', message: `No ${agent.product || agent.name} tab is open.` });
    return;
  }

  // Hidden before the switch, not after: the panel is injected into the tab being left, and
  // leaving it up there means it is still on screen when that tab is next looked at.
  await hidePanel();
  await focusTab({ tabId: tab.id });
  // Being shown an agent's tab is as much a reason to expect a follow-up as being answered by
  // it, so the floor moves here too — "show me Notion", then "what changed last week".
  await holdFloor(agent.name);
  markDone(null);
  announceTurn({ phase: 'navigated', agentName: agent.name });
}

async function handleUtterance(text) {
  const agents = await rosterWithProducts();
  const floor = await floorHolder(agents);

  // Navigation is checked first and returns null unless it is *certain* — the opening phrase
  // plus a name it recognises has to consume the whole utterance. Anything left over falls
  // through to being a question, which is what stops "show me the Q3 numbers" being swallowed.
  const nav = navigationTarget(text, agents, { floorHolder: floor });
  if (nav) return goToAgent(nav);

  const decision = route(text, agents, { floorHolder: floor });

  if (decision.problem) {
    markDone(decision.problem);
    panel({
      phase: 'needs-attention',
      message: decision.problem === 'name-only'
        ? `${decision.agent.name}?`
        : ROUTING_COPY[decision.problem] ?? 'Something went wrong.',
    });
    announceTurn({
      phase: 'problem',
      // `name-only` is answered by the agent's own name with a question mark — the spoken
      // equivalent of looking up. It is the one "failure" that is really just a pause.
      message: decision.problem === 'name-only'
        ? `${decision.agent.name}?`
        : ROUTING_COPY[decision.problem] ?? 'Something went wrong.',
    });
    return;
  }

  return putQuestion(decision.agent, decision.prompt, decision.matched);
}

/**
 * Asks one agent one question, with the panel and badge along for the ride.
 *
 * Split out of `handleUtterance` so the typed path reaches it too. Before this, speaking put
 * the answer on the orb and typing put it in the popup — two answer surfaces for one product,
 * and the popup's was an E2 stopgap from when there was no orb to put anything on.
 */
async function putQuestion(agent, prompt, matched) {
  trace('routed', `${agent.name} (${matched}), ${prompt.length} chars`);
  await rememberPrompt(prompt);
  markThinking(agent.name);
  panel({
    phase: 'thinking', agentName: agent.name, channel: channelFor(agent.name),
    transcript: prompt, volatile: '', answer: '', message: '', visible: true,
  }, { create: true });
  announceTurn({ phase: 'thinking', agentName: agent.name, matched });

  trace('asking the vendor');
  const result = await ask(agent.name, prompt);
  const vms = result.payload?.ms;
  trace('vendor answered', result.type === 'response'
    ? `${result.payload?.text?.length ?? 0} chars`
      + (vms
        ? ` · thinking ${vms.firstRow}ms, settling ${vms.settling}ms over ${vms.passes} passes`
        + ` (busy: ${vms.busy ?? 'none'})`
        : '')
    : (result.payload?.code ?? 'error'));

  if (result.type === 'response') {
    // The floor moves only on a real answer. An agent that failed did not take part in the
    // conversation, and inheriting follow-ups would send the next question somewhere it has
    // already been shown not to work.
    await holdFloor(agent.name);
    markDone(null);
    const answer = result.payload?.text ?? '';
    panel({ phase: 'answering', agentName: agent.name, answer });
    announceTurn({ phase: 'answered', agentName: agent.name, text: answer });
    await readAloud(answer, agent);
  } else {
    markDone(result.payload?.code ?? 'failed');
    panel({
      phase: 'needs-attention',
      agentName: agent.name,
      message: result.payload?.message ?? `${agent.name} could not answer.`,
    });
    announceTurn({
      phase: 'problem',
      agentName: agent.name,
      message: result.payload?.message ?? `${agent.name} could not answer.`,
    });
  }
}

/**
 * Speaks an answer, shortening it first if it is long enough to be tiring.
 *
 * **The full answer stays on screen either way.** What is spoken and what is shown are
 * different things, and conflating them is how a voice assistant becomes a screen reader —
 * which was the observation that started this whole architecture.
 *
 * Summarising is attempted but never waited on hopefully: `summarise` returns null on every
 * machine that fails Gemini Nano's hardware gate, which is a great many of them, and
 * `spokenForm` treats that as the ordinary case with a first-sentence fallback that says where
 * the rest is.
 */
async function readAloud(answer, agent) {
  if (!answer) return;
  const long = needsShortening(answer);
  const summary = long ? await summarise(answer) : null;
  if (long) trace('shortened', summary ? 'by the summariser' : 'first sentence (no summariser)');
  const { text, shortened } = spokenForm(answer, summary);
  if (!text) return;

  // The panel says when it is reading a shortened version, because someone hearing one sentence
  // about a six-paragraph answer should know that is what happened.
  if (shortened) panel({ sub: 'Shortened — the full answer is above.' });
  await say(text, agent.id);
}

/** Tells any open surface where the turn has got to. Nothing is stored and nothing is logged. */
function announceTurn(detail) {
  chrome.runtime.sendMessage({ kind: 'openposse.turn', ...detail }).catch(() => { /* nothing open */ });
}

// Wrapped, because nothing awaits this. An unhandled rejection in a service worker is silent,
// and the visible symptom would be a badge stuck on an agent who is not thinking about
// anything — the turn simply stopping, with no way to tell it from a slow vendor.
setTurnHandler((text) => {
  handleUtterance(text).catch((error) => {
    markDone('failed');
    announceTurn({ phase: 'problem', message: 'Something went wrong handling that.' });
    console.error('[openposse] turn failed:', error?.message ?? error);
  });
});

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
  } catch (error) {
    // A frame we are not allowed to inject into, or a tab that has gone. Falling back to the
    // top frame is what the code did before this existed, so this is never worse.
    //
    // Said out loud anyway: frame targeting is what fixed the bug where a frame with no
    // composer answered first and won by timing out. Degrading back to the top frame silently
    // is how that bug would return looking brand new.
    console.warn('[openposse] could not locate the assistant frame —', error?.message ?? error);
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

  // The wizard now lives in this worker rather than in a Mac app across a socket, so captures
  // are handed to it directly. The broadcast above is kept because it is what any *other*
  // surface would listen to, and it costs nothing when nothing does.
  onCapture(message.event).catch((error) => {
    console.error('[openposse] capture could not be folded in —', error);
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

  // **The all-sites grant is for the panel, never for the driver.**
  //
  // This function registers `content.js` for every granted origin, so without this line
  // turning on "show the panel on any page" would silently install the vendor driver into
  // every page the user visits — a `MutationObserver`, a message listener and a shadow-piercing
  // query on every tab, forever, to drive assistants that are not there.
  //
  // The panel does not need it: it is injected per turn by `executeScript`, which the host
  // permission is what makes possible. The driver stays where a recipe says an assistant is.
  const wanted = origins.filter((origin) => !covered.has(origin) && origin !== 'https://*/*');
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
// **Moved to `domain.js` and imported**, so the tab query, the content-script registration and
// the optional host-permission request build the same string from one definition. The copy that
// used to live here also carried a `.replace(/^\*\./, '*.')` that replaced `*.` with `*.` — a
// no-op that read as though it were doing something.

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
        ms: result.ms,
      });
    } else {
      reply('error', {
        code: result?.code ?? ERROR.timeout,
        message: result?.message ?? 'failed',
        openedBy: result?.openedBy,
      });
    }
  } catch (error) {
    // `sendMessage` rejects for several reasons and only one of them is "no content script".
    // The first version asserted that one for all of them and told everybody to reload the
    // page — advice that is right for a stale tab and useless for a tab that navigated
    // mid-exchange, which is the other common case.
    //
    // So the guess is checked against the error rather than substituted for it, and the error
    // is logged either way. A message, not page content: Chrome writes these itself.
    const detail = String(error?.message ?? error);
    const noListener = detail.includes('Receiving end does not exist');
    console.warn('[openposse] dispatch failed —', detail);

    reply('error', {
      code: ERROR.tabNotFound,
      message: noListener
        ? 'the tab has no OpenPosse content script — reload the page'
        : `could not reach the tab — ${detail}`,
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

  if (request?.kind === 'openposse.orb.reroute') {
    // Clicking an avatar puts the same question to someone else, straight to thinking — the
    // design's own behaviour, and the fastest repair when routing picked the wrong agent.
    //
    // Straight to `putQuestion` rather than back through routing: the agent was *clicked*, so
    // re-deriving them from a sentence would be throwing away the one unambiguous signal in
    // the whole loop.
    (async () => {
      const prompt = await recallPrompt();
      const { agents } = await loadRoster();
      const agent = findAgent(agents, request.agentName);
      if (!prompt || !agent) {
        panel({ phase: 'needs-attention', message: 'Nothing recent to ask again.' });
        respond({ ok: false });
        return;
      }
      respond({ ok: true });
      await putQuestion(agent, prompt, 'reroute');
    })();
    return true;
  }

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
    // The typed path, through the same door as the spoken one — so the answer lands on the orb
    // rather than in a popup that closes the moment you look away.
    loadRoster()
      .then(({ agents }) => findAgent(agents, request.agentName))
      .then((agent) => (agent
        ? putQuestion(agent, request.prompt, 'typed')
        : announceTurn({ phase: 'problem', message: `No agent called ${request.agentName}.` })))
      .catch(() => {});
    respond({ ok: true });
    return true;
  }
  if (request?.kind === 'openposse.record') {
    beginWizard(request).then(respond, (error) => {
      console.error('[openposse] recording could not start —', error);
      respond({ ok: false, reason: String(error?.message ?? error) });
    });
    return true;
  }

  // Renaming is an edit to an agent that already exists, from Settings. It is deliberately not
  // part of recording any more: a recording that cannot finish without a name is a recording
  // held hostage by whatever the vendor's page does about focus.
  if (request?.kind === 'openposse.agent.recipe') {
    // What a recording actually captured, for the Settings page to show. Read straight from
    // storage rather than reconstructed, so what is displayed is what the runtime will use.
    findAgent2(request.agentId).then(
      async (agent) => respond({ ok: Boolean(agent), recipe: agent ? await recipeFor(agent) : null }),
      (error) => respond({ ok: false, reason: String(error?.message ?? error) }),
    );
    return true;
  }

  if (request?.kind === 'openposse.agent.remove') {
    removeAgent(request.agentId).then(
      () => respond({ ok: true }),
      (error) => respond({ ok: false, reason: String(error?.message ?? error) }),
    );
    return true;
  }

  if (request?.kind === 'openposse.agent.rerecord') {
    rerecord(request.agentId).then(respond, (error) => {
      console.error('[openposse] re-record could not start —', error);
      respond({ ok: false, reason: String(error?.message ?? error) });
    });
    return true;
  }

  if (request?.kind === 'openposse.agent.voice') {
    setAgentVoice(request.agentId, request.voice).then(respond, (error) => {
      console.error('[openposse] voice could not be set —', error);
      respond({ ok: false, reason: String(error?.message ?? error) });
    });
    return true;
  }

  if (request?.kind === 'openposse.agent.rename') {
    renameAgent(request.agentId, request.name).then(respond, (error) => {
      console.error('[openposse] rename failed —', error);
      respond({ ok: false, reason: String(error?.message ?? error) });
    });
    return true;
  }
  return false;
});

// ── The wizard (E8) ────────────────────────────────────────────────────────────────────────
//
// Four beats: **grant → record (coached) → dry run → name.** The grant already happened in the
// popup, because that is where the user gesture is — see `popup.js`.
//
// The rules live elsewhere on purpose. `draft.js` decides what has been captured and what is
// still wrong with it, `coaching.js` decides what to say about that, and both are pure and
// tested without a browser. This file is the part that cannot be: permissions, tabs, timers and
// the orb.

/** The wizard in progress, or null. `{ draft, tabId, armedAt, agentId, alreadyOpen }`. */
let wizard = null;

/** An agent by id, since `findAgent` matches on the spoken name. */
async function findAgent2(agentId) {
  const { agents } = await loadRoster();
  return agents.find((a) => a.id === agentId) ?? null;
}

/**
 * Re-records an existing agent, replacing its recipe and keeping its name and voice.
 *
 * **No permission prompt and no user gesture**, which is why this can be driven from Settings
 * at all: the origin was granted when the agent was first recorded, and a grant does not need
 * asking for twice. What it does need is one of that vendor's pages open, because a recording
 * is somebody demonstrating the assistant — so a missing tab is reported as the plain fact it
 * is rather than as a failure.
 */
async function rerecord(agentId) {
  const agent = await findAgent2(agentId);
  if (!agent) return { ok: false, reason: 'no such agent' };

  const recipe = await recipeFor(agent);
  const pattern = recipe?.domainPattern;
  if (!pattern) return { ok: false, reason: `${agent.name} has no recipe to re-record` };

  const [tab] = await chrome.tabs.query({ url: matchPattern(pattern) });
  if (!tab) {
    return { ok: false, reason: `open a ${productName(pattern)} tab first, then try again` };
  }

  // Brought forward, because the next thing asked of the user is to demonstrate the assistant
  // and they cannot do that on a tab they are not looking at.
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });

  await beginWizard({ tabId: tab.id, pattern, agentId });
  return { ok: true, tabId: tab.id };
}

async function beginWizard({ tabId, pattern, agentId = null }) {
  if (!pattern) throw new Error('no domain pattern');

  // Registered for every *future* load of this site; `armRecording` handles the one tab already
  // in front of the user, which has no content script because it was open before the grant.
  await registerFor(pattern);

  wizard = {
    draft: newDraft(pattern),
    tabId,
    armedAt: Date.now(),
    // Cleared before the dry run. See `stopCapturing`.
    capturing: true,
    // Re-recording an existing agent keeps its name and voice and replaces only the recipe, so
    // the naming beat is skipped for it. The popup's "needs re-recording" is what leads here.
    agentId,
    alreadyOpen: false,
  };

  const id = crypto.randomUUID();
  await armRecording({ tabId }, { id, agent: agentId });

  // The orb goes over the tab being recorded rather than whatever is in front — that is where
  // the person is about to be working, and it is an origin we now hold a permission for, so it
  // persists for the whole recording instead of being spent like `activeTab`.
  await primePanel(tabId);
  await showCoaching();

  // The open step is the only one with a deadline, so it is the only one that needs a tick. It
  // fires once: `derive` is what decides whether 45 s has meaning yet, not this timer.
  wizard.patience = setTimeout(() => { showCoaching().catch(() => {}); }, PATIENCE_MS + 500);

  return { ok: true };
}

/** Pushes whatever `coaching.js` decided into the orb. */
async function showCoaching() {
  if (!wizard) return;
  const state = derive(wizard.draft, {
    alreadyOpen: wizard.alreadyOpen,
    sinceArmedMs: Date.now() - wizard.armedAt,
  });

  await panel({
    phase: 'recording',
    visible: true,
    coach: {
      step: state.step,
      label: stepLabel(state),
      instruction: instruction(state, wizard.draft),
      captures: captures(wizard.draft),
      // The panel never asks for a name. See `save()`.
      naming: false,
      bad: state.step === 'replies-share-nothing' || state.step === 'abandoned',
    },
  }, { create: true });
}

/**
 * Folds one capture in, and moves the wizard on when there is nothing left to capture.
 *
 * Called from the capture relay below rather than from a request/response pair, because
 * captures arrive over minutes and are events on an open channel.
 */
async function onCapture(event) {
  if (!wizard || !wizard.capturing) return;
  if (event?.kind === 'armed') wizard.alreadyOpen = event.alreadyOpen === true;

  wizard.draft = applyCapture(wizard.draft, event);
  await showCoaching();

  if (isComplete(wizard.draft) && !wizard.verifying && !wizard.verified) {
    wizard.verifying = true;
    await dryRun();
  }
}

/**
 * Executes the fresh recipe twice, before anyone is asked to name it.
 *
 * **The dry run is not the two-answer recording**, and conflating them is easy. The recorder
 * needs two answers to find a selector describing *both*; this executes the finished recipe on
 * exchanges it did not witness, and it is the only place two things can be settled, because
 * both are questions about what *we* can do rather than what the user did:
 *
 * - **Whether a synthetic trigger works.** The recorder watched a real keypress, which always
 *   works. Whether a dispatched event opens the same panel is a different question with a
 *   different answer per vendor, and the only way to find out is to try.
 * - **Whether the reply selector names one answer repeatedly.** Notion broke this once: a
 *   per-message id made the recipe name *one message*, and the recorder's own 0→1 count passed
 *   it, because 0→1 is exactly what a genuine per-reply container looks like on a conversation
 *   holding one reply.
 *
 * Two questions, deliberately different words, both bland: they go into the user's real
 * assistant against their real workspace, so they must not create anything or ask for anything.
 */
async function dryRun() {
  const built = finish(wizard.draft, { triggerMethod: 'synthetic' });
  if (!built.ok) { wizard.verifying = false; return; }

  // **Stop watching before we start typing.** The dry run drives the page — two questions, two
  // answers — and with the recorder still armed every one of those is captured as though the
  // user had done it. That is not a cosmetic overlap: the extra answers go back through
  // `selectorForBoth`, and Notion's replies have genuinely different shapes depending on
  // whether it used a tool, so a draft that had *already passed* was being retroactively broken
  // by its own verification. It presented as "we saw two answers but couldn't find anything
  // they have in common" sitting above a name field.
  //
  // It is also the right privacy behaviour. The recorder's keydown listener must not be live
  // while we type text into somebody's assistant.
  await stopCapturing();

  await panel({ phase: 'recording', coach: { label: 'SETTING UP · CHECKING', instruction: 'Checking it works — asking it two questions…', captures: captures(wizard.draft), naming: false } });

  const questions = ['Hello.', 'What can you help me with?'];
  const answers = [];
  for (const prompt of questions) {
    // Sequential on purpose: two at once would race the same composer, and the second answer
    // has to *follow* the first to prove the selector finds a new one rather than re-reading
    // the old one.
    const result = await askOnce(wizard.tabId, built.recipe, prompt)
      .catch((e) => ({ error: e }));
    if (!result || result.error || !result.text) {
      wizard.verifying = false;
      wizard.verified = false;
      await panel({
        phase: 'recording',
        coach: {
          label: 'SETTING UP · DIDN’T WORK',
          instruction: 'We recorded it, but driving it ourselves didn’t work. That usually means '
            + 'this assistant ignores clicks it didn’t get from a person. Nothing has been saved.',
          captures: captures(wizard.draft),
          naming: false,
          bad: true,
        },
      });
      return;
    }
    answers.push(result.text);
  }

  // Two identical answers mean the selector is reading the same element twice rather than
  // finding the new one — the failure the second question exists to catch.
  wizard.verified = answers[0] !== answers[1];
  wizard.verifying = false;
  wizard.recipe = built.recipe;

  if (!wizard.verified) {
    await panel({
      phase: 'recording',
      coach: {
        label: 'SETTING UP · DIDN’T WORK',
        instruction: 'We read the same answer twice, so we wouldn’t be able to tell one reply '
          + 'from the next. This assistant may not be one we can drive yet.',
        captures: captures(wizard.draft),
        naming: false,
        bad: true,
      },
    });
    return;
  }

  // ── Saved here, not after somebody types a name ───────────────────────────────────────
  //
  // **The recording is complete and verified at this point; a name is decoration on top of it.**
  // Asking for one first made the whole thing hostage to a text field inside the vendor's page,
  // and a page is entitled to manage its own focus — Notion takes it back within 150 ms, every
  // time, and that will differ per vendor forever. Two attempts to win that fight were two
  // attempts too many.
  //
  // So it is saved under the vendor's own product name, which is what somebody would have
  // typed anyway: "Notion", from the domain the recorder already captured. Renaming it to
  // "Ivan" is then an edit to something that exists, in Settings, where no page can interfere.
  await save();
}

/** Writes the verified recipe out, as a new agent or over the one being re-recorded. */
async function save() {
  const recipe = wizard?.recipe;
  if (!recipe) return;

  if (wizard.agentId) {
    await replaceRecipe(wizard.agentId, recipe);
    await endWizard();
    await panel({ phase: 'idle', visible: false });
    return;
  }

  const { agents } = await loadRoster();

  // **Capitalised here, not in `productName`.** That function exists for matching — "take me to
  // Notion" is normalised before it is compared — so lowercase is correct there and wrong the
  // moment the same string becomes something a person reads and says out loud.
  //
  // The first letter only, because that is all a domain label supports honestly: `leanix`
  // becomes `Leanix` rather than `LeanIX`, and guessing the inner capitals of a brand from its
  // domain would be wrong more often than not. Renaming it takes one click in Settings, which
  // is the whole reason naming moved there.
  const product = productName(recipe.domainPattern);
  const suggested = product ? product[0].toUpperCase() + product.slice(1) : 'Assistant';
  const name = freeName(agents, suggested);
  // The voice comes from `assignVoices`' accent heuristic rather than being chosen here, and
  // Settings has the picker with previews for anyone who wants a different one.
  await addAgent({ name, voice: null, recipe });

  // **The one thing the dry run cannot check, said out loud.**
  //
  // Verification runs immediately after a recording, so the assistant is still open — which
  // means `askAssistant` never has to trigger it and the opening step is the one part of the
  // recipe that goes untested. A vendor that ignores scripted keystrokes then passes the dry
  // run and fails at the first real question, minutes later, reading as a broken agent.
  //
  // Saying so here is not a substitute for testing it, and it is not marked as a failure —
  // plenty of assistants accept a synthetic shortcut. It is the honest statement of what was
  // and was not proven.
  const caution = wizard.draft.openMethod === 'shortcut'
    ? ` It opens with a shortcut, and some assistants ignore key presses that came from a `
      + `script. If ${name} doesn’t answer, re-record it from Settings and open the assistant `
      + `by clicking instead.`
    : '';

  await panel({
    phase: 'recording',
    coach: {
      label: 'SETTING UP · DONE',
      instruction: `Saved as ${name}. You can rename it in Settings, or just say `
        + `“${name}, …” to talk to it.${caution}`,
      captures: captures(wizard.draft),
      naming: false,
    },
  });
  await endWizard();
}

/** One exchange through the recorded recipe, in the tab it was recorded in. */
async function askOnce(tabId, recipe, prompt) {
  // The *input* selector, not the recipe: `frameOwningAssistant` runs one probe per frame and
  // asks each whether it can see that element. Notion has two frames and only one holds the
  // composer, and without this the promise resolves with whichever answers first.
  const frameId = await frameOwningAssistant(tabId, recipe.inputSelector);
  return chrome.tabs.sendMessage(
    tabId,
    { intent: 'ask_assistant', recipe, prompt },
    frameId == null ? undefined : { frameId },
  );
}

/** The last beat: a name, a voice, and a roster entry. */
/**
 * Takes the recorder's listeners off the page, without ending the recording.
 *
 * Deliberately **not** `disarmRecording`, which also clears the keepalive — and the dry run is
 * two full exchanges with a vendor, which is exactly the minutes of silence MV3 terminates an
 * idle worker for. Killing the keepalive here would end the wizard partway through verifying
 * it, with nothing to say why.
 */
async function stopCapturing() {
  if (!wizard) return;
  wizard.capturing = false;
  try {
    await chrome.tabs.sendMessage(wizard.tabId, { intent: 'disarm_recording' });
  } catch (error) {
    // Best-effort: the tab may have gone. The `capturing` flag above is what actually protects
    // the draft, so this failing costs nothing but is worth naming rather than swallowing.
    console.warn('[openposse] recorder would not disarm —', error?.message ?? error);
  }
}

async function endWizard() {
  if (!wizard) return;
  clearTimeout(wizard.patience);
  const { tabId } = wizard;
  wizard = null;
  await disarmRecording({ tabId }).catch(() => {});
}

/** Registers the content script for a newly granted pattern, without duplicating an existing one. */
async function registerFor(pattern) {
  const id = `openposse-${pattern}`;
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] })
    .catch(() => []);
  if (existing.length > 0) return;

  await chrome.scripting.registerContentScripts([{
    id,
    matches: [matchPattern(pattern)],
    js: ['dist/content.js'],
    allFrames: true,
    runAt: 'document_idle',
  }]);
}

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
chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== 'summon') return;
  // **First, before any await.** `activeTab` is granted by this keypress and is spent by the
  // time an async chain gets around to using it — which is why the orb only ever appeared on
  // Notion, the one site with a standing host permission. The event carries the tab, so no
  // query is needed either.
  primePanel(tab?.id);
  toggleListening();
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
