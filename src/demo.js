// A scripted turn, so both surfaces can be looked at without spending a vendor query.
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
// second code path for the panel or the orb to fall out of step with. What is faked is exactly
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
// **Scaffolding, with the same expiry as the surface switch.** It is reachable from a quiet
// button and nothing else. If it survives to a Web Store listing it should survive as a product
// feature – a "show me what a turn looks like" for the empty roster, which is a real first-run
// gap – and not as a dev tool somebody forgot to take out.

import { panel, panelLevel } from './panel.js';
import { beginTurn, trace } from './trace.js';
import { say, markThinking, markDone, VOLATILE_TAIL } from './listening.js';
import { channelOf, pickChannel } from './channels.js';
import { loadRoster, recipeFor } from './storage.js';
import { productLabel } from './routing.js';

/**
 * The script. Three turns, chosen to cover what a single turn cannot.
 *
 * Turn 3 is the one worth having: **a follow-up with no name**, which is the floor holder doing
 * its job and the only part of routing that is invisible from a transcript. The hero on the
 * landing page uses the same three for the same reason.
 */
const SCRIPT = [
  {
    cast: 0,
    ask: 'summarise the Q3 planning page.',
    answer: 'Q3 is three launches. The billing migration has moved to August.',
    sub: 'From “Q3 planning”',
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
    // No note saying the floor was held. A real follow-up never explains itself, and the status
    // line and the lit avatar already show who took it.
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
 * **A second press restarts rather than overlapping**, and anything that starts a real turn
 * stops this one. Without that, two scripts push conflicting patches at the same surface and
 * the result is a panel flickering between two transcripts – which looks like a rendering bug
 * in the thing being evaluated, and is the worst possible failure for a tool whose whole job is
 * to make the rendering judgeable.
 */
let generation = 0;

/** Ends any demo in flight. Called by the real listen toggle, so a turn always wins. */
export function stopDemo() {
  generation += 1;
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The cast, preferring real agents and filling the gaps.
 *
 * A one-agent roster still gets all three turns – the hand-off in turn 2 just goes to a stand-in,
 * which is better than dropping the turn that demonstrates the floor.
 */
async function cast() {
  const { agents } = await loadRoster().catch(() => ({ agents: [] }));
  const real = await Promise.all(agents.slice(0, 2).map(async (agent) => ({
    id: agent.id,
    name: agent.name,
    product: productLabel((await recipeFor(agent))?.domainPattern) || null,
    channel: channelOf(agent),
  })));
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
    t += 1;
    // Syllables rather than a sine: a voice is bursts with gaps, and a smooth swell reads as a
    // tone being held. The floor keeps it off zero, which is a silent room rather than speech.
    const syllable = Math.abs(Math.sin(t / 3.4)) ** 1.6;
    panelLevel(Math.min(1, 0.14 + 0.72 * syllable * (0.75 + 0.25 * Math.sin(t / 11))));
  }, 50);
  return () => clearInterval(timer);
}

/** One turn of the script, from the shortcut to the answer being read out. */
async function playTurn(step, who, token) {
  const alive = () => generation === token;
  const utterance = step.named === false ? step.ask : `${who.name}, ${step.ask}`;

  // **Named `demo`, and resetting the clock, for two separate reasons.** `trace` measures from
  // the last `beginTurn`, so without this the voice timings would read against whatever real
  // turn last happened – an elapsed column of nonsense beside deltas that are still correct,
  // which is worse than no number. And the label is what tells somebody reading the worker's
  // console that these milliseconds came from a script rather than from a vendor, which matters
  // precisely when the console is being read to answer "is the voice slower than it was".
  beginTurn('demo');
  trace('scripted turn', `${who.name}${who.id ? '' : ' (stand-in)'} · ${step.answer.length} chars to speak`);

  // Exactly `startListening`'s opening patch, including `create` – so the orb gets injected on
  // this path too and the demo is a test of both surfaces rather than only the one in front.
  await panel({
    phase: 'listening', visible: true,
    transcript: '', volatile: '', answer: '', sub: '', message: '',
    agentName: null, channel: null,
  }, { create: true });

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
  markThinking(who.name, who.channel);
  panel({
    phase: 'thinking', agentName: who.name, channel: who.channel,
    transcript: utterance, volatile: '', answer: '', message: '', visible: true,
  });

  await wait(TIMING.thinking);
  if (!alive()) return;
  markDone(null);
  panel({ phase: 'answering', agentName: who.name, answer: step.answer });
  if (step.sub) panel({ sub: step.sub });

  // The real `say`, so the voice this picks is the voice a real answer would get. Awaited, so
  // the next turn does not start talking over this one.
  await say(step.answer, who.id);
}

/**
 * Runs the whole script.
 *
 * Returns once it is finished or interrupted, so the caller can report which. Nothing is thrown
 * on interruption: being cut off by a real turn is the intended behaviour, not a failure.
 */
export async function runDemo() {
  const token = ++generation;
  const who = await cast();
  // The recorder's own keep-alive, for the same reason: MV3 kills an idle worker in ~30 s and
  // this script runs for about a minute with nothing but timers in it. Without this the demo
  // stops partway through with nothing to explain why, which is the exact failure shape the
  // thing being demonstrated exists to avoid.
  const keepAlive = setInterval(() => { chrome.runtime.getPlatformInfo(); }, 20_000);

  try {
    for (const step of SCRIPT) {
      if (generation !== token) return { ok: false, reason: 'interrupted' };
      await playTurn(step, who[step.cast], token);
      if (generation !== token) return { ok: false, reason: 'interrupted' };
      await wait(TIMING.betweenTurns);
    }
    if (generation !== token) return { ok: false, reason: 'interrupted' };
    // Left on the last answer rather than cleared. A panel keeps its last answer between turns
    // by design, so clearing here would end the demo in a state the product never shows.
    return { ok: true };
  } finally {
    clearInterval(keepAlive);
    markDone(null);
  }
}
