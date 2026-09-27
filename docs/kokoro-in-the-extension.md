# Can HeadTTS + Kokoro run inside this extension?

Research record, 2026-09-26. E6's engine gate is built and tested; this is the question of
whether to put anything behind it.

**Short answer: yes, technically, and nothing here is a blocker.** Every hard constraint has a
known answer. What is left is one decision that is not technical — where the weights come from —
and it collides with a rule this project already wrote down.

---

## 1. The browser module runs standalone — confirmed

HeadTTS ships a Node WebSocket server *and* an in-browser module. Only the second is usable
here, and it does not need the first:

```js
import { HeadTTS } from "./modules/headtts.mjs";
```

It runs TTS in a **module worker**, with WebGPU preferred and WebAssembly as the fallback. That
matches the shape E6's gate already assumes.

**Licence confirmed as the plan claimed.** MIT, and it states plainly that it *"doesn't use
eSpeak or any other GPL-licensed module"*, using rule-based grapheme-to-phoneme conversion
instead. This is what makes it the clean path where `kokoro-js` is not — that package depends on
`phonemizer@1.2.1`, which declares Apache-2.0 while shipping eSpeak NG (GPL-3.0).

It is **not on npm**, so it must be vendored from GitHub rather than installed. Given the
patching below is required anyway, that is not an extra cost.

## 2. It fetches three things remotely, and one of them is fatal

Out of the box `headtts.mjs` loads:

| What | From | Verdict |
|---|---|---|
| transformers.js | `cdn.jsdelivr.net` | **Fatal.** Remotely hosted *code* |
| Kokoro model | HuggingFace, during init | Data — permissible to Chrome, barred by our own rule |
| Voice `.bin` files | `huggingface.co/onnx-community/…/voices` | Same |

It does **not** set `env.localModelPath`, so nothing loads locally without changes.

The CDN import is the one that cannot be negotiated. MV3 forbids remotely hosted code outright,
and extensions have been **rejected from the Web Store** for exactly this — transformers.js
fetching its runtime at load time. So HeadTTS has to be *patched*, not merely vendored:
`env.backends.onnx.wasm.wasmPaths` pointed at `chrome.runtime.getURL('…')`, with the `.wasm` and
`.mjs` files listed in `web_accessible_resources`.

## 3. WebGPU works in an offscreen document — confirmed

This was the load-bearing unknown, since all of our audio already lives there.

An offscreen document is a full `Window` context, so `navigator.gpu` is exposed and
`requestAdapter()` behaves normally. No manifest permission is needed for WebGPU itself.
(Service workers were the context that historically could not do this; Chrome 124+ can, but we
do not need that.)

**Our existing check is already the right one.** `hasWebGPU()` asks for an adapter rather than
trusting `navigator.gpu` to exist, and that is not defensiveness for its own sake: there is a
known Chromium bug where `chrome://gpu` reports WebGPU as hardware-accelerated while
`requestAdapter()` returns null on certain dual-GPU laptops. Trusting the property would route
those machines to an engine that cannot start.

## 4. One manifest change, with a nasty failure mode

```json
"content_security_policy": {
  "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
}
```

Without it, WASM will not compile. The failure is worth knowing in advance: the `CompileError`
is thrown inside an un-awaited promise, so **nothing settles and nothing appears in the
console** — the feature simply hangs. Given this project's history with swallowed errors, wrap
the initialisation and report the reason.

Also reported: ONNX Runtime's multithreading has historically needed disabling in extensions.

## 5. What it actually weighs

Measured from the published model files, not estimated:

| File | Size |
|---|---|
| `model.onnx` (fp32) | 326 MB |
| `model_fp16.onnx` | 163 MB |
| `model_q4f16.onnx` | 155 MB |
| `model_quantized.onnx` (q8) | 92.4 MB |
| **`model_q8f16.onnx`** | **86.1 MB** |
| Each voice `.bin` | ~522 kB |
| All 28 voices | 28.7 MB |

Plus the ONNX Runtime WASM and HeadTTS's CMUdict dictionaries.

**The plan's "86 MB quantized" is the model alone.** A realistic bundle is **~100–130 MB**
depending on how many voices ship. Six voices — enough for any plausible roster — is ~3 MB, so
the voices are not the problem; the runtime and the model are.

## 6. The decision: bundle, or fetch once

This is the part that is not technical.

**Chrome's own policy draws the line at code, not data.** Remotely hosted code is *"anything
executed by the browser that is loaded from someplace other than the extension's own files"* —
JavaScript and WASM — and explicitly *"does not include data or things like JSON or CSS"*.
Fetching a remote resource that is not used to evaluate logic is permitted.

So the standard pattern, and the one the closest reference implementation uses, is **bundle the
runtime and fetch the weights on first run**, cached in IndexedDB. `kokoro-reader` — MIT, a
local-first read-aloud extension doing very nearly our job — ships ONNX Runtime's
`ort-wasm-simd-threaded.jsep.{mjs,wasm}` inside the package and downloads the ~80 MB model from
HuggingFace on first use.

**That is exactly what `CLAUDE.md` forbids:** *"No third-party model downloads at runtime. Apple
Intelligence's own OS-managed model download is fine."* And `extension/CLAUDE.md` names the case
directly — SODA and Gemini Nano are fine because the *browser* manages them; *"Fetching weights
from HuggingFace is not, which is why Kokoro would be bundled rather than fetched."*

The tension is worth stating rather than resolving by preference, because the rule's own
reasoning points both ways:

- **Against fetching:** it is a third party, at runtime, over the network, for a product whose
  entire promise is that nothing leaves the machine. A user watching Little Snitch during the
  `design.md` §3 verification would see a connection to HuggingFace.
- **For fetching, as an exception:** the rule's carve-out is *browser-managed, user-initiated*
  downloads. Setup already has a **Download** button for the SODA speech model, which is a
  one-time, user-initiated fetch of model weights from a third party that happens to be routed
  through Chrome. A Kokoro download in the same list, with a **pinned SHA-256 verified before
  use**, differs in who performs the transfer rather than in what happens. It is not obviously
  the thing the rule was written to prevent.

Two facts that bear on it:

- Git history does not shrink. Committing ~100 MB is permanent without a rewrite, and it is paid
  by every clone forever, including CI.
- The Web Store's data/code distinction is **well documented but has never been ruled on for ML
  weights specifically**. The inference is sound; it is not airtight. There is a policy clause
  about interpreters executing *"complex commands fetched from a remote source, even if those
  commands are fetched as data"*, and an ONNX graph is a computation graph. In practice reviews
  do not appear to go that way, but hash-pinning and explicit reviewer notes are cheap insurance.

## 7. Recommendation

**Bundle the runtime either way — that part is not optional and is most of the integration
work.** transformers.js, the ONNX Runtime WASM, HeadTTS patched to use local paths, the CSP
change, and the dictionaries. None of it is in question and all of it is needed whichever way
the weights arrive.

For the weights, the honest options in order of my preference:

1. **Bundle a single q8f16 model and six voices (~90 MB).** Keeps the rule intact with no
   argument, and makes the Little Snitch check trivially true. Costs ~90 MB of permanent git
   history and a slower install.
2. **Ship it as a user-initiated download in setup, hash-pinned, sitting beside the SODA
   button.** Keeps the repo small and the install fast, and is what the reference implementation
   does — but it needs `CLAUDE.md` amended deliberately rather than quietly, because it is
   currently forbidden in as many words.
3. **Do neither yet.** The gate is built and falls back correctly; system voices work. E6 is the
   only milestone whose absence costs quality rather than capability.

What I would not do is pick (2) without amending the rule first. A rule that gets worked around
the first time it is inconvenient is worse than no rule, and this one is load-bearing for the
product's central claim.

---

## Sources

- [HeadTTS](https://github.com/met4citizen/HeadTTS) — MIT, browser module, no eSpeak
- [Kokoro-82M-v1.0-ONNX file sizes](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) and [voices](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/main/voices)
- [Chrome — Deal with remote hosted code violations](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)
- [Chrome Web Store program policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [transformers.js #839 — rejected for remotely hosted code](https://github.com/huggingface/transformers.js/issues/839)
- [kokoro-reader](https://github.com/Curious-Ray/kokoro-reader) — MIT reference implementation
- [WebGPU troubleshooting](https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips) and [requestAdapter](https://developer.mozilla.org/en-US/docs/Web/API/GPU/requestAdapter)
- [Chromium 332726571](https://issues.chromium.org/issues/332726571) — adapter acquisition fails while `chrome://gpu` claims acceleration
