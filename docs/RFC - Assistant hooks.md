# RFC: Assistant Hooks (working title)

**Status:** Draft 0.1, 2026-10-06 · **Author:** [your name] · **Reference client:** OpenPosse

**Unverified:** §8's description of WebMCP was written from memory. Check it before sending this out.

## 1. Summary

Many web apps now have an AI assistant built into their pages. People's own tools (a voice tool, a browser agent, an accessibility tool) can only use one by scraping the page. They have to guess which box takes the question, which button sends it, and when the answer is finished.

Assistant Hooks is a small, opt-in standard a vendor adds to its page. With it, an agent can find the assistant, ask it something and read the answer, inside the user's own signed-in session. Think of it as MCP for the assistant that's already in a web app, served by the page instead of a server.

There are two levels: Level 1 is a few HTML attributes, and Level 2 adds two JavaScript functions.

## 2. Motivation

OpenPosse is a browser extension that lets people talk to the assistants in their web apps by voice. Today someone has to record each assistant once: they click through it while a recorder notes which elements they used. Building that kept hitting the same problems:

- **Recording is a barrier.** Each assistant has to be recorded before anyone can use it, and few people will spend the time.
- **No page says when an answer is finished.** Agents have to wait until the page stops changing. On one app that wait was about 4 s of a 14 s voice turn.
- **The "busy" signal is a swapped element.** One widely used app replaces its send button with a different element while it generates. Watching the button's attributes never shows that it's busy.
- **Answers can look identical to what's around them.** In the same app, the question, the answer and a timestamp render as rows with the same attributes. No selector can tell them apart.
- **Simulated typing is silently ignored.** Browsers mark keystrokes created by a script as untrusted, and some apps ignore them without an error.
- **Recordings break.** A redesign breaks every recording of an app at once, and users can't tell a broken recording from a broken assistant.

The vendor's own page already knows which element is the answer and when it's done. This RFC asks the page to say so.

## 3. Goals and non-goals

**Goals**
- An agent can find an app's assistant, ask it a question and read the answer, with no recording step.
- It keeps working through redesigns, because the vendor maintains the markup.
- Level 1 takes a vendor about an afternoon.
- Nothing new goes over the network, and no credentials are involved.

**Non-goals**
- General page automation. There's no `click(selector)` or `type(selector)`, only asking and reading.
- Reaching a vendor's data from outside the page. That's MCP's job (§8).
- Identifying or authenticating whoever is asking.
- Changing what a user is allowed to do. Quotas, admin policies and terms apply as if the user had typed the question.

## 4. Level 1: markup

A page declares support in its `<head>`:

```html
<meta name="assistant-hooks" content="0.1">
```

It then marks elements it already renders with `data-assistant-hook`:

| Hook | Required | Marks |
|---|---|---|
| `composer` | yes | where a question is typed |
| `send` | yes | the button that sends what's in the composer |
| `answer` | yes | each reply from the assistant, with its state (§4.1) |
| `answer-body` | no | inside an `answer`, just the answer text, without copy buttons, timestamps or suggested follow-ups |
| `launcher` | no | opens the assistant when the composer isn't on the page |
| `stop` | no | cancels a reply in progress |

- If your composer only sends on Enter, it still needs a `send` hook. A hidden button that calls your send function is enough.
- `data-assistant-name` on any hook gives the assistant's display name.

```html
<button data-assistant-hook="launcher" data-assistant-name="Acme AI">Ask AI</button>

<div data-assistant-hook="answer" data-assistant-state="streaming" aria-busy="true">
  <div data-assistant-hook="answer-body">Twelve applications are missing an owner…</div>
  <button>Copy</button>
</div>
<div contenteditable="true" data-assistant-hook="composer" aria-label="Ask Acme AI"></div>
<button data-assistant-hook="send">Send</button>
<button data-assistant-hook="stop">Stop</button>
```

### 4.1 Answer state

| `data-assistant-state` | Meaning |
|---|---|
| `pending` | sent, nothing shown yet (optional) |
| `streaming` | text is arriving |
| `complete` | finished. Set once, when your page treats the reply as done (usually when it hides Stop or re-enables Send) |
| `error` | finished without an answer; `data-assistant-error` gives the code (§6) |

An agent clicks `send`, waits for a new `answer` at the end of the page, and reads it once it reaches `complete`. So:

- The newest reply's `answer` must come last in the page.
- The current state must be on whichever `answer` element is in the page right now. Your framework may replace the element while it updates; that's fine.
- If a request fails before any reply appears, it still gets an `answer` in state `error`. That element may be `hidden`.
- A regenerated reply goes back to `pending` or `streaming`.

Set `aria-busy="true"` while a reply is in progress. Screen readers need the same signal, so they read the answer once instead of word by word.

### 4.2 Behaviour

- **Reachable.** Hooks must be in the normal page, an open shadow root, or a frame on the app's own origin. A closed shadow root hides them from every agent.
- **Marking an element is consent to drive it.** `launcher`, `send` and `stop` must work when a script calls `element.click()`. They must not reject clicks that weren't made by a real person (`isTrusted` false).
- **The composer accepts text inserted by a script.** Run `composer.focus()`, then `document.execCommand('insertText', false, text)`, then click `send`: exactly `text` must be sent. This is a test, not a required API. Whatever editor you use, text inserted this way is what gets sent.
- **Hooks are a public interface.** They must survive redesigns. Removing or renaming one is a version change.

Partial markup still helps. Marking only `answer` and its state already removes the wait for the page to go quiet. Agents use whatever hooks a page has and fall back to their own methods for the rest.

## 5. Level 2: functions

A page can also offer the assistant as two functions. Agents then don't need to type, click, or find the right frame at all:

```js
window.assistantHooks = {
  version: '0.1',
  name: 'Acme AI',
  async ask(prompt) {
    const reply = await chat.send(prompt); // your existing send path
    return reply.ok ? { ok: true, text: reply.text } : { ok: false, error: reply.code };
  },
  async lastAnswer() {
    return chat.lastAssistantMessage()?.text ?? null;
  },
};
```

- `ask` behaves as if the user had opened the assistant, typed `prompt` and pressed Send. It uses the same conversation, shows in the page and the history, and is under the same quotas and policies.
- It returns `{ ok: true, text }` once the answer is complete, or `{ ok: false, error }` with a code from §6. It doesn't throw for those cases.
- Results are plain JSON, so they reach an extension unchanged. An extension calls `ask` by running a function in the page's own context (`chrome.scripting.executeScript` with `world: 'MAIN'`).
- To show the answer while it's still arriving, an agent reads it from the Level 1 markup, which keeps updating while `ask` runs.
- If the browser supports WebMCP (§8), also register the two functions as tools named `ask_assistant` and `get_last_response`, so the browser's own agent finds them.

## 6. Errors

| Code | Meaning | What the user does |
|---|---|---|
| `auth_required` | signed out, or the session expired | sign in |
| `rate_limited` | too many requests for now | wait |
| `not_entitled` | the plan or an admin doesn't allow the assistant | ask an admin |
| `refused` | the assistant declined to answer | rephrase |
| `unavailable` | the service failed | try later |

Each error needs a different action from the user, which is why they're separate codes.

Agents pass on any code they don't recognise unchanged, and ignore hook names and states they don't recognise. That way vendors can add new ones without breaking anyone.

## 7. Security and privacy

- **No credentials.** Text goes in and text comes out. The login stays in the browser's cookies, and agents never see a token.
- **Nothing that wasn't possible before.** Hooks label elements that any script on the page can already reach, and `ask` does what such a script could already do by clicking. Hooks make it easier for any script, good or bad, but the ability already exists.
- **Nothing is fetched.** The hooks are part of the page the user already loaded. There's no file to download and no new endpoint.
- **The user decides.** Agents use hooks only on sites the user has allowed them to act on.
- **Answers are untrusted.** Agents never follow instructions found in answer text.

## 8. Prior art

- **MCP** connects agents to servers, usually run by the vendor with their own login, mostly to reach the vendor's data. Assistant Hooks reaches the vendor's assistant, the product built on that data, inside the user's own session and permissions, with nothing to host. The two work together.
- **WebMCP** is a proposal in a W3C community group for pages to register tools that agents in the browser can call (`navigator.modelContext`). Level 2 builds on it where it's available. This RFC adds a fixed set of names, so `ask_assistant` means the same thing on every site. It also adds the markup level for vendors who won't ship a JavaScript API.
- **WAI-ARIA** already has `aria-busy` for content that's still being updated. Level 1 uses it alongside the explicit state.

## 9. Why a vendor would do this

- **More use.** The assistant can be reached by voice and by agents from anywhere in the browser. Every question counts as use of the vendor's product, on the user's existing seat and quota.
- **Low cost.** Level 1 is attributes on elements the page already renders, plus a state it already tracks. There's no server, no OAuth, and no API product to price and police.
- **Fewer false bug reports.** Agents stop relying on selectors that break with every redesign and then get reported as "your AI is broken".
- **Accessibility.** Screen readers need the "answer is complete" state anyway.

## 10. Open questions

1. Can browser extensions call a page's WebMCP tools, or only the browser's own agent? If extensions can, `window.assistantHooks` may not be needed.
2. More than one assistant on a page: should each hook carry an id?
3. Should `ask` be able to start a new conversation instead of continuing the open one?
4. Rich answers, such as tables, citations and links. v0.1 is plain text only.
5. Should a page learn that a question came from an agent? Vendors will want that for analytics, but it would tell them which tools a user runs. This draft says no.
6. The name, and whether `data-assistant-*` clashes with markup already on the web.

## 11. Path to adoption

1. OpenPosse as the reference client. It uses hooks when present, records only what's missing, and waits for `complete` instead of for the page to go quiet.
2. A public demo page, and a script vendors can run in the browser console to check their own pages.
3. One or two first adopters among the assistants people already drive this way. A working version in one real app will persuade more than this document.