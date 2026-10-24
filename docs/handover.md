# Handover – 2026-10-24

For a session picking this repo up without the maintainer's local notes. It covers where things
stand, what is next, and the rules that are easy to break because the broken version still looks
like working code.

## Where things stand

- **v0.6.0 is the Latest release** (recipe identity, #25). Since then only non-release changes
  have landed: #27, the rope loader pages in `src/assets/`, which the build does not copy into
  `dist/`, and #28, this file. `git log` and `gh pr list` give anything newer.
- **Chrome Web Store, step 5 of going public, is blocked on the maintainer**: Google's account
  check stopped the creation of the beta item. Once it exists, the zip is uploaded by hand, the
  listing and Privacy tabs are filled from `docs/releasing.md`, the item ID goes into the repo
  variable `CWS_BETA_ITEM_ID`, and the Beta workflow runs once. Step 6 (the public listing)
  follows. None of that can be done from a cloud session.

## Next work, in order

1. **Recipe identity §7** is done: `recipes/*.json` are shared files carrying `id` (the
   website's slugs, `notion-ai` and `acme-ai`), `recordedOn` and `hash`, and the repo test
   unpacks them directly. Change a selector there and regenerate the file with `pack`; the test
   fails on a stale hash. `hash` is 12 hex of SHA-256 over the canonical JSON and is never
   trusted from a file.
2. **The website's §5**, in the separate `openposse-website` repo: the sync mirrors `canonical`
   and `hashOf` (the fixture `test/fixtures/fixture-crm.json` hashes to `49cd0c15178f`),
   publishes `id`, `recordedOn` and `hash`, and the recipes page shows the revision. Also there:
   the hero's tab badge sits after the name, the product puts it before (`typing… · Q3 plan`).

## Checks only a person in Chrome can run

Owed, and worth reminding the maintainer about when the area comes up:

- Recipe identity (steps in `docs/testing.md`, Sharing row): share an assistant and paste it back
  ("You already have this one, as …"); change one selector and only Replace is offered; Replace
  keeps the voice; Record this tab on a site that has an assistant re-records it.
- Tab titles seen from **another** tab on real Notion (`docs/tab-titles.md` §8 Q3–Q4).
- On a new tab the shortcut opens the panel saying the page can't be driven, and the assistant
  still answers. With Notion in its own window, asking from another window lands the answer in the
  current window's panel and leaves Notion's window behind.
- A network monitor pass over a full turn, to confirm it touches nothing.

## How changes land

- Branch `feat/…` or `fix/…` off `main`. `wip:` commits after each verified step.
- **Every change goes through a PR.** Merge commit is the only method; required checks are
  "Lint, test and package" and "Browser tests (ubuntu-latest)". No auto-merge. Merge only when
  the maintainer says so, with `gh pr merge N --merge --delete-branch`. Read checks once with
  `gh pr checks N`; do not poll.
- PR titles are Conventional Commits and release-please reads them: `feat:` minor, `fix:` patch,
  `docs:`/`chore:`/`ci:`/`test:` no release. After a release-type merge it opens
  "chore(main): release X.Y.Z"; merge that (on the maintainer's word) **before** any other PR.
- PR bodies state what changed, why, the decisions made and what was checked.
- `npm test` is ESLint (three old warnings, leave them) plus node tests, 259 pass.
  `npm run test:e2e` is Playwright against `test/fixtures/vendor.html`, 11 pass in about 40 s.
  Run each once and read the timings.
- Dependabot ignores `onnxruntime-web` on purpose: it is pinned to match the `.wasm` vendored with
  transformers.js in `public/vendor/transformers/`. Update both together, by hand.
- Edit files with an edit tool, not `sed` or scripted string replacement: those succeed silently
  when the pattern does not match. Never use em-dashes in prose or files; use en-dashes.
- Ask before doing work nobody asked for. Mention adjacent tidying in a sentence instead of doing it.

## Hard rules

**Nothing leaves the device.** Every `SpeechRecognition` sets `processLocally = true`. TTS voices
are filtered on `localService === true`. No network call during a turn. Model weights are fetched
only from setup, when the user presses the button, from a URL pinned in `weights.js`, and checked
against a SHA-256 baked into the build; a mismatch throws the file away.

**Never log transcripts, page content or vendor responses.** Event types and error codes only.

**Only a tab the user already has open.** Nothing on a turn's path opens a vendor's site: no
`tabs.create`, `windows.create`, `tabs.update` with a `url`, or `window.open`. Find the tab with
`vendorTab` in `src/tabs.js`. `test/tabs.test.mjs` enforces this; do not widen its allowlist.
Asking does not switch tabs either; navigation is something the user asks for ("show me").

**No vendor in `manifest.json`.** Sites are granted one origin at a time through
`permissions.request()` from a button in the popup, and registered with
`chrome.scripting.registerContentScripts`. A vendor is a recorded recipe in storage, never code:
no files named after a company, no hardcoded selectors.

**High-level intents only** (`ask_assistant`, `get_last_response`, `invoke_via_shortcut`). No
generic click or type primitives. The recorder never invents a selector: a missing one is
`ELEMENT_NOT_FOUND`, and a failed intent is never retried on the extension's own judgement.

**Credentials never leave the browser.** Report whether a session is valid; never read, forward
or log cookies, tokens or login form values.

**No file hardcodes a shortcut key.** Read `chrome.commands.getAll()`.

**Every `catch` names its error, and every failure that carries a reason surfaces it.** A silent
early return that can be mistaken for a different failure says which one it is.

## Traps that cost real time

- **A backtick inside a CSS template literal** (`orb.js`) closes it and still builds, lints and
  tests green; it throws when the content script loads. Escape every backtick. When the extension
  "does nothing", `chrome://extensions` → Errors is the only place that says why. No test runs a
  bundle.
- **A global command carries no `tab`**, and `sidePanel.open()` does not survive an `await`. The
  window is cached ahead of time in `src/front.js`; filter its focus listener to normal windows
  and never remember `WINDOW_ID_NONE`.
- **Kokoro at fp16 on WebGPU produces silence** (NaN as zeros, correct duration, no error). fp32
  is the default; q8 is the fallback. dtype names are not filenames (fp32 is `model.onnx`, q8 is
  `model_quantized.onnx`), and an unknown dtype is ignored silently. The peak-amplitude guard in
  `kokoro.js` stays.
- **The order of `VOICES` in `weights.js` is load-bearing**: unassigned agents get a voice by
  position.
- **Speech `phrases` boost is logarithmic.** Use 3.0 for an agent name; 8–10 makes the recogniser
  hear the name everywhere. Endpointing comes from the recogniser (`speechend`, `end`); do not
  build a silence timer.
- **Vendor DOM:** set React-controlled inputs through the native value setter plus a bubbling
  `input` event; prefer clicking the send button over synthetic Enter (`isTrusted`); find the
  frame that owns the assistant before messaging it; a busy signal is an element replaced, not an
  attribute changed, so diff `data-testid`s from a baseline and require sustained absence.
- **The orb may show and instruct, never ask for typing**: pages take focus back. Naming lives in
  Settings.
- **Gemini Nano is off by enterprise policy** on many work machines. Nothing uses it now; if it
  comes back, treat it as absent by default.
- **Do not click Remove** on an installed extension while testing: it deletes the roster, recipes
  and downloaded voices.

## Known and open, not bugs

- The busy indicator is captured correctly and saves no time yet (~5000 ms against ~3997 ms).
- The dry run cannot exercise the opening step.
- fp32 corrupts some inputs on Intel Iris Xe upstream; a per-GPU q8 route is unbuilt.
- An install from before 0.6.0 may hold two assistants for one site; nothing merges them.
