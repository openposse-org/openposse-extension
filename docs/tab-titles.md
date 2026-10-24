# Tab titles during a turn

**Status:** Implemented, 2026-10-15 · **Decided:** the website shows it, the product should do it (2026-10-15) · **Scope:** one small feature, one PR

## 1. Summary

While OpenPosse asks an assistant a question, that assistant's tab is in the background. The
person sees the tab strip, not the page. This spec makes the tab's title say what is happening
in it, the way the hero on openposse.org already shows it:

| In the strip | When |
|---|---|
| `typing… · Q3 plan` | OpenPosse is putting the question into the assistant's box |
| `answering… · Q3 plan` | The question is in and the assistant is producing its answer |
| `done · Q3 plan` | The answer has been read; it stays a short while so the person can see which tab answered |

After that the title is exactly what it was before. Nothing else about the tab changes.

## 2. Why

- **The strip is the only thing in view.** The whole point of OpenPosse is that the assistant's
  tab stays in the background. Today the strip shows no sign that anything is happening there, so
  the only feedback is the panel and the voice. A glance at the strip should be enough.
- **The website promises it.** The hero on openposse.org draws a Chrome window where the
  assistant's tab carries a `typing… / answering… / done` badge through the turn
  (`site/index.html` in `openposse-website`, the `badge` map in `renderVals`). The user chose to
  keep that visual and change the product to match rather than the other way round.
- **It helps the "show me" moment.** When several assistants are open, `done` marks the one that
  just answered, so the person knows where "show me" will land before saying it.

## 3. What the hero shows, exactly

From the page script in `openposse-website/site/index.html`:

- The badge sits after the tab's name, in a small monospace face, only on the tab the turn went
  to. The other tabs never change.
- Phases: panel `thinking` → `typing…`; panel `answering` → `answering…`; `answered` → `done`;
  `routing` and `listening` → no badge.
- The lit tab also gets a full-opacity dot and a thin ring in the assistant's colour. Chrome
  offers no way to ring or recolour a real tab, so that part is a website-only flourish; see §7.

## 4. Behaviour

### 4.1 Which tab

The tab the question goes to and no other: the one `vendorTab(domainPattern)` returns
(`src/tabs.js`). It is the tab "show me" switches to, by construction. No tab is ever created or
focused for this; `test/tabs.test.mjs` keeps failing on anything that would.

### 4.2 States

The real turn has more phases than the hero's badge (`putQuestion` in `src/service-worker.js`:
`thinking` covers both typing the question in and waiting for the answer; `answering` is OpenPosse
reading it aloud). The title describes what the **tab** is doing, so the mapping is to the
content script's own moments, not to the panel's:

| Title | Starts | Ends |
|---|---|---|
| `typing…` | The content script begins putting the prompt into the input (after it has opened the box, if the lasso opens by click or shortcut) | The prompt is submitted |
| `answering…` | Submit | The answer loop reports the response finished (`finished()` seen-then-left, or the settle passes end) |
| `done` | The response is captured and sent back | The first of: the person looks at the tab; the next question goes to the same tab; 90 s. On a tab already in view when the answer arrives, 5 s |
| *(restored)* | Any failure (`result.type !== 'response'`: no box found, timed out, not signed in…) | – |

`typing…` and `answering…` also end by themselves after the lasso's response timeout plus 30 s,
so a turn that was cut off (the extension reloaded mid-answer) cannot leave one in the strip.

A failure restores the title at once. The panel already explains what went wrong; a tab title
saying `couldn't answer` would be a second, less useful place for the same message, and would sit
there after the person had dealt with it.

### 4.3 Form

Prefix, not suffix: Chrome truncates tab titles from the end, and a background tab is narrow, so
`answering… · Q3 plan` keeps the state visible where `Q3 plan – answering…` would lose it. The
separator is ` · ` (space, middle dot, space) and the ellipsis is the single character `…`, as in
the panel's own "is thinking…". Lower case throughout, matching the hero.

The original title is kept verbatim and restored verbatim, including an empty title. Applying a
state twice replaces the prefix rather than stacking it (`answering… · Q3 plan`, never
`answering… · typing… · Q3 plan`).

### 4.4 Pages that set their own title

Web apps rewrite `document.title` themselves: Notion sets it to the page name after navigation,
mail clients add unread counts, some assistants change it while streaming. During the turn the
content script watches the `<title>` element with a `MutationObserver`. When the page writes a
title that is not ours, that becomes the new original and the current state is re-applied on top
of it. The observer stops when the title is restored, so the page gets its own title back and
keeps full control of it afterwards. If the tab navigates during the turn the content script is
gone with the old document and there is nothing to restore: the new document arrives with its own
title.

### 4.5 Where it lives

**The title is written in the top frame, whichever frame asks.** The assistant can sit in an
iframe (Notion has two, which is why `frameOwningAssistant` exists), and an iframe's
`document.title` is not the tab's. So the asking frame reports each moment and the worker passes
it to frame 0.

- **`src/title.js`** (pure, tested): `withState(title, state)` → the prefixed title;
  `original(title)` → the title with one OpenPosse prefix removed; `STATES`, the words in one
  place, matching the website's `badge` map; `DONE_MS`.
- **`src/content.js`**:
  - `askAssistant` reports `typing` just before it puts the question in, and `answering` just
    after it sends it, through its existing stream channel. The recorder's dry run has no
    listener for that channel, so recording changes no titles.
  - The `show_turn_state` intent owns the title in the top frame: the observer in §4.4, the
    ceiling, and, for `done`, restoring on `visibilitychange` to visible. Looking at the tab
    clears it, however that happens: a click, "show me", or raising its window.
  - These are timed in the page because the worker is stopped after about 30 s idle, and an
    extension reload cuts it off from the old script. A title that waited for the worker could
    keep saying `answering…` for good.
- **`src/service-worker.js`**: in `dispatchIntent`, passes each reported state to frame 0
  (`showTurnState`), sends `done` on an answer, and restores on a failure. It never waits for
  any of these, and a failure only logs: a title is never the reason a turn fails.

No new permission: `tabs` and `scripting` are already in the manifest and the content script is
already in the tab for the turn.

### 4.6 Privacy

Nothing leaves the device and nothing is stored. The one new thing a page can observe is its own
`document.title` carrying a word such as `answering…` for a few seconds, from a script the
person has already allowed on that one site. `PRIVACY.md` does not change.

## 5. Not in this spec

- **A coloured dot or ring on the tab.** No Chrome API for it. A favicon overlay (drawing a dot on
  the page's icon) is possible but a different feature with its own questions (the page may swap
  its icon, and `favicons.js` exists for the roster, not for this). If wanted, it is a follow-up.
- **A setting to turn it off.** Ships on, with no toggle. OpenPosse avoids settings it can avoid
  ("AI for the rest of us"), and the title is back to normal within seconds of every turn. Revisit
  if someone asks.
- **Titles on OpenPosse's own tabs** (Settings, the demo). Nothing happens in them during a turn.

## 6. Tests

- `test/title.test.mjs`: each state prefixes correctly; re-applying replaces rather than stacks;
  `original` strips exactly one prefix and leaves foreign titles alone, including the empty title
  and titles that happen to contain ` · `; the words match the website's list.
- `test/e2e`: against the fixture assistant page, during a turn the tab's title reads
  `typing… · Fixture CRM`, then `answering… · Fixture CRM`, then `done · Fixture CRM`; a turn
  that fails after typing (no send button) ends with `Fixture CRM`; a page that renames itself
  mid-turn ends with `done · <new title>`. Looking at the tab clearing `done` is checked by hand
  (`docs/testing.md`), because headless tabs do not report visibility reliably.
- `test/tabs.test.mjs` unchanged and still green: nothing on the turn's path creates a tab.

## 7. The website afterwards

Once this ships, two small things in `openposse-website`:

- The hero's badge timing is a simplification (`typing…` for the whole thinking phase,
  `answering…` while OpenPosse speaks). Either leave it, since it reads well at a glance, or split
  the hero's `thinking` so `typing…` shows while the typed line is going in and `answering…` from
  then until the answer appears. One line in the `badge` map either way.
- The hero puts the word after the tab's name; the product puts it first (§4.3). Moving the
  hero's badge before the name in its tab markup makes the two match.
- The memory note that "the tab labels are not product behaviour yet" flips, and the dot and
  ring stay a website-only flourish unless the favicon follow-up happens.

## 8. Open questions

1. ~~**`done` lifetime.**~~ Settled: until the tab is looked at, and at most 90 s. A tab already
   in view never becomes visible, so there `done` lasts 5 s (found on Notion, 2026-10-15: asked
   from its own tab, `done` sat for the full 90 s).
2. ~~**Lassos that open the box by shortcut.**~~ Settled: `typing` is reported after the box is
   open, by either route, and the content script is already in the tab by then.
3. **Streaming assistants that rewrite the title while answering** (§4.4 handles it, but the
   observer firing on every token is worth measuring once on a real page).
4. **Not yet checked on a real vendor: asking from another tab.** Checked on Notion 2026-10-15
   from its own tab only (`done` for 5 s, then the title back), because the test profile runs
   Notion in an Incognito window. Still to see on a real page: the three words on a background
   tab, `done` clearing when the tab is looked at, and whether the title flickers while Notion
   streams (question 3). The browser tests cover the background-tab sequence on the fixture.
