// Turning "Ivan tell me a joke" into an agent and a question.
//
// Layers 1 and 2 of the plan's three. Layer 1 — biasing the recogniser with `phrases` — happens
// before this file sees anything, in `listening.js`. Layer 3 — the Prompt API deciding with a
// constrained schema — is E7, and is an *enhancement*: Gemini Nano needs 22 GB of disk and a
// 4 GB GPU, so most machines will never run it and this file is what they get. It has to be
// good enough on its own.
//
// Pure functions, no `chrome.*`, so it runs under `node --test`. That is the point: routing is
// the one part of the voice loop whose failures are entirely about strings, and strings can be
// tested without a microphone, a browser or a person saying "Ivan" forty times.

/**
 * Words people put in front of a name without meaning anything by them.
 *
 * Skipped only *after* a direct match fails, so an agent genuinely called "Hey" still wins on
 * its own name.
 */
const FILLER = new Set(['hey', 'hi', 'hello', 'ok', 'okay', 'yo', 'um', 'uh', 'so', 'right']);

/** Longest agent name we will look for, in words. Beyond this a name is a sentence. */
const MAX_NAME_WORDS = 3;

/**
 * How long a name-less follow-up still belongs to whoever last answered.
 *
 * Ported unchanged from `ListeningController`. The number is a guess about conversation rather
 * than about software: long enough to read an answer and think of the obvious next question,
 * short enough that coming back from lunch and saying "what about Tuesday" does not reach a
 * vendor.
 *
 * Lives here, with the routing policy it belongs to, because **two surfaces enforce it** — the
 * worker deciding where an utterance goes, and the popup deciding which agent to light. A ring
 * that outlives the floor is a lie about where the next question would land, and two copies of
 * a timeout drift.
 */
export const FLOOR_MS = 90_000;

/**
 * Ordinary English words, which may match a name **exactly** but never approximately.
 *
 * This exists because of a real failure, caught by the test below rather than by a person being
 * answered by the wrong assistant: `editDistance('and', 'Andy')` is 1, comfortably inside
 * tolerance, so **"and what about last quarter" routed to Andy** — the plan's own example of a
 * name-less follow-up, sent to an agent nobody addressed.
 *
 * The principle is general. A fuzzy match is a guess that the recogniser misheard something,
 * and that guess is only defensible when what it heard is *not already a perfectly good word*.
 * "Ivar" is not English and is almost certainly a mangled "Ivan"; "and" is English and was
 * almost certainly heard correctly. Weighted toward words that begin a sentence, because only
 * the prefix is ever tested.
 *
 * Exact matches are unaffected, so naming an agent "Andy" still works — it is only the
 * approximate leap that this refuses.
 */
const COMMON_WORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'ask', 'at',
  'back', 'be', 'been', 'but', 'by', 'can', 'could', 'did', 'do', 'does', 'done', 'down',
  'each', 'even', 'find', 'first', 'for', 'from', 'get', 'give', 'go', 'good', 'had', 'has',
  'have', 'he', 'her', 'here', 'him', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it',
  'its', 'just', 'know', 'last', 'let', 'like', 'look', 'make', 'many', 'may', 'me', 'more',
  'most', 'much', 'my', 'need', 'new', 'next', 'no', 'not', 'now', 'of', 'on', 'one', 'only',
  'or', 'other', 'our', 'out', 'over', 'put', 'say', 'see', 'send', 'set', 'she', 'should',
  'show', 'some', 'take', 'tell', 'than', 'that', 'the', 'their', 'them', 'then', 'there',
  'these', 'they', 'thing', 'think', 'this', 'those', 'time', 'to', 'told', 'too', 'try',
  'two', 'up', 'us', 'use', 'very', 'want', 'was', 'way', 'we', 'well', 'were', 'what',
  'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with', 'work', 'would', 'yes',
  'you', 'your',
]);

/**
 * Lowercases, drops punctuation, collapses whitespace.
 *
 * Punctuation goes because a recogniser's commas are its own invention — "Ivan, tell me" and
 * "Ivan tell me" are the same utterance and must not route differently. Apostrophes stay, so
 * "O'Brien" survives as one word.
 */
export function normalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Levenshtein distance, iterative, two rows. Names are short; this is never hot. */
export function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * How wrong a name may be heard and still count.
 *
 * Scaled to length, because one letter is a much larger share of "Andy" than of "Priyanka".
 * Deliberately conservative: a wrong agent asked a real question is worse than being asked to
 * repeat yourself, since it reaches a vendor and puts words in front of someone.
 */
function tolerance(name) {
  if (name.length <= 3) return 0;
  if (name.length <= 5) return 1;
  return 2;
}

/**
 * The best roster match for a spoken fragment, or null.
 *
 * **Ambiguity is a refusal, not a coin toss.** If two agents are equally close — "Andy" and
 * "Sandy" both one letter from "andi" — there is no evidence to choose between them, and
 * picking one would be inventing the thing the user is relying on us to get right.
 */
export function bestMatch(fragment, agents) {
  if (!fragment) return null;

  // An ordinary English word may match a name exactly, never approximately. See COMMON_WORDS.
  const exactOnly = COMMON_WORDS.has(fragment);

  const scored = agents
    .map((agent) => ({ agent, distance: editDistance(fragment, normalise(agent.name)) }))
    .filter(({ agent, distance }) => (exactOnly
      ? distance === 0
      : distance <= tolerance(normalise(agent.name))))
    .sort((a, b) => a.distance - b.distance);

  if (scored.length === 0) return null;
  if (scored.length > 1 && scored[0].distance === scored[1].distance) return null;
  return scored[0];
}

/**
 * Decides who an utterance is for.
 *
 * **The name must come first.** Checking the end of the sentence as well would catch "tell me a
 * joke, Ivan", and would also route "tell me about Andy" to Andy with the prompt "tell me
 * about" — a sentence that mentions an agent is not a sentence addressed to one, and no amount
 * of string handling can tell those apart. Prefix only, and the floor holder covers the rest.
 *
 * @param utterance  what was heard
 * @param agents     the roster
 * @param floorHolder the agent who last answered, or null if nobody holds the floor
 * @returns `{ agent, prompt, matched }` or `{ problem }`
 */
export function route(utterance, agents, { floorHolder = null } = {}) {
  const text = normalise(utterance);
  if (!text) return { problem: 'heard-nothing' };
  if (!agents || agents.length === 0) return { problem: 'no-agents' };

  const words = text.split(' ');

  // Longest first, so a "Data Team" is not beaten to it by an agent called "Data".
  for (const skip of [0, 1]) {
    if (skip === 1 && !FILLER.has(words[0])) break;
    for (let take = Math.min(MAX_NAME_WORDS, words.length - skip); take >= 1; take -= 1) {
      const fragment = words.slice(skip, skip + take).join(' ');
      const hit = bestMatch(fragment, agents);
      if (!hit) continue;

      const prompt = words.slice(skip + take).join(' ').trim();
      // A name on its own is an address, not a request. Worth distinguishing: it is what
      // someone says when they start talking before they have decided what to ask, and the
      // useful reply is "yes?" rather than sending an empty prompt to a vendor.
      if (!prompt) return { problem: 'name-only', agent: hit.agent };
      return { agent: hit.agent, prompt, matched: hit.distance === 0 ? 'name' : 'fuzzy' };
    }
  }

  // No name, so this is a follow-up — "and what about last quarter?" — and belongs to whoever
  // last answered. The 90-second expiry is applied by the caller; a stale floor is no floor.
  if (floorHolder) return { agent: floorHolder, prompt: text, matched: 'floor' };

  return { problem: 'unknown-agent' };
}
