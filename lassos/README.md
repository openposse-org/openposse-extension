# Lassos

Each file is one vendor's recorded selectors, stored as the shared file Settings imports and
writes (`pack` in `src/share.js`). Copy one from GitHub and paste it into Settings as it is.
**Every value here was captured from a live page with `tools/capture.js` – nothing is guessed**,
which is the rule that keeps selector literals out of extension source. M3 replaces this
directory with the recorder's output.

**These files ship with the extension** (owner's call, 2026-10-26). `tools/build.mjs` copies
every `*.json` here into the package as it is and writes `lassos/index.json` listing them. A
first install adds every one to the roster (owner's call, later the same day), through the same
import a pasted file takes, but without access: each waits for Chrome's Allow, from its row in
Settings, Allow all there, or onboarding's last task. An update adds nothing; instead the side
panel offers a lasso on its site while no assistant lives there (`src/builtin.js`). So a file
added here reaches every new user from the next release, and its `name` is what they call the
assistant. A filename must be lowercase letters, digits and hyphens, or the index leaves it out.
`openposse-acme-ai.json`, the website's demo vendor, stays here for the website and is left out
of the package (`NOT_SHIPPED` in `tools/build.mjs`).

The envelope around `lasso` says which lasso it is (`docs/lasso-identity.md`):

| Field | What it is |
|---|---|
| `id` | The lineage, the slug the website gives the product (`notion`, `acme-ai`). The filename is `openposse-<id>.json` |
| `name` | The name the recording suggests for the AI assistant. The importer may pick another |
| `recordedOn` | The day the lasso was recorded |
| `hash` | 12 hex characters of SHA-256 over canonical JSON of `lasso`, from `hashOf`. Importers recompute it and never trust the file's |

**Change a selector and the hash changes with it.** `test/share.test.mjs` unpacks every file
here exactly as Settings would and fails when the stored hash or the layout is not what `pack`
writes, so regenerate the file with `pack` rather than editing the hash by hand. The bare
recording shape stays the extension's own storage and is not used here.

## Andy — LeanIX EA Assistant *(lasso removed 2026-10-01)*

Captured 2026-09-06 against `demo-au.leanix.net`, and the test vendor through E8–E11.

**The lasso file is gone; everything below stays.** Almost none of it is about the file — the
latency measurements, the cold-tab explanation for the original timeout, the state-persistence
trap and the synthetic-trigger result are findings about driving *a* vendor, and the next one
will meet them. LeanIX is also enterprise-only with no self-serve signup, so nobody outside a
customer could have used the lasso anyway.

The recorded values, for reference:

| Field | Value | Why this one |
|---|---|---|
| `inputSelector` | `textarea[name="message"]` | Unique on a `name` attribute, and in the **light DOM** — the page has 100+ shadow roots but the chat panel is not behind one |
| `submitSelector` | `button[aria-label="Submit Message"]` | Unique on its accessible name. A click is preferred over synthetic Enter, which is far more likely to be gated on `isTrusted` |
| `responseContainerSelector` | `lx-agentic-chat-assistant-message` | The custom element wrapping one assistant turn |
| `usesStructuralSelector` | `false` | Nothing fell back to an `nth-of-type` path, so this lasso should survive ordinary CSS churn |
| `triggerMethod` | `synthetic` | **Measured** on a fresh tab — a `isTrusted: false` event opens the assistant. See below |

### The send button lags a freshly opened panel

On a tab where the assistant was already open, `setInputValue` enables the send button
immediately. On a **fresh** tab, where the panel has just been opened by the shortcut, the
button exists but stays `disabled` — the framework has not finished binding to the input, so
the value is set before anything is listening and is silently discarded.

At a single instant that is indistinguishable from the React-setter trap: text in the box, a
dead button. So the runtime waits for the control to *enable* rather than checking once, and
re-applies the value halfway to the deadline in case the first attempt was simply too early.
Only if it never enables does it report the input never registering — a diagnosis now backed
by two attempts three seconds apart rather than one frame.

### The response selector matches many elements, on purpose

LeanIX's chat appends one `lx-agentic-chat-assistant-message` per turn and leaves the earlier
ones on screen. So the selector is **not** unique, and must not be: the runtime counts matches
before submitting and waits for a new one (`waitForNewMatch` in `src/dom.js`), then reads the
last.

Getting this wrong is silent. A plain "find the response container" resolves instantly against
the *previous* answer, and the agent reads the opening reply aloud on every question, forever,
with no error raised anywhere.

### Custom element tags are the stable identifiers here

LeanIX is a web-components app, so the semantic structure lives in tag names
(`lx-agentic-chat-assistant-message`, `lx-agentic-chat-user-message`) rather than in
`data-testid` attributes. A component rename is much rarer than the class and DOM-shape churn
an `nth-of-type` path depends on, so a tag name is the *more* durable choice — the opposite of
the usual advice, and the reason `capture.js` scores custom elements as stable.

### Measured: LeanIX does not stream into the DOM

Three probe runs on 2026-09-06, against a live workspace:

| Reply elements | Deltas | First delta | Total |
|---|---|---|---|
| 6 → 7 | 2 | 7.9s | 8.9s |
| 7 → 8 | 1 | 7.1s | 8.0s |
| 8 → 9 | 1 | 7.7s | 8.6s |

The answer arrives in **one or two mutations**, roughly 7–8 seconds after submission, rather
than token by token. The remaining ~0.9s is our own quiet period closing the turn.

**Consequence: speech cannot start early for this vendor.** The design has speech begin on the
first coherent chunk, and that is still right — it is the whole latency argument
for driving a browser instead of calling an API. It simply does not pay off here, because
there is no partial answer to speak. The user waits for the generation either way.

This is a property of the vendor, not a defect in the lasso or the streaming code. The
`streamResponse` path is unchanged and will stream for a vendor that renders incrementally.
Do not "fix" it by lowering the quiet period.

The reply-element count is what makes this trustworthy. Identical text cannot distinguish a
fresh answer from a re-read of the previous one, so the content script reports how many reply
elements existed before and after; the counts incrementing 6→7→8→9 is what rules out the
runtime silently re-reading an old answer.

### A cold tab costs about twice a warm one — and explains the original timeout

| Tab state | First delta | Total |
|---|---|---|
| Warm — assistant already open | 7.1 – 8.7s | 8.0 – 10.0s |
| **Cold — fresh tab, opened by shortcut** | **13.3s** | **14.8s** |

A cold start adds roughly 5–6s: the shortcut has to open the panel, the framework has to bind
to the composer, and the prompt may be applied twice before the send control enables.

**14.8s against the original 15s ceiling.** That is the whole explanation for "the app timed
out sometimes" — not a flaky vendor, not a network blip, but a limit chosen against a warm-tab
measurement and then met by the cold-start path with ~200 ms to spare. A warm tab passed every
time, which is exactly what made it look intermittent.

The ceiling is now `responseTimeoutMs: 60000`, a lasso field with a debug slider behind it.

### Possible tuning, not yet done

`quietPeriodMs: 900` adds ~0.9s to every answer. Since this vendor delivers in one or two
mutations, a shorter period would likely be safe and would be a visible latency win. Not
changed, because a slower network could split the render into more mutations and a too-short
period would cut the answer off mid-way — which fails silently, as a truncated answer rather
than an error. Measure before touching it.

### The assistant's open state persists per tab — which invalidated a measurement

**Corrected.** An earlier version of this section concluded "LeanIX never needs the shortcut".
That was wrong, and the way it was wrong is worth keeping.

LeanIX persists the assistant's open/closed state per tab across reloads. A **fresh** tab
opens with the assistant closed; a tab where it has ever been opened comes back open, even
after a refresh. Every measurement below was taken on a tab of the second kind, so the
composer was always present — and the conclusion drawn from it ("the input is always
available, so the shortcut is dead code") was an artefact of the test setup, not a property of
the vendor.

The DOM reading itself was accurate, with the assistant apparently "closed":

```json
"textareas": [{ "w": 368, "h": 32, "top": 745,
                "display": "block", "visibility": "visible", "opacity": "1" }],
"buttons":   [{ "w": 32,  "h": 26, "top": 777, "opacity": "0.4" }]
```

The input really was visible — not hidden, not collapsed. But on a tab that had the assistant
open, which is what "closing" it apparently does not undo in the DOM.

**How to test the shortcut, and therefore S1: use a brand-new tab.** That is the only state in
which the composer is genuinely absent, and it is a state a reload cannot reach.

Note the shape of the mistake, because it cost four deploy cycles. Two runs reported
`already-open`, which looked like a broken openness check; a third failed at the send button,
which looked like a timing problem. Each diagnosis was plausible, each produced a fix that
changed real behaviour, and none addressed the cause — the tab was in a state I had not
thought to ask about. Reading the DOM directly was the fourth step and should have been the
first; asking the user how the vendor's UI actually behaves should have been the zeroth.

The visibility work those cycles produced is still correct and worth keeping — presence is not
openness for a vendor that hides a mounted panel, and `waitForElement` observing only
`childList` would miss a panel opened by a class change — but none of it was the problem here.

### The assistant holds several conversations, one rendered at a time

LeanIX's EA Assistant keeps a list of chats with a history control, much like Claude's own.
Only the selected conversation is in the DOM.

What this does **not** break: `lx-agentic-chat-assistant-message` matches within the rendered
conversation only, and `repliesBefore`/`repliesAfter` are counted around a single exchange, so
the newest-match logic stays correct regardless of how much history exists.

Three consequences that are real, and one open question.

- **Andy appends to whichever conversation is on screen.** He does not start a fresh one. So a
  spoken question lands in the user's currently selected chat, inheriting its context — which
  is sometimes exactly right and sometimes surprising.
- **Switching conversations mid-answer detaches the observed container.** `streamResponse`
  then sees no further mutations, the quiet period elapses, and the partial text is returned.
  That degrades rather than corrupts, but the answer will be truncated with no error.
- **`get_last_response` reads the rendered conversation.** After a switch, "say that again"
  reads a different chat's last answer than the one Andy just produced.

**Decided 2026-09-06: continue the current conversation. Never start a new one.**

This is what the code already did, and it is now deliberate rather than incidental. It also
falls out of a decision already in the record — P7's *"floor held, transcript fresh"*, which
puts OpenPosse's routing state and the vendor's conversation in different places on purpose:
routing needs the utterance and the roster, while **the real conversation lives in the
vendor's thread**. Starting a fresh chat per session would move conversational memory into
OpenPosse, which is exactly what that decision declines to do.

Practical effect: a follow-up still reaches Andy with full context even after OpenPosse's own
floor timeout has expired, because LeanIX never forgot. The floor governs *who gets asked*,
not *what they remember*.

Consequences accepted with it:

- Andy answers inside whatever chat is on screen, inheriting its context — including a
  deep-dive left open days ago.
- A long-running conversation grows without bound. If a vendor degrades or drifts on very long
  threads, the remedy is the user starting a new chat themselves, not OpenPosse doing it for
  them.
- No "new chat" selector is needed in the lasso, so the format is unchanged.

### `triggerMethod: synthetic` is now MEASURED — S1 is closed for this vendor

Settled 2026-09-06 on a fresh LeanIX tab, which is the only state where the composer is
genuinely absent:

```
shortcut route: synthetic
```

A JS-dispatched `KeyboardEvent` carrying ⌘⇧K, marked `isTrusted: false` by the browser,
**opened the EA Assistant**. So the cheap path works here and `CGEventPost` is not needed —
which also means the app's Accessibility permission is not required to drive Andy.

This is per-vendor evidence, not a general result. Another vendor may still reject untrusted
events on a security-sensitive shortcut, silently and with no error to catch, which is exactly
why `Lasso.triggerMethod` is recorded per lasso rather than assumed globally. The
`CGEventPost` fallback stays built and stays unexercised.

Note what made this measurable: the state persistence above. Three earlier attempts ran on
tabs that had the assistant open and reported `already-open`, testing nothing.
