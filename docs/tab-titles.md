# Tab titles during a turn

**Status:** Draft 0.1, 2026-10-15 · **Decided:** the website shows it, the product should do it (2026-10-15) · **Scope:** one small feature, one PR

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
| `typing…` | The content script begins putting the prompt into the input (after it has opened the box, if the recipe opens by click or shortcut) | The prompt is submitted |
| `answering…` | Submit | The answer loop reports the response finished (`finished()` seen-then-left, or the settle passes end) |
| `done` | The response is captured and sent back | The first of: the person activates the tab; the next question goes to the same tab; 90 s |
| *(restored)* | Any failure (`result.type !== 'response'`: no box found, timed out, not signed in…) | – |

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

- **`src/title.js`** (new, pure, tested): `withState(title, state)` → the prefixed title;
  `original(title)` → the title with any OpenPosse prefix removed; the state words in one place so
  the website's `badge` map can quote them.
- **`src/content.js`**: calls `withState` at the three moments in §4.2, which it already passes
  through (opening the box, submitting, the answer loop's finish), and `original` on failure and
  on a `title.restore` message. It owns the observer in §4.4.
- **`src/service-worker.js`**: sends `title.restore` to the tab when `chrome.tabs.onActivated`
  fires for it while it is `done`, when a new question is about to go to it, and from a 90 s
  alarm. On a failed turn the content script has already restored; nothing to send.

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
  `typing… · <fixture title>` before submit, `answering… · …` until the response is finished,
  `done · …` once the answer is back, and the fixture title alone after `chrome.tabs.update
  (tabId, { active: true })`; a turn that fails on a missing box leaves the title untouched at the
  end; a page that rewrites its title mid-turn ends with its new title, unprefixed.
- `test/tabs.test.mjs` unchanged and still green: nothing on the turn's path creates a tab.

## 7. The website afterwards

Once this ships, two small things in `openposse-website`:

- The hero's badge timing is a simplification (`typing…` for the whole thinking phase,
  `answering…` while OpenPosse speaks). Either leave it, since it reads well at a glance, or split
  the hero's `thinking` so `typing…` shows while the typed line is going in and `answering…` from
  then until the answer appears. One line in the `badge` map either way.
- The memory note that "the tab labels are not product behaviour yet" flips, and the dot and
  ring stay a website-only flourish unless the favicon follow-up happens.

## 8. Open questions

1. **`done` lifetime.** 90 s is a guess. The alternatives are "until the tab is looked at" alone
   (could be hours) or clearing when OpenPosse finishes speaking (the person then has no marker to
   find the tab by).
2. **Recipes that open the box by shortcut.** The person's own keystroke is not involved, so
   `typing…` still fits; confirm nothing in that path runs before the content script is in the
   tab.
3. **Streaming assistants that rewrite the title while answering** (§4.4 handles it, but the
   observer firing on every token is worth measuring once on a real page).
