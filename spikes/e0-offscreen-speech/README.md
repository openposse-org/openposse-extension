# E0 — does on-device speech work in an offscreen document?

Throwaway, kept in the repo so the *answer* is findable later. This is V1's S1: one unknown
that decides the shape of everything after it, cheaper to measure than to reason about.

## The question

V1 needs a microphone that is invisible, survives tab switches, and uses the extension's own
origin so the permission is granted once rather than per site. An **offscreen document** is the
only context that offers all three.

The doubt is documented rather than invented: Chrome's extensions group has reports of
`webkitSpeechRecognition` misbehaving inside offscreen documents, because the *network*
recogniser expected a real page context. Whether SODA running locally cares is unwritten.

## What the answer changes

| If | Then |
|---|---|
| **It works** | The mic lives invisibly. The orb floats over the page, exactly as `design/README.md` specifies. Build E1 as planned. |
| **It fails** | Audio moves to a global (`windowId`) side panel. Same capability — permanent screen width, and the orb renders inside a panel instead of floating. Revise the plan before E1. |

Do not build past E0 without settling this.

Secondary, asked at the same time because it is nearly free: does `phrases` contextual biasing
exist, and does boosting an agent name help? E2 depends on it, and it is what replaces Apple's
`contextualStrings`.

## Running it

1. `chrome://extensions` → Developer mode → **Load unpacked** → this folder.
   No build step; it is plain JS on purpose.
2. Click **Details → Extension options**, then **Grant microphone access**. This must happen
   in a real tab — an offscreen document has no UI to show the prompt in, and a side panel is
   documented as failing with `NotAllowedError: Permission dismissed` on macOS.
3. Click the extension's toolbar button, then **say "Ivan, tell me a joke"** — a roster name,
   so the `phrases` boost has something to bite on.
4. Read the service worker console: **Details → Inspect views: service worker**.

## Reading the result

```
[e0] listening { availabilityAfter: "available", processLocallyAccepted: true,
                 phrasesSupported: true }
[e0] ✅ FINAL: Ivan tell me a joke
```

That is the good outcome, and the two lines answer different questions — the first that the
API exists and accepted the local requirement, the second that audio actually reached it.

Failures worth telling apart:

- `no SpeechRecognition constructor in an offscreen document` — the API is not exposed there
  at all. Side panel.
- `recognition error: service-not-allowed` — local was demanded and could not be supplied.
  This is the spec's designed failure and it is the *right* one to get if it must fail: loud,
  not a silent fall back to the cloud.
- `recognition error: not-allowed` — the microphone grant did not carry. Step 2.
- `listening` printed but no `FINAL` — the API works and the audio does not reach it. This is
  the specific failure the reports describe, and the one that sends us to the side panel.
