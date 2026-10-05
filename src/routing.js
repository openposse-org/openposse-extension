// Turning "Ivan tell me a joke" into an agent and a question.
//
// Layers 1 and 2 of the plan's three. Layer 1 – biasing the recogniser with `phrases` – happens
// before this file sees anything, in `listening.js`. Layer 3 – the Prompt API deciding with a
// constrained schema – is E7, and is an *enhancement*: Gemini Nano needs 22 GB of disk and a
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
 * Lives here, with the routing policy it belongs to, because **two surfaces enforce it** – the
 * worker deciding where an utterance goes, and the popup deciding which agent to light. A ring
 * that outlives the floor is a lie about where the next question would land, and two copies of
 * a timeout drift.
 */
export const FLOOR_MS = 90_000;

/**
 * Where the panel's debug tools keep an override of `FLOOR_MS`, and the range they offer.
 *
 * It is still a guess, and this is what lets it be tuned the way the Mac app's slider did. The
 * range is that slider's, unchanged: 15 s is too short to read an answer, 300 s is long enough
 * that a follow-up after a coffee would reach a vendor.
 *
 * **In `chrome.storage.session`, so it dies with the browser.** A debug value nobody remembers
 * setting would otherwise change where name-less questions go for weeks, with nothing on screen
 * once the debug drawer is shut. Session storage puts a ceiling on how long that can last.
 */
export const FLOOR_OVERRIDE_KEY = 'floorOverrideMs';
export const FLOOR_RANGE = { min: 15_000, max: 300_000, step: 15_000 };

/**
 * The floor window in force: a stored override when it is a usable number, else `FLOOR_MS`.
 *
 * Every reader goes through this rather than comparing against `FLOOR_MS`, because three places
 * enforce the window – the worker routing, the panel and the popup lighting a ring – and one of
 * them honouring the override while another ignored it would light a ring on an agent the next
 * question would not reach.
 */
export function floorWindow(override) {
  // The range check also catches empty: `Number(null)` and `Number('')` are 0, which is finite.
  const ms = Number(override);
  return Number.isFinite(ms) && ms >= FLOOR_RANGE.min && ms <= FLOOR_RANGE.max ? ms : FLOOR_MS;
}

/**
 * Ordinary English words, which may match a name **exactly** but never approximately.
 *
 * This exists because of a real failure, caught by the test below rather than by a person being
 * answered by the wrong assistant: `editDistance('and', 'Andy')` is 1, comfortably inside
 * tolerance, so **"and what about last quarter" routed to Andy** – the plan's own example of a
 * name-less follow-up, sent to an agent nobody addressed.
 *
 * The principle is general. A fuzzy match is a guess that the recogniser misheard something,
 * and that guess is only defensible when what it heard is *not already a perfectly good word*.
 * "Ivar" is not English and is almost certainly a mangled "Ivan"; "and" is English and was
 * almost certainly heard correctly. Weighted toward words that begin a sentence, because only
 * the prefix is ever tested.
 *
 * Exact matches are unaffected, so naming an agent "Andy" still works – it is only the
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
 * Punctuation goes because a recogniser's commas are its own invention – "Ivan, tell me" and
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
 * **Ambiguity is a refusal, not a coin toss.** If two agents are equally close – "Andy" and
 * "Sandy" both one letter from "andi" – there is no evidence to choose between them, and
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

// ── Navigation (E3b) ──────────────────────────────────────────────────────────────────────
//
// Asking an agent something does **not** switch to its tab – the content script drives a
// background tab perfectly well, so switching would only pull someone away from what they were
// doing. Navigation is therefore something you ask for, and this is where asking is recognised.

/** Utterances that mean "show me the thing we were just talking about", and nothing else. */
const BARE_NAVIGATION = new Set([
  'show me', 'show me that', 'show it', 'show that', 'show it to me', 'show me it',
  'open it', 'open that', 'take me there', 'take me to it', 'let me see', 'let me see it',
  'go there', 'jump to it', 'back to it',
]);

/** Openings that mean "show me X", where X has to name something we know. */
const NAVIGATION_PREFIXES = [
  'take me back to', 'take me to', 'switch back to', 'switch to',
  'go back to', 'go to', 'jump to', 'show me', 'open up', 'open',
];

/**
 * The vendor's name as a person would say it, derived from the recipe's domain.
 *
 * Nobody says "take me to Ivan" – they say "Notion". The agent's name and its vendor are
 * different strings and only the agent's is in the roster, so the other one has to come from
 * the domain the recorder already captured. Same job `BrowserTab.productInitial` did on the
 * Mac side.
 *
 * Generic subdomains are dropped, because `app.leanix.net` is "LeanIX" and never "app".
 */
const GENERIC_SUBDOMAINS = new Set(['www', 'app', 'chat', 'my', 'portal', 'web', 'console']);

export function productName(domainPattern) {
  const labels = String(domainPattern ?? '')
    .replace(/^\*\./, '')
    .split('.')
    .filter(Boolean);
  while (labels.length > 1 && GENERIC_SUBDOMAINS.has(labels[0])) labels.shift();
  return labels[0] ?? '';
}

/**
 * A product name as a person reads it, or hears it: `notion` becomes `Notion`.
 *
 * **Separate from `productName`, which stays lowercase.** That one exists for matching – "take
 * me to Notion" is normalised before it is compared – so lowercase is correct there and wrong
 * the moment the same string is shown or said out loud. Everything that puts a vendor in front
 * of a person goes through this one, so they cannot disagree about how it is written.
 *
 * The first letter, unless the brand is in `BRAND_CASING`. A domain label carries no inner
 * capitals, and guessing them would be wrong more often than not – so they are written down for
 * the brands that have them, and only those.
 */
export function productLabel(domainPattern) {
  const name = productName(domainPattern);
  if (!name) return '';
  return BRAND_CASING.get(name) ?? name[0].toUpperCase() + name.slice(1);
}

/**
 * Brands whose capitals are not just the first letter, keyed by `productName`'s lowercase form.
 *
 * **Display only, and not a vendor list.** A vendor missing from here still works everywhere and
 * reads with its first letter capitalised, so an entry is a courtesy to a brand's spelling rather
 * than support for it – adding a vendor never requires one.
 *
 * A `Map`, not an object literal: `productName('constructor.io')` is `constructor`, and on a plain
 * object that key finds `Object.prototype.constructor` – a function, printed as the vendor's name.
 */
const BRAND_CASING = new Map([
  ['leanix', 'LeanIX'],
  ['openai', 'OpenAI'],
]);

/** Matches a fragment against what an agent can be called: its name, or its vendor's. */
function matchTarget(fragment, agents) {
  const labelled = agents.flatMap((agent) => {
    const labels = [agent.name];
    if (agent.product) labels.push(agent.product);
    return labels.map((label) => ({ id: agent.id, name: label, agent }));
  });
  const hit = bestMatch(fragment, labelled);
  return hit ? hit.agent.agent : null;
}

/**
 * Whether this utterance is asking to be taken somewhere, and where.
 *
 * Returns `null` when it is **not** navigation, so the caller falls through to `route` and
 * treats it as a question. That default is load-bearing.
 *
 * **The rule is exhaustion**: an opening like "show me" counts only when it, plus something
 * that names an agent, consumes the *whole* utterance. "Show me" is navigation; "show me the
 * Q3 numbers" is a question. Getting this wrong does not merely misfire – it **eats the
 * question** and switches tabs instead, so the speaker watches their request vanish with no
 * error anywhere. Anything left over therefore means question, every time.
 *
 * @returns `{ agent }`, `{ problem }`, or `null` for "this is not navigation"
 */
export function navigationTarget(utterance, agents, { floorHolder = null } = {}) {
  const text = normalise(utterance);
  if (!text || !agents || agents.length === 0) return null;

  // "show me" on its own – whatever we were just talking about.
  if (BARE_NAVIGATION.has(text)) {
    return floorHolder ? { agent: floorHolder } : { problem: 'nothing-to-show' };
  }

  // Longest prefix first, so "take me back to" is not consumed by "take me to".
  for (const prefix of NAVIGATION_PREFIXES) {
    if (text !== prefix && !text.startsWith(`${prefix} `)) continue;

    const rest = text.slice(prefix.length).trim().replace(/^(the|my)\s+/, '');
    if (!rest) {
      // "open" alone is not a request to go anywhere; "take me to" alone is.
      return BARE_NAVIGATION.has(prefix) || prefix.includes('me')
        ? (floorHolder ? { agent: floorHolder } : { problem: 'nothing-to-show' })
        : null;
    }

    const agent = matchTarget(rest, agents);
    // Nothing left over and it named someone: navigation. Anything else is a question, and
    // this `null` is what stops "show me the Q3 numbers" being swallowed.
    if (agent) return { agent };
    return null;
  }

  return null;
}

/**
 * Decides who an utterance is for.
 *
 * **The name must come first.** Checking the end of the sentence as well would catch "tell me a
 * joke, Ivan", and would also route "tell me about Andy" to Andy with the prompt "tell me
 * about" – a sentence that mentions an agent is not a sentence addressed to one, and no amount
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

  // No name, so this is a follow-up – "and what about last quarter?" – and belongs to whoever
  // last answered. The 90-second expiry is applied by the caller; a stale floor is no floor.
  if (floorHolder) return { agent: floorHolder, prompt: text, matched: 'floor' };

  return { problem: 'unknown-agent' };
}
