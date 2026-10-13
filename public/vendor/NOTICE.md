# Vendored third-party code

Everything here is committed rather than fetched, because Manifest V3 forbids remotely hosted
**code** and extensions have been rejected from the Chrome Web Store for exactly that — a
bundled library reaching for its own runtime at load time. The model *weights* are a separate
matter and are downloaded from setup; see `src/weights.js`, which pins each file's URL and
SHA-256 and refuses any file that does not match.

Verified 2026-09-27 by reading what actually gets linked, not the badge on the package. That
distinction is this project's standing rule and it has already caught one real problem:
`kokoro-js` declares Apache-2.0 while depending on `phonemizer`, which ships eSpeak NG
(GPL-3.0) with no disclosure. It is not used here for that reason.

| Path | Version | Licence | Source |
|---|---|---|---|
| `headtts/` | `main` @ 2026-09-27 | MIT | [met4citizen/HeadTTS](https://github.com/met4citizen/HeadTTS) |
| `headtts/openposse-local-only.mjs` | — | **OpenPosse's own** | not third-party; see below |
| `transformers/transformers.min.js` | 4.0.0 | Apache-2.0 | [@huggingface/transformers](https://www.npmjs.com/package/@huggingface/transformers) |
| `transformers/ort-wasm-simd-threaded.asyncify.*` | 1.25.0-dev | MIT | [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web) |
| `inter/InterVariable.woff2` | 4.1 | OFL-1.1 | [rsms/inter](https://github.com/rsms/inter) |
| `lucide/LICENSE` (covering `../src/icons.js`) | `main` @ 2026-10-04 | ISC, plus MIT for the Feather-derived icons | [lucide-icons/lucide](https://github.com/lucide-icons/lucide) |
| `../dictionaries/en-us.txt` | with HeadTTS | see below | CMU Pronouncing Dictionary, via HeadTTS |

Each licence text travels with the code it covers: `headtts/LICENSE`,
`transformers/LICENSE-transformers`, `transformers/LICENSE-onnxruntime` and
`inter/LICENSE.txt`. OpenPosse's own licence is Apache-2.0, at the repository root.

## Inter

The UI typeface, **committed rather than linked, and that is the whole point**. `rsms.me` serves
it happily over a CDN, and using it that way would put a third-party request on every surface —
including the orb, which is injected into the user's Notion tab, so the fetch would fire from
inside a page they are working in. That is this project's founding promise broken for a
typeface, and it is remotely hosted content in a Manifest V3 extension besides.

One file: the variable font, weights 100–900, 352 kB, taken from `rsms.me/inter/font-files/` on
2026-09-30. Static weights would be more requests and more bytes. Italic is not shipped because
nothing uses it.

**The SIL Open Font License permits this and asks two things in return**, both satisfied here:
the licence text travels with the font (`inter/LICENSE.txt`), and a font under it may not be
sold on its own or released under a different licence. It carries no copyleft into the software
that uses it, so it does not touch OpenPosse's own Apache-2.0.

**The family is declared as "OpenPosse Inter", not "Inter", on purpose.** The orb registers the
face on the vendor's own `document.fonts`, because `@font-face` inside a shadow root is not
reliably honoured. A vendor shipping its own Inter — and plenty do — would then have two faces
competing under one name, and its typography could change. This panel is a guest.

## Lucide

The icon set, and **the only entry here whose code is not in this directory**. `src/icons.js`
holds the path data for the handful of icons actually rendered; this directory holds the licence
that data arrived under. The split is the same reasoning as the paragraph below about
`node_modules`: Chrome loads the whole unpacked directory and reports its size, so vendoring
1,600 icons to draw fourteen is charged to the extension in full. A copied element costs one
line and nothing when unused.

ISC asks only that the notice is kept, which `lucide/LICENSE` does. That file also carries
**Feather's MIT notice**, because around a hundred Lucide icons are derived from Feather and
`chevron-right` is one of them — so both notices have to travel, and the upstream LICENSE is
committed whole rather than excerpted for exactly that reason.

Neither licence is copyleft, so this does not touch OpenPosse's own Apache-2.0.

To add an icon, copy its geometry rather than redrawing it:

```bash
curl https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/<name>.svg
```

and copy each element inside it into `NODES` as `[tag, attributes]` – Lucide's own icon-node
format – under **Lucide's own name** for it. Renaming an icon to something that reads better
locally is how the next person fails to find one that is already there.

## What was checked, and what was found

- **HeadTTS** states it *"doesn't use eSpeak or any other GPL-licensed module"*, converting
  spelling to phonemes with rule-based logic and the CMU dictionary instead. This is the whole
  reason it is here rather than `kokoro-js`. Only the browser path is vendored —
  `headtts-node.mjs` and `language-fi.mjs` are omitted as unused.
- **transformers.js** was scanned for `espeak`, `phonemizer` and GPL notices. A first pass
  reported eSpeak and was **wrong**: every hit was the substring inside `WeSpeaker`, a
  speaker-recognition model family. A word-boundary scan finds **zero**. Noted because the
  false positive is convincing and the next person will hit it too.
- **ONNX Runtime Web** ships **no LICENSE file in its npm package** — only `"license": "MIT"`
  in `package.json` and a README. Nothing was invented to fill the gap: the canonical text was
  taken from
  [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime/blob/main/LICENSE) on
  2026-09-30 and is committed as `transformers/LICENSE-onnxruntime`. **Copy it again by hand
  whenever the WASM files are updated** — `npm i` will not bring it, which is what made it
  missing in the first place. MIT requires the notice to travel with the code, so vendoring the
  binary without it is a licence breach rather than an untidy directory.

## Updating these files

The packages are **not** dependencies of this extension — they were installed once, three files
were copied out, and they were removed again. That is deliberate: Chrome loads the whole
unpacked directory, so `node_modules` counts toward what it reports, and installing
transformers.js takes `onnxruntime-web` (131 MB) and `sharp` with it. The extension read
**437 MB** in `chrome://extensions` until they were uninstalled.

To take a newer version:

```bash
cd extension
npm i --no-save @huggingface/transformers@<version>
cp node_modules/@huggingface/transformers/dist/transformers.min.js vendor/transformers/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs vendor/transformers/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm vendor/transformers/
npm uninstall @huggingface/transformers
```

**Both of those filenames are the ones that were got wrong first**, and each cost a round:

- **`transformers.min.js`, not `transformers.web.min.js`.** The `.web.` build carries bare
  import specifiers (`onnxruntime-web/webgpu`) that a bundler is expected to resolve and a
  browser cannot — `import()` of it dies with *"Failed to resolve module specifier"*. It is the
  file HeadTTS loads from a CDN by default, which is what makes it the tempting one to copy.
- **`asyncify`, not `jsep`** — see *Why these exact files* below.

Re-run the licence scan afterwards, and expect the `WeSpeaker` false positive described below.

HeadTTS is fetched from GitHub rather than npm because it is not published there. Take
`modules/{headtts,worker-tts,language,language-en-us,utils}.mjs` and
`dictionaries/en-us.txt`, then **re-apply all four local patches**. They occupy **six marked
sites across the two files** — `grep -n "OpenPosse patch" vendor/headtts/*.mjs` should find
three in each — because three of the four have a sending half in the worker and a receiving
half in `headtts.mjs`. Applying only the half you happen to find leaves the other end silent,
which is the failure these patches exist to prevent.

`openposse-local-only.mjs` is **not** upstream and is not replaced when taking a new version.
It is OpenPosse's own file, sitting in this directory because it is imported by the worker.

The first two patches are load-bearing; a clean copy without them reaches the network and
cannot start.

1. `worker-tts.mjs`, at the top — installs the local-only `fetch` and forwards unhandled
   rejections; received by `headtts.mjs`'s `onmessage`. A clean copy silently restores network
   access from inside the worker, and an async setup failure becomes a 30-second connection
   timeout instead of an error, because a rejected promise never fires `Worker.onerror`.
2. `worker-tts.mjs`, after the transformers import — points ONNX Runtime's WASM at the
   extension and turns off remote models, so `from_pretrained` builds a `chrome-extension://`
   URL and **never assembles a huggingface.co one at all**. Belt and braces with the shim,
   deliberately: ONNX Runtime spawns its own worker with its own `fetch` and a synchronous
   `XMLHttpRequest`, neither of which the shim covers.
3. `headtts.mjs`, in the worker-startup `catch` — includes the `ErrorEvent`'s detail in the
   connection error. Upstream pushes `"Failed to start Module Web Worker."` and discards the
   error, so one sentence covers a CSP refusal, a 404 on the worker and a syntax error inside
   it. Three problems, three different fixes, one message.
4. `worker-tts.mjs` after the model loads, and `headtts.mjs`'s `onmessage` — reports the dtype
   and bound execution providers. Diagnostics only; it may be dropped when taking a new version
   if it does not apply cleanly.

## Why these exact files

Only the WebGPU path is vendored. `onnxruntime-web` unpacks to **131 MB** across every build
variant; the WebGL backend, the Node bindings, the plain and `jspi` WASM builds and every source
map are deliberately absent.

**Which WASM build is needed was measured, not assumed.** The first attempt vendored the `jsep`
pair on the reasoning that jsep *is* the WebGPU build; for onnxruntime-web 1.25 it is not, and
`ort.webgpu` asked for `ort-wasm-simd-threaded.asyncify.mjs` — *"no available backend found"*.
`asyncify` (21.8 MB) is what this version loads, and the `jsep` pair has been removed after the
engine ran without it.

If a future version reports "no available backend found", that is this again: read the missing
filename out of the error and take that pair. Do not reason about which build WebGPU "should"
use — that is what produced the wrong answer the first time.

## CMU dictionary

`dictionaries/en-us.txt` is ~125,000 entries, 2.6 MB, redistributed by HeadTTS. The CMU
Pronouncing Dictionary is under a simplified BSD-style licence permitting commercial use.
Out-of-dictionary words fall back to HeadTTS's letter-to-sound rules, derived from NRL Report
7948 (1976), a US Navy publication.
