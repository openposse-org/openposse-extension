// Turning "Ivan tell me a joke" into an agent and a question.
//
// Layers 1 and 2 of the plan's three. Layer 1 – biasing the recogniser with `phrases` – happens
// before this file sees anything, in `listening.js`. Layer 2 is this file: the name by spelling,
// then by sound. Layer 3 was to be E7 – an on-device model choosing with a constrained schema –
// and was **not built, by decision (2026-10-13)**: Gemini Nano is blocked by enterprise policy
// on most of the machines this is for, a model of our own would be a second download the size
// of Kokoro, and what layer 3 was for – a name heard wrong – is what matching by sound catches.
// Revisit only if real routing failures turn up that no matcher could fix.
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

const VOWELS = /[aeiou]/;
const FRONT_VOWELS = /[iey]/;

/**
 * Roughly how a word sounds, as a key on which "Andy", "Andie" and "Andi" agree.
 *
 * A trimmed Metaphone: silent letters dropped, consonants that sound alike merged (c/k/q, s/z,
 * v/f, "ph" as F, "sh" and "tio" as X, "th" as 0), vowels dropped except a leading one, which
 * becomes A – so "Ivan" and "Evan" both read AFN. English spelling rules only, which is what the
 * recogniser writes in; a word with letters outside a–z after accents are stripped has no key,
 * and so is matched by spelling alone.
 */
function wordKey(raw) {
  let w = raw.normalize('NFD').replace(/\p{M}/gu, '').replace(/'/g, '');
  if (!/^[a-z]+$/.test(w)) return null;
  if (/^(kn|gn|pn|wr|ae)/.test(w)) w = w.slice(1);
  else if (w.startsWith('x')) w = `s${w.slice(1)}`;
  else if (w.startsWith('wh')) w = `w${w.slice(2)}`;

  let key = '';
  for (let i = 0; i < w.length; i += 1) {
    const c = w[i];
    const prev = w[i - 1] ?? '';
    const next = w[i + 1] ?? '';
    const after = w[i + 2] ?? '';
    if (c === prev && c !== 'c') continue;                 // a doubled letter sounds once
    if (VOWELS.test(c)) {
      if (i === 0) key += 'A';
      continue;
    }
    switch (c) {
      case 'b': if (!(prev === 'm' && !next)) key += 'B'; break;           // "lamb"
      case 'c':
        if (prev === 's' && next === 'h') key += 'K';                      // "school"
        else if (next === 'h' || (next === 'i' && after === 'a')) key += 'X';
        else if (FRONT_VOWELS.test(next)) key += 'S';
        else key += 'K';
        break;
      case 'd': key += next === 'g' && FRONT_VOWELS.test(after) ? 'J' : 'T'; break;
      case 'g':
        if (next === 'h' && !VOWELS.test(after)) break;                    // "night", "hugh"
        if (next === 'n' && !after) break;                                 // "sign"
        key += FRONT_VOWELS.test(next) ? 'J' : 'K';
        break;
      case 'h':
        if (/[cgpst]/.test(prev)) break;                                   // spoken by the pair
        if (VOWELS.test(prev) && !VOWELS.test(next)) break;                // "john"
        key += 'H';
        break;
      case 'k': if (prev !== 'c') key += 'K'; break;
      case 'p': key += next === 'h' ? 'F' : 'P'; break;
      case 'q': key += 'K'; break;
      case 's': key += next === 'h' || (next === 'i' && /[ao]/.test(after)) ? 'X' : 'S'; break;
      case 't':
        if (next === 'i' && /[ao]/.test(after)) key += 'X';
        else if (next === 'h') key += '0';
        else if (!(next === 'c' && after === 'h')) key += 'T';             // "watch"
        break;
      case 'v': key += 'F'; break;
      case 'w': case 'y': if (VOWELS.test(next)) key += c.toUpperCase(); break;
      case 'x': key += 'KS'; break;
      case 'z': key += 'S'; break;
      default: key += c.toUpperCase();                                     // f j l m n r
    }
  }
  return key;
}

/** The sound key of a whole fragment, word by word, or null if any word has none. */
export function soundKey(text) {
  const words = normalise(text).split(' ').filter(Boolean);
  if (words.length === 0) return null;
  const keys = words.map(wordKey);
  return keys.includes(null) ? null : keys.join(' ');
}

/**
 * Whether a fragment sounds like a name, under two guards that keep this a catch rather than a
 * lottery.
 *
 * **Word for word.** "I've an" sounds like "Ivan" run together – and is how a great many
 * sentences begin. Comparing only fragments with as many words as the name gives that up, along
 * with "eye van", and is worth it: a wrong agent reaches a vendor, a missed one asks again.
 *
 * **Three sounds at least.** A key of one or two – "Kai" is K, "Ava" is AF – is shared by too
 * many ordinary words to be evidence of anything.
 */
function soundsAlike(fragment, name) {
  if (fragment.split(' ').length !== name.split(' ').length) return false;
  const heard = soundKey(fragment);
  return heard !== null && heard.replace(/ /g, '').length >= 3 && heard === soundKey(name);
}

/**
 * The best roster match for a spoken fragment, or null.
 *
 * By spelling – within `tolerance` – or by sound, which catches what spelling cannot:
 * "Andie" is two letters from "Andy", "Preeya" two from "Priya", and both sound the same. A
 * match by sound carries its spelling distance, so a closer spelling still wins and two
 * equally distant candidates are still refused.
 *
 * **Ambiguity is a refusal, not a coin toss.** If two agents are equally close – "Andy" and
 * "Sandy" both one letter from "andi" – there is no evidence to choose between them, and
 * picking one would be inventing the thing the user is relying on us to get right.
 */
export function bestMatch(fragment, agents) {
  if (!fragment) return null;

  // An ordinary English word may match a name exactly, never approximately – by spelling or by
  // sound: "even" sounds exactly like "Ivan". See COMMON_WORDS.
  const exactOnly = COMMON_WORDS.has(fragment);

  const scored = agents
    .map((agent) => {
      const name = normalise(agent.name);
      return { agent, name, distance: editDistance(fragment, name) };
    })
    .filter(({ name, distance }) => {
      if (distance === 0) return true;
      if (exactOnly) return false;
      return distance <= tolerance(name) || soundsAlike(fragment, name);
    })
    .map(({ agent, distance }) => ({ agent, distance }))
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

// ── The reply to "would you like to see it?" ──────────────────────────────────────────────
//
// A long answer on a spoken turn ends by offering to show the rest, and the microphone opens
// once for the reply. "Show me" and "take me to Notion" need nothing here – they are navigation
// already. What is new is a bare yes or no, which only mean something because a question was
// just asked. Anywhere else, "yes" is a follow-up for whoever holds the floor.

/** Words that accept on their own, and that may open a longer reply – "yes, show me". */
const ACCEPTS = [
  'yes please', 'yes', 'yeah', 'yep', 'yup', 'sure', 'okay', 'ok', 'please',
  'go on', 'go ahead', 'do it', 'definitely', 'absolutely', 'of course',
];

/** Replies that turn the offer down. The whole utterance has to be one of these. */
const DECLINES = new Set([
  'no', 'nope', 'nah', 'not now', 'not really', 'no need', 'maybe later', 'later',
  'never mind', 'nevermind', "that's fine", "that's ok", "that's okay", "i'm good", "i'm ok",
  "i'm fine", 'all good',
]);

/** Said after either, and meaning nothing for which one it was. */
const COURTESY = /\s+(please|thanks|thank you)$/;

/**
 * Reads a reply to the offer.
 *
 * **Accepting follows the same exhaustion rule as navigation.** After the yes, either nothing is
 * left or what is left has to be navigation – "yes, take me to Notion". "Yes, and what about Q3"
 * is a question that happens to start with yes, and it returns null so it is asked as one.
 *
 * @returns `{ accept }` holding what `navigationTarget` would give, `{ decline: true }`, or null
 *   when the reply is neither and should be handled as an ordinary utterance
 */
export function replyToOffer(utterance, agents, { floorHolder = null } = {}) {
  let text = normalise(utterance).replace(COURTESY, '');
  if (!text) return null;
  if (DECLINES.has(text)) return { decline: true };

  // Repeatedly, because people stack them: "yeah sure", "ok yes please".
  let accepted = false;
  for (;;) {
    const word = ACCEPTS.find((w) => text === w || text.startsWith(`${w} `));
    if (!word) break;
    text = text.slice(word.length).trim();
    accepted = true;
  }
  if (!accepted) return null;

  if (!text) return { accept: floorHolder ? { agent: floorHolder } : { problem: 'nothing-to-show' } };
  const nav = navigationTarget(text, agents, { floorHolder });
  return nav ? { accept: nav } : null;
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

/**
 * A typed question with the agent's name taken off the front, the way `route` takes it off a
 * spoken one: "Matt, what is on this to-do list?" is asked as "what is on this to-do list?".
 *
 * **Typing does not go through `route`**, because the text box is already pointed at an agent –
 * so until 2026-10-24 nothing looked at how a typed sentence began, and people type the way they
 * speak. The vendor was asked "Matt, what is on this to-do list?" and saw a name it has never
 * heard of.
 *
 * Kept apart from `route` for two reasons:
 *
 * - **The rest of the sentence is returned as typed.** `route` hands back normalised words,
 *   which is harmless for a recogniser's output and wrong for someone's own writing: "to-do"
 *   would reach the vendor as "to do" and the question mark would go.
 * - **Exact names only.** Fuzzy matching is a guess that a recogniser misheard, and nothing
 *   mishears a keyboard. A typo leaves a name in the question; a fuzzy guess could take a real
 *   word out of it.
 *
 * Only the target's own name is taken off. A sentence addressed to a *different* agent is left as
 * it is, so the box sends where it says it sends, and the longest roster name is matched first so
 * "Data Team, …" is not cut to "Team, …" for an agent called "Data". A name with nothing after it
 * is left alone too: an empty question is no better than one with a name in it.
 *
 * @param text   what was typed
 * @param agent  the agent the box is pointed at
 * @param agents the roster, for telling a longer name apart from the target's
 */
export function withoutAddress(text, agent, agents = [agent]) {
  const words = normalise(text).split(' ').filter(Boolean);
  const target = normalise(agent?.name);
  if (!target || words.length === 0) return text;
  const names = new Set([target, ...agents.map((a) => normalise(a.name))]);

  for (const skip of [0, 1]) {
    if (skip === 1 && !FILLER.has(words[0])) break;
    for (let take = Math.min(MAX_NAME_WORDS, words.length - skip); take >= 1; take -= 1) {
      const fragment = words.slice(skip, skip + take).join(' ');
      if (!names.has(fragment)) continue;
      if (fragment !== target) return text;
      const rest = afterWords(text, skip + take);
      return rest ? rest : text;
    }
  }
  return text;
}

/**
 * What follows the first `count` words of `text`, as written, minus the punctuation that joined
 * them: "Matt, what…" after one word is "what…". Empty when there is nothing after them.
 *
 * A word here is what `normalise` keeps – a run of letters, digits and apostrophes – so the
 * count lines up with its output word for word.
 */
function afterWords(text, count) {
  const word = /[\p{L}\p{N}']+/gu;
  let end = 0;
  for (let i = 0; i < count; i += 1) {
    if (!word.exec(text)) return '';
    end = word.lastIndex;
  }
  // Only what can sit between a name and a sentence, so a question that opens with a quotation
  // mark or a bracket keeps it. The dashes are a hyphen, an en-dash and an em-dash.
  return text.slice(end).replace(/^[\s,.:;!?\-–—]+/u, '');
}
