# Voice input landscape — what the OS and the market already do

Researched **2026-09-24**, against macOS 27 "Golden Gate" (released 2026-09-14).

This answers three questions that circle one strategic concern: **is OpenPosse's premise
already solved by the operating system, or by something in the Chrome Web Store?** The short
answer is that *half* of it is solved, thoroughly and for free — and the half that is solved
is not the half OpenPosse is for.

Sources are linked inline. Claims about Apple APIs here come from documentation and reporting,
**not** from reading `.swiftinterface` files, so they carry less weight than the `(SDK)`-marked
claims in `decisions.md`. Verify before building on them — see `[[apple-sdk-swiftinterface-first]]`
in the working notes for why that distinction has mattered twice already.

---

## 1. Dictation into web text fields is a solved OS feature

**Siri does not do this. Dictation does, and has for years.** The two are separate systems and
conflating them is common. Siri is a command assistant; **Dictation** types into whatever text
field currently has focus, system-wide, including any field in Chrome. It is enabled once in
System Settings → Keyboard → Dictation and triggered with a key (Fn Fn by default). No
per-site setup, no extension, no cost.

So "voice input into any website textbox" is not a gap in the platform. It is a built-in
capability on every Mac.

### What macOS 27 changed

| | |
|---|---|
| Dictation accuracy | Significantly improved, driven by Apple's new natively-multimodal foundation model |
| Gate | **M3 or newer, 12 GB+ memory**, English-first |
| Toggle | None — it simply works better on supported hardware |
| Text editing by voice | **Did not ship on macOS.** Added to iOS 27 dictation; not brought across |

A [hands-on comparison](https://www.macworld.com/article/3139330/macos-27-mac-features-siri-apple-intelligence-release-date-compatibility.html)
of an M1 Max Mac Studio against an M4 Max MacBook Pro found the difference real: speaking
quickly or quietly produced frequent errors on the older machine and none on the newer.

The editing gap is worth knowing about because it sends people elsewhere.
[TidBITS reports](https://tidbits.com/2026/09/21/what-a-broken-wrist-taught-me-about-ios-27-dictation-and-macos-voice-control/)
that someone dictating full-time after breaking a wrist had to fall back to
System Settings → Accessibility → **Voice Control**, which does have editing commands, because
Mac dictation still has none.

### What this means for our speech stack

**Nothing to change.** No `SpeechAnalyzer` overhaul shipped in macOS 27 — the
[beta-SDK notes](https://github.com/yrocaz/mac-transcriber/blob/main/docs/research/2026-07-27-apple-speechanalyzer-docs.md)
show only documentation flagged "27 beta", no new API surface. Since OpenPosse transcribes
through the system model rather than a bundled one (D2), the accuracy improvement arrives for
free on supported hardware and costs nothing on older Macs beyond what M1.4 already measured.

---

## 2. The Chrome extension market has this covered

A mature, crowded category. The incumbent is
[**Voice In**](https://dictanote.co/voicein/) — 500–600k users, 4.4★ from ~2,700 ratings,
free tier of 30 min/day, works in any text field on any site.

| Extension | Approach |
|---|---|
| [Voice In](https://dictanote.co/voicein/) | The default recommendation almost everywhere; built-in punctuation commands |
| [BlabbyAI](https://www.blabby.ai/blog/voice-to-text-chrome-extension) | Whisper v3 Turbo, automatic punctuation and grammar, 20,000+ sites |
| [Voicy](https://usevoicy.com/speech-to-text-chrome-extension) | Privacy-positioned but cloud-based; $8.49/mo–$260 lifetime |
| LipSurf | Full browser voice *control*, beyond dictation |
| Speechnotes, Dictation.io | Free, no account, dedicated writing surfaces |

One finding deserves attention because we hit it independently: reviewers
[warn](https://www.blabby.ai/blog/voice-to-text-chrome-extension) to test any chosen extension
in your own rich editor, since "a conventional textarea and a rich document canvas can accept
inserted text differently even when both look like text boxes." That is exactly the problem
M2 solved with `execCommand('insertText')`, rediscovered by the review press. It is a real and
general hazard, not a Notion quirk.

---

## 3. Training AFM on recorded or transcribed data

Two separate questions with different answers.

### The speech model: no training surface exists

There is none. The only adaptation available is `AnalysisContext.contextualStrings`, which
**biases** recognition towards supplied terms rather than learning from data. OpenPosse already
uses it for agent names, per the amendment to D2.

### AFM: technically possible, practically prohibitive

Apple ships a [LoRA adapter training toolkit](https://developer.apple.com/apple-intelligence/foundation-models-adapter)
— rank 32, base weights frozen, ~160 MB per adapter. Every constraint lands badly for us:

- **Not on-device.** Training runs offline in Python on a Mac with **32 GB+** or a Linux GPU
  machine. Nothing trains inside a shipped app on a user's machine, despite how "on-device
  fine-tuning" is often reported.
- **Managed entitlement.** Shipping an adapter requires
  [`com.apple.developer.foundation-model-adapter`](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.foundation-model-adapter),
  requested by the Account Holder of a Developer Program membership and approved by Apple.
  Training and local testing need no entitlement; shipping does.
- **Bound to one base-model version.** When Apple updates the system model, the adapter stops
  working and must be retrained. That is a standing maintenance obligation tied to Apple's
  release schedule, not ours.
- **Delivered via Background Assets**, not bundled — Apple explicitly says to remove adapter
  files before publishing.

### The blocker that is not technical

**Training on recorded user data contradicts the product's central promise.** Collecting
transcripts to train on is precisely what `CLAUDE.md` forbids — "never log transcripts, page
content, or vendor responses… this is a product promise, not a preference." Per-user local
training is closed off separately by the 32 GB requirement and the Python toolchain.

Both routes are shut, and the technical constraints above are the *less* important reason.

### And it would not help the problem we have

Apple's own guidance is to reach for an adapter only after prompt engineering and tool calling
have failed. OpenPosse's routing is already solved structurally: a runtime
`DynamicGenerationSchema` with constrained decoding makes an unregistered agent name
impossible to produce (D1, P6). An adapter cannot improve on a guarantee.

**Conclusion: closed, and not worth reopening** unless a task appears that prompt engineering
demonstrably cannot do. If one does, the entitlement is the long pole — request it early.

---

## What this means for the product

Stated plainly, because it is the reason the questions were asked:

> **Dictation into web fields is solved — by the OS, and by a dozen extensions. That is not
> OpenPosse's differentiator and should not become one.**

What none of them do is the thing that already works here: **address a named assistant by voice
and hear it answer back.** Voice In types your words into a box; you still read the reply, and
you still chose the box. OpenPosse routes *"Ivan, tell me a joke"* to the right assistant among
several, drives it, and speaks the answer. That is a conversation with a named agent, not a
keyboard replacement — and it is the half of the problem nobody in the market is solving.

This sharpens the MCP direction rather than competing with it. A vendor's MCP server removes
the fragile half — no DOM, no selectors, no transcript rows, none of what cost a full day of
M3 — while leaving the valuable half untouched. `ConnectionRef.mcp(serverID:)` already exists
in `Agent`, reserved for M5, behind the same `AgentConnection` protocol the browser path uses.
An agent could change transport without the voice loop noticing, which is what that protocol
was for.

---

## Open questions this raises

- **Does the M3-or-newer dictation gate matter to us?** We use `SpeechAnalyzer`, not the
  dictation UI. Whether the improved model reaches `SpeechTranscriber` on the same hardware
  terms is unverified and worth measuring — M1.4's bake-off harness can answer it directly.
- **Is Voice Control a distribution channel or a competitor?** It already drives arbitrary UI
  by voice. Worth one session understanding what it can and cannot do before assuming.
- **Does an MCP-backed agent still need the recorder?** If a vendor ships an MCP server, the
  wizard's job changes from recording a page to authorising a server. That is a different
  five steps, and possibly a much shorter one.
