// What has been captured so far, and everything still wrong with it.
//
// Ported from `Sources/OpenPosseShared/RecipeDraft.swift`, which is pure and already tested –
// so this is a transcription rather than a redesign, and the reasoning in its comments is the
// reasoning here.
//
// The recorder in `recorder.js` emits events; this folds them into a draft and says what is
// missing. It is deliberately free of any UI: `coaching.js` decides what to *say* about a
// draft, and the orb decides how to draw it. This part is the one with rules in it, which is
// the part worth testing.

/** The completion heuristic's plausible range. Outside it, the recording is suspect. */
const QUIET_PERIOD_MS = { min: 300, max: 3000 };

/**
 * Must comfortably exceed the vendor's measured thinking time.
 *
 * M2 shipped 15 s against a vendor measured at 7–8 s, and the cold path met it with ~200 ms to
 * spare – reported as `TIMEOUT` while the assistant was still working, which is
 * indistinguishable from a broken agent.
 */
const MIN_RESPONSE_TIMEOUT_MS = 30_000;

/** A selector we could actually use. */
const usable = (selector) => typeof selector?.css === 'string' && selector.css.trim() !== '';

/**
 * Whether the recorded answer location names **one reply** rather than the whole transcript.
 *
 * The counts exist because of a mistake in `docs/recording-flow.md` step 5, which said to
 * record "the container that received new child nodes". That container is one element and
 * stays one element forever, while the runtime waits for the match *count* to grow.
 */
const perReply = (reply) => (reply?.matchesAfter ?? 0) > (reply?.matchesBefore ?? 0);

/** A fresh draft for a page the user picked. */
export function newDraft(domainPattern) {
  return {
    domainPattern,
    openMethod: null,
    shortcut: null,
    openSelector: null,
    input: null,
    submitMethod: null,
    submitSelector: null,
    reply: null,
    repliesSeen: 0,
    noCommonReplySelector: false,
    abandonedMidCapture: false,
    unrecognised: [],
    quietPeriodMs: 900,
    responseTimeoutMs: 60_000,
  };
}

/**
 * Folds one capture into the draft, returning a new one.
 *
 * **Later captures of the same kind overwrite earlier ones**, and that is not laxity. A user
 * who presses the wrong shortcut, or clicks in the wrong box, will simply do it again, and the
 * last thing they did is the thing they meant. Refusing the correction would force them to
 * restart the wizard over a typo.
 */
export function applyCapture(draft, event) {
  const next = { ...draft };

  switch (event?.kind) {
    case 'armed':
      break;

    case 'open':
      next.openMethod = event.openMethod ?? null;
      // **Cleared, not left stale.** Someone who first tried a shortcut and then opened it by
      // clicking must not leave a recipe claiming both, where the runtime would send a key
      // combination that does nothing and then report that the assistant never opened.
      next.shortcut = event.openMethod === 'shortcut' ? (event.shortcut ?? null) : null;
      next.openSelector = event.openMethod === 'click' ? (event.selector ?? null) : null;
      break;

    case 'input':
      next.input = event.selector ?? null;
      break;

    case 'submit':
      next.submitMethod = event.submitMethod ?? null;
      // Cleared for the same reason: switching from a button to Enter must not leave the
      // previous button's selector behind, or the recipe claims a submit path never recorded.
      next.submitSelector = event.submitMethod === 'click' ? (event.selector ?? null) : null;
      break;

    case 'reply':
      next.reply = event.reply ?? null;
      // **The ceiling comes from what the vendor actually did.** This is the one number M2 got
      // wrong by guessing, and a recording is the only moment we ever watch a vendor answer at
      // its own pace.
      if (event.reply?.suggestedResponseTimeoutMs) {
        next.responseTimeoutMs = event.reply.suggestedResponseTimeoutMs;
      }
      break;

    case 'reply_pending':
      // An answer arrived but the recorder cannot yet name *where* answers appear – that needs
      // two. Tracked rather than folded in, so the wizard can ask for one more question
      // instead of looking like it stopped noticing.
      next.repliesSeen = event.repliesSoFar ?? (draft.repliesSeen + 1);
      next.noCommonReplySelector = event.noCommonSelector === true;
      break;

    case 'navigated_away':
      next.abandonedMidCapture = true;
      break;

    default:
      // **Unknown kinds are recorded, not dropped.** The extension and this module version
      // independently, so an unfamiliar event is a routine condition rather than a corrupt
      // message – but silence would mean the capture stream is quietly one element shorter and
      // the checklist simply stops advancing, which a person reads as "I failed to press
      // something". Keeping the name lets the wizard say what it did not understand.
      if (event?.kind) next.unrecognised = [...draft.unrecognised, event.kind];
      break;
  }

  return next;
}

/**
 * Everything wrong with the draft, in the order a person would fix it.
 *
 * Plain-language messages, because these are shown in the wizard: "AI for the rest of us" means
 * whoever records an agent never sees the word "selector" unless they went looking for it.
 */
export function problems(draft) {
  const found = [];
  const add = (id, message) => found.push({ id, message });

  if (draft.abandonedMidCapture) {
    add('navigated-away', 'The page changed while we were watching. Let’s start that part again.');
  }

  // `*.co.uk` is the failure this guards. `domain.js` refuses to wildcard a public suffix, but
  // a draft can also arrive from an older recorder or be built by hand.
  if (!draft.domainPattern || draft.domainPattern === '*.') {
    add('domain-unusable', 'We can’t work with this page’s address.');
  }

  if (!draft.openMethod) {
    // **This used to say "open it the way you normally do", and that was wrong in consequence.**
    // The reasoning was sound – nobody should need to know whether their assistant has a
    // shortcut – but it led people to press one, and a recorded shortcut produces an agent that
    // cannot open the assistant: some vendors check `isTrusted` and ignore keystrokes that came
    // from a script. Notion is one, and the failure lands minutes later, at the first real
    // question, reading as a broken agent rather than as a recording that went the wrong way.
    //
    // So the preference is stated, with the reason, and a shortcut is still accepted for the
    // vendors that have no button.
    add('open', 'We didn’t see the assistant open. Open it by clicking its button if it has '
      + 'one – we can’t always press a keyboard shortcut on your behalf.');
  } else if (draft.openMethod === 'shortcut' && !draft.shortcut) {
    add('open-keys', 'We saw a shortcut but couldn’t read the keys. Try pressing it again.');
  } else if (draft.openMethod === 'click' && !usable(draft.openSelector)) {
    add('open-control',
      'We saw you open it by clicking but couldn’t identify the control. Try again.');
  }

  if (!usable(draft.input)) {
    add('input', 'We didn’t see where you type. Click in the assistant’s message box.');
  }

  if (!draft.submitMethod) {
    add('submit', 'We didn’t see how you send a message. Send one the way you normally would.');
  } else if (draft.submitMethod === 'click' && !usable(draft.submitSelector)) {
    add('submit-button',
      'We saw you send with a button but couldn’t identify which one. Try sending again.');
  }

  if (draft.reply) {
    if (!perReply(draft.reply)) {
      add('reply-not-per-reply',
        'We couldn’t tell one answer apart from the next. Ask a second question so we can see '
        + 'where a new answer appears.');
    }
  } else if (draft.noCommonReplySelector) {
    add('replies-share-nothing',
      'We saw two answers but couldn’t find anything they have in common, so we wouldn’t be '
      + 'able to find the next one. This assistant may not be one we can drive yet.');
  } else if (draft.repliesSeen > 0) {
    // **Deliberately not an apology or an error.** From the user's side nothing has gone wrong
    // – they asked a question and got an answer. Asking for a second is the price of telling
    // *that* answer apart from where answers appear, so it reads as the next step.
    add('needs-second-answer',
      'Good – now ask it one more thing, so we can tell where answers appear.');
  } else {
    add('reply', 'We didn’t see an answer come back. Ask it something and wait for the reply.');
  }

  const quiet = draft.quietPeriodMs;
  if (!(quiet >= QUIET_PERIOD_MS.min && quiet <= QUIET_PERIOD_MS.max)) {
    add('quiet-period', 'The reply timing looks wrong. Let’s record the answer again.');
  }
  if (draft.responseTimeoutMs < MIN_RESPONSE_TIMEOUT_MS) {
    add('response-timeout', 'This assistant needs longer to answer than we’ve allowed.');
  }

  return found;
}

/** True when every capture the runtime needs is present and self-consistent. */
export function isComplete(draft) {
  return problems(draft).length === 0;
}

/**
 * The captures still outstanding, in the order they are performed.
 *
 * So the wizard's "waiting for…" row is always the first entry.
 */
export function outstanding(draft) {
  const kinds = [];
  if (!draft.openMethod) kinds.push('open');
  if (!draft.input) kinds.push('input');
  if (!draft.submitMethod) kinds.push('submit');
  if (!draft.reply || !perReply(draft.reply)) kinds.push('reply');
  return kinds;
}

/**
 * Turns a complete draft into the recipe the runtime executes.
 *
 * `triggerMethod` is a parameter rather than a recorded field because **the recorder cannot
 * know it.** It watched a real keypress, which always works. Whether a *synthetic* event opens
 * the same panel is a different question with a different answer per vendor, and the only way
 * to find out is to try – which is the dry run's job.
 *
 * @returns `{ ok: true, recipe }` or `{ ok: false, problems }`
 */
export function finish(draft, { triggerMethod }) {
  const found = problems(draft);
  if (found.length > 0) return { ok: false, problems: found };

  // **Selectors flatten to plain CSS strings here**, and this is the one conversion in the
  // file. A draft holds `selectorFor`'s full result – `{ css, via, isStable, matchCount }`,
  // which is what the wizard's checklist and the two-sample comparison need – while the runtime
  // passes `recipe.inputSelector` straight into `deepQuerySelectorAll`. Handing it the object
  // would stringify to `[object Object]`, match nothing, and report `ELEMENT_NOT_FOUND` on a
  // recipe that had just been recorded and verified.
  const css = (selector) => selector?.css ?? null;

  return {
    ok: true,
    recipe: {
      domainPattern: draft.domainPattern,
      openMethod: draft.openMethod,
      shortcut: draft.shortcut,
      openSelector: css(draft.openSelector),
      inputSelector: css(draft.input),
      submitMethod: draft.submitMethod,
      submitSelector: css(draft.submitSelector),
      responseContainerSelector: css(draft.reply.selector),
      // Already a plain string – it names an element that had left the page when it was
      // captured, so it never went through `selectorFor` and never had a `.css` to unwrap.
      busySelector: draft.reply.busySelector ?? null,
      triggerMethod,
      quietPeriodMs: draft.quietPeriodMs,
      responseTimeoutMs: draft.responseTimeoutMs,
    },
  };
}
