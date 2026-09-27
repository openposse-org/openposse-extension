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

## Why these exact files

Only the WebGPU path is vendored. `onnxruntime-web` unpacks to **131 MB** across every build
variant; the three files needed for a WebGPU browser build come to **24.7 MB**, almost all of it
`ort-wasm-simd-threaded.jsep.wasm`. The `asyncify`, `jspi` and non-JSEP WASM builds, the WebGL
backend, the Node bindings and every source map are deliberately absent.

## CMU dictionary

`dictionaries/en-us.txt` is ~125,000 entries, 2.6 MB, redistributed by HeadTTS. The CMU
Pronouncing Dictionary is under a simplified BSD-style licence permitting commercial use.
Out-of-dictionary words fall back to HeadTTS's letter-to-sound rules, derived from NRL Report
7948 (1976), a US Navy publication.
