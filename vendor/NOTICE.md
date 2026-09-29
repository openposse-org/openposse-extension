# Vendored third-party code

Everything here is committed rather than fetched, because Manifest V3 forbids remotely hosted
**code** and extensions have been rejected from the Chrome Web Store for exactly that — a
bundled library reaching for its own runtime at load time. The model *weights* are a separate
matter and are downloaded from setup; see `src/weights.js` and the amended rule in `CLAUDE.md`.

Verified 2026-09-27 by reading what actually gets linked, not the badge on the package. That
distinction is this project's standing rule and it has already caught one real problem:
`kokoro-js` declares Apache-2.0 while depending on `phonemizer`, which ships eSpeak NG
(GPL-3.0) with no disclosure. It is not used here for that reason.

| Path | Version | Licence | Source |
|---|---|---|---|
| `headtts/` | `main` @ 2026-09-27 | MIT | [met4citizen/HeadTTS](https://github.com/met4citizen/HeadTTS) |
| `transformers/transformers.web.min.js` | 4.0.0 | Apache-2.0 | [@huggingface/transformers](https://www.npmjs.com/package/@huggingface/transformers) |
| `transformers/ort-wasm-simd-threaded.jsep.*` | 1.25.0-dev | MIT | [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web) |
| `../dictionaries/en-us.txt` | with HeadTTS | see below | CMU Pronouncing Dictionary, via HeadTTS |

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
  in `package.json` and a README. Nothing is invented here to fill the gap: the canonical text
  is the MIT licence in
  [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime/blob/main/LICENSE), and it
  should be included by hand before this is published.

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
cp node_modules/@huggingface/transformers/dist/transformers.web.min.js vendor/transformers/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs vendor/transformers/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm vendor/transformers/
npm uninstall @huggingface/transformers
```

Re-run the licence scan afterwards, and expect the `WeSpeaker` false positive described below.

HeadTTS is fetched from GitHub rather than npm because it is not published there. Take
`modules/{headtts,worker-tts,language,language-en-us,utils}.mjs` and
`dictionaries/en-us.txt`, then **re-apply both local patches**, each marked `OpenPosse patch`
in the source:

1. `worker-tts.mjs`, two lines at the top — installs the local-only `fetch`. A clean copy
   silently restores network access from inside the worker.
2. `headtts.mjs`, in the worker-startup `catch` — includes the `ErrorEvent`'s detail in the
   connection error. Upstream pushes `"Failed to start Module Web Worker."` and discards the
   error, so one sentence covers a CSP refusal, a 404 on the worker and a syntax error inside
   it. Three problems, three different fixes, one message.

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
