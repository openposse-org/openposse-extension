// A scripted turn, so the side panel can be looked at without spending a vendor query.
//
// The need is ordinary and the reason it is worth a file: **judging the UI needs a turn, and a
// turn costs a real question against somebody's Notion quota, needs a granted site, needs the
// assistant open, and takes twelve seconds to reach the state you wanted to look at.** So the
// states that are hardest to get at – routing, a shortened answer, a follow-up with no name –
// are the ones nobody ever sees twice. This replays all of them in under a minute.
//
// ── The one rule this file has to keep ────────────────────────────────────────────────────────
//
// **Every patch goes through the real `panel()`, and the answer is spoken by the real `say()`.**
// Nothing here renders anything, nothing here knows what a surface looks like, and there is no
// second code path for the panel to fall out of step with. What is faked is exactly
// one thing: the vendor. The recogniser, the router and the content script are not involved
// because they are not being demonstrated – but everything downstream of a turn is the genuine
// article, which is what makes this worth looking at rather than a mockup that agrees with
// itself.
//
// Two consequences that follow from that and are easy to get backwards:
//
// - **It uses the real roster.** Channel colours, voices and vendor names are the ones on this
//   machine, so the demo is a test of *your* setup rather than of a cast invented here. The
//   fabricated pair below is a fallback for a roster too small to show a hand-off, not a
//   default.
// - **It really speaks.** `say()` is the same call a real answer makes, so this exercises voice
//   selection, the Kokoro/system-voice routing and the `UNSPOKEN_COPY` failure path. That is
//   most of what "test the voice without calling Notion" has to mean.
//
// **Kept as a product feature, by decision of 2026-10-24.** It is the empty roster's "Show me
// what a turn looks like", which fills a real first-run gap, as well as the quiet button over the
// panel's sphere.

import { panel, panelLevel } from './panel.js';
import { beginTurn, trace } from './trace.js';
import {
  markThinking, markDone, VOLATILE_TAIL, hush, pauseVoice, resumeVoice,
} from './listening.js';
import { channelOf, pickChannel } from './channels.js';
import { loadRoster, lassoFor } from './storage.js';
import { productLabel } from './routing.js';
import { vendorTab } from './tabs.js';

/**
 * The script. Five turns, chosen to cover what a single turn cannot.
 *
 * Turn 3 is the one worth having: **a follow-up with no name**, which is the floor holder doing
 * its job and the only part of routing that is invisible from a transcript. The hero on the
 * landing page uses the first three for the same reason.
 *
 * Turn 4 is for judging overflow, added 2026-10-06: a question too long for its slot even at the
 * smallest size, so it is cut, and an answer several times the box's height, so it scrolls.
 *
 * Turn 5 is a "show me", added the same day: the one turn that leaves the panel. It opens a
 * notion.com tab of its own where a real one finds the agent's tab, so it works with no vendor tab
 * open. After the switch it writes to the panel exactly what `goToAgent` does: the agent, at rest.
 *
 * **The script writes no note under an answer**, though the panel has a line for one. A real turn
 * writes there only when an answer was shortened or could not be spoken, so a note here – a
 * source, or "the floor was still held" – would show the panel something no real turn does. The
 * status line and the lit avatar already say who took a follow-up. Turn 4 does get one, from the
 * real turn's `readAloud`, because its answer is long enough to be shortened.
 */
const SCRIPT = [
  {
    cast: 0,
    ask: 'summarise the Q3 planning page.',
    answer: 'Q3 is three launches. The billing migration has moved to August.',
  },
  {
    cast: 1,
    ask: 'which deals closed this week?',
    answer: 'Four closed this week. The biggest is Northwind.',
  },
  {
    cast: 1,
    // No name, so it reads as a follow-up. `named: false` is what makes the transcript omit it.
    named: false,
    ask: 'and which are still open?',
    answer: 'Eleven are still open. Three are due to close by Friday.',
  },
  {
    cast: 0,
    ask: 'going back to the Q3 planning page, can you walk me through what moving the billing '
      + 'migration to August means for the other two launches, who owns each of them now, and '
      + 'whether the page says anything about what happens if August slips as well?',
    answer: 'Moving billing to August pushes both other launches back by about two weeks, because '
      + 'each of them needs the new invoice service first. The partner portal moves from mid-July '
      + 'to the end of July, and the mobile app release from the first week of August to the '
      + 'third. The owners are the same: Dana leads the billing migration, Marcus the partner '
      + 'portal and Leila the mobile release, with Sam covering for Leila in the last two weeks of '
      + 'July. If August slips as well, the page names three risks. The September price change '
      + 'cannot go live on the old billing system, so it would move to October. Annual renewals '
      + 'start on the first of September, and finance would have to invoice them by hand. And the '
      + 'partner portal would launch without self-serve invoices, which would need a follow-up '
      + 'release. The page proposes a go or no-go decision on the fifteenth of July, to leave '
      + 'time to plan for any of those.',
  },
  {
    cast: 0,
    // No name, so the floor decides whose tab, as it does for a real "show me". Turn 4 left it here.
    named: false,
    ask: 'show me',
    show: true,
  },
];

/** Only used when the roster cannot supply two distinct agents to hand off between. */
const STAND_INS = [
  { id: null, name: 'Ivan', product: 'Notion' },
  { id: null, name: 'Priya', product: 'Breeze' },
];

const TIMING = {
  beforeTyping: 900,
  perChar: 38,
  charJitter: 34,
  beforeRouting: 620,
  routing: 1150,
  thinking: 1400,
  betweenTurns: 2600,
};

/**
 * Which generation of the demo is current.
 *
 * **A new run stops the old one rather than overlapping it**, and so does anything that starts a
 * real turn. A second press of the button pauses now, so a restart only comes from a panel
 * reopened mid-demo, which shows Play. Without this, two scripts push conflicting patches at the
 * same surface and the result is a panel flickering between two transcripts – which looks like a
 * rendering bug in the thing being evaluated, and is the worst possible failure for a tool whose
 * whole job is to make the rendering judgeable.
 */
let generation = 0;

/** The generation that is playing, or null between runs. Pause and Resume act on nothing else. */
let live = null;

/** Whether the script is held: its clock, its synthetic microphone and the voice. */
let paused = false;

/**
 * The wait the script is in, so a pause can stop its clock and a resume restart it with what was
 * left. One is enough, because the script is sequential and never in two waits at once.
 */
let pending = null;

function wait(ms) {
  return new Promise((resolve) => {
    pending = { resolve, left: ms, since: 0, timer: null };
    if (!paused) run(pending);
  });
}

function run(w) {
  w.since = Date.now();
  w.timer = setTimeout(() => {
    if (pending === w) pending = null;
    w.resolve();
  }, w.left);
}

/** Ends any demo in flight. Called by the real listen toggle, so a turn always wins. */
export function stopDemo() {
  generation += 1;
  paused = false;
  // A paused script is parked in a wait with no timer, and would never wake to see it had been
  // stopped. Resolving the wait lets it reach its next `alive()` check and leave.
  if (pending) {
    const w = pending;
    pending = null;
    clearTimeout(w.timer);
    w.resolve();
  }
}

/**
 * The panel's Pause: holds the script's clock, its synthetic microphone and the voice, mid-word.
 *
 * Answers rather than throws when nothing is playing, because the button can outlive the run it
 * was showing – one a real turn ended, say.
 */
export function pauseDemo() {
  if (live !== generation) return { ok: false, reason: 'no demo is playing' };
  if (!paused) {
    paused = true;
    if (pending?.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
      pending.left = Math.max(0, pending.left - (Date.now() - pending.since));
    }
    panelLevel(0);
    pauseVoice();
  }
  return { ok: true };
}

export function resumeDemo() {
  if (live !== generation) return { ok: false, reason: 'no demo is playing' };
  if (paused) {
    paused = false;
    if (pending && !pending.timer) run(pending);
    resumeVoice();
  }
  return { ok: true };
}

/**
 * The panel's Stop: ends the run, silences the voice and leaves the panel empty and at rest.
 *
 * **Cleared, where a run that finishes is left on its last turn.** A stop can land before an agent
 * is picked, and the status line would then read "No question yet" beside a half-typed question.
 */
export async function endDemo() {
  stopDemo();
  try {
    await hush();
  } catch (error) {
    console.warn('[openposse] the demo could not be silenced –', error?.message ?? error);
  }
  panelLevel(0);
  await panel({
    phase: 'idle',
    transcript: '', volatile: '', answer: '', sub: '', message: '',
    agentName: null, channel: null, warming: false,
  });
}

/**
 * The cast, preferring real agents and filling the gaps.
 *
 * A one-agent roster still gets every turn – the hand-off in turn 2 just goes to a stand-in,
 * which is better than dropping the turn that demonstrates the floor.
 */
async function cast() {
  const { agents } = await loadRoster().catch(() => ({ agents: [] }));
  const real = await Promise.all(agents.slice(0, 2).map(async (agent) => {
    const pattern = (await lassoFor(agent))?.domainPattern ?? null;
    return {
      id: agent.id,
      name: agent.name,
      product: productLabel(pattern) || null,
      // For "show me", which looks for this agent's open tab the way a real turn does.
      pattern,
      channel: channelOf(agent),
    };
  }));
  const pair = [real[0] ?? STAND_INS[0], real[1] ?? STAND_INS[1]];

  // A stand-in takes the colour a new agent would get next to whoever is already in the cast.
  // Its name alone would hash to green for both of them, which is the clash colours are now
  // assigned to prevent – and the demo exists to show a hand-off between two agents.
  const taken = pair.flatMap((member) => (member.channel ? [member.channel] : []));
  return pair.map((member) => {
    if (member.channel) return member;
    const channel = pickChannel(taken);
    taken.push(channel);
    return { ...member, channel };
  });
}

/**
 * A synthetic microphone, pushed at roughly the rate the real meter arrives at.
 *
 * **Not decoration: it is half of what the listening state actually looks like.** The orb's
 * radius is the microphone, deliberately, so a demo that left `level` at null would draw the
 * synthetic fallback curve – the one that exists for browsers with no meter at all – and show
 * a listening state no user with a working microphone ever sees.
 */
function speakingInto(token) {
  let t = 0;
  const timer = setInterval(() => {
    if (generation !== token) { clearInterval(timer); return; }
    if (paused) return;
    t += 1;
    // Syllables rather than a sine: a voice is bursts with gaps, and a smooth swell reads as a
    // tone being held. The floor keeps it off zero, which is a silent room rather than speech.
    const syllable = Math.abs(Math.sin(t / 3.4)) ** 1.6;
    panelLevel(Math.min(1, 0.14 + 0.72 * syllable * (0.75 + 0.25 * Math.sin(t / 11))));
  }, 50);
  return () => clearInterval(timer);
}

/** One turn of the script, from the shortcut to the answer being read out. */
async function playTurn(step, who, token, readAloud) {
  const alive = () => generation === token;
  const utterance = step.named === false ? step.ask : `${who.name}, ${step.ask}`;

  // **Named `demo`, and resetting the clock, for two separate reasons.** `trace` measures from
  // the last `beginTurn`, so without this the voice timings would read against whatever real
  // turn last happened – an elapsed column of nonsense beside deltas that are still correct,
  // which is worse than no number. And the label is what tells somebody reading the worker's
  // console that these milliseconds came from a script rather than from a vendor, which matters
  // precisely when the console is being read to answer "is the voice slower than it was".
  beginTurn('demo');
  const what = step.show ? 'a tab switch' : `${step.answer.length} chars to speak`;
  trace('scripted turn', `${who.name}${who.id ? '' : ' (stand-in)'} · ${what}`);

  // Exactly `startListening`'s opening patch, including `create` – so the panel gets the roster
  // and the shortcut the same way a real turn gives them.
  await panel({
    phase: 'listening',
    transcript: '', volatile: '', answer: '', sub: '', message: '',
    agentName: null, channel: null,
  }, { create: true });
  // Before the first wait, because a run stopped here would otherwise take the wait a newer run
  // is pausing on.
  if (!alive()) return;

  const quiet = speakingInto(token);
  await wait(TIMING.beforeTyping);

  for (let n = 1; n <= utterance.length && alive(); n += 1) {
    const heard = utterance.slice(0, n);
    panel({
      transcript: heard.slice(0, -VOLATILE_TAIL),
      volatile: heard.slice(-VOLATILE_TAIL),
    });
    await wait(TIMING.perChar + Math.random() * TIMING.charJitter);
  }
  quiet();
  if (!alive()) return;

  await wait(TIMING.beforeRouting);
  if (!alive()) return;
  // The recogniser committing. Same shape as `handleOffscreenMessage`'s final branch: the tail
  // stops being volatile and the caret goes, because there is nothing left to revise.
  panel({ phase: 'routing', transcript: utterance, volatile: '' });

  await wait(TIMING.routing);
  if (!alive()) return;

  if (step.show) {
    // `goToAgent`'s steps in its order: the agent's open tab found, the tab made active, its window raised, then the panel left at rest on the agent. The floor stays where
    // it was, as it does for every scripted turn, and there is no answer, because a real one
    // gives none.
    //
    // **An open tab or nothing, as for real.** This used to open notion.com in a new tab, which
    // demonstrated the one thing "show me" must never do. A stand-in has no site, so it always
    // lands on the message, which is what a real turn says with no tab open.
    const tab = await vendorTab(who.pattern);
    if (!alive()) return;
    if (!tab) {
      markDone('tab-not-found');
      panel({ phase: 'needs-attention', message: `No ${who.product ?? 'assistant'} tab is open.` });
      return;
    }
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    // Stop's resting panel must not be overwritten by a switch that was already under way.
    if (!alive()) return;
    panel({ phase: 'idle', agentName: who.name, channel: who.channel });
    markDone(null);
    return;
  }

  markThinking(who.name, who.channel);
  panel({
    phase: 'thinking', agentName: who.name, channel: who.channel,
    transcript: utterance, volatile: '', answer: '', message: '',
  });

  await wait(TIMING.thinking);
  if (!alive()) return;
  markDone(null);
  panel({ phase: 'answering', agentName: who.name, answer: step.answer });

  // The real turn's `readAloud`, so a long answer is shortened and noted as a real one is, and the
  // voice this picks is the voice a real answer would get. Awaited, so the next turn does not
  // start talking over this one.
  await readAloud(step.answer, who);
}

/**
 * Runs the whole script.
 *
 * Returns once it is finished or interrupted, so the caller can report which. Nothing is thrown
 * on interruption: being cut off by a real turn or by Stop is the intended behaviour, not a
 * failure.
 *
 * `readAloud` is the worker's own, passed in because it lives in the file that imports this one,
 * so importing it back would be a cycle. Added 2026-10-06, when turn 4 made an answer long enough
 * to be shortened.
 */
export async function runDemo(readAloud) {
  stopDemo();                     // and releases an old run that was paused, which would not wake
  const token = generation;
  live = token;
  const who = await cast();
  // The recorder's own keep-alive, for the same reason: MV3 kills an idle worker in ~30 s and
  // this script runs for about a minute with nothing but timers in it. Without this the demo
  // stops partway through with nothing to explain why, which is the exact failure shape the
  // thing being demonstrated exists to avoid.
  const keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo(); }, 20_000);

  try {
    for (const step of SCRIPT) {
      if (generation !== token) return { ok: false, reason: 'interrupted' };
      await playTurn(step, who[step.cast], token, readAloud);
      if (generation !== token) return { ok: false, reason: 'interrupted' };
      await wait(TIMING.betweenTurns);
    }
    if (generation !== token) return { ok: false, reason: 'interrupted' };
    // Left where the last turn ended rather than cleared. A panel keeps its last answer between
    // turns by design, so clearing here would end the demo in a state the product never shows.
    return { ok: true };
  } finally {
    clearInterval(keepAlive);
    markDone(null);
    if (live === token) live = null;
  }
}
