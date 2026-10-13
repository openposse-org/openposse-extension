# Testing OpenPosse

Three layers, each catching what the one before it cannot.

| Layer | Run with | Where it runs | What it proves |
|---|---|---|---|
| Unit tests | `npm test` | every push and pull request (`ci.yml`) | the pure modules: routing, selectors, recipes, voices, weights, sharing |
| Browser tests | `npm run test:e2e` | Ubuntu on pull requests; Ubuntu, Windows and macOS on `main` (`e2e.yml`) | the built extension loads and drives a page |
| The checklist below | by hand | each system, before a release | what no automation can reach |

## Unit tests

ESLint, then `node --test test/*.test.mjs`. They need no browser and run in about half a
second. `npm test` is the check to run before every commit.

## Browser tests

`npm run test:e2e` builds `dist-e2e/` and runs `test/e2e/` with Playwright, in Playwright's own
Chromium in headless mode. Run `npx playwright install chromium` once first.

The fake vendor is `test/fixtures/vendor.html`, a small CRM with an assistant that opens from a
button, a composer, Send replaced by Stop while it answers, and an answer written a word at a
time. Playwright serves it at `https://fixture.test` from the test itself, so nothing reaches
the network. `test/fixtures/fixture-crm.json` is its assistant, Acme, as a shared-recipe file.

`dist-e2e/` is a development build with one difference: its manifest grants
`https://*.fixture.test/*`. A real build is granted a site by the person clicking Allow in
Chrome's dialog, which automation cannot reach. It is never loaded by hand and never shipped.

What they check:

- **Every extension page opens without an error.** Settings, the side panel and the popup.
- **A shared assistant is added from Settings**, through the same box a person pastes into.
- **A typed question reaches the vendor and its answer comes back to the panel.**
- **With no vendor tab open, a turn says "No Fixture tab is open." and opens nothing.**

**A test fails if any page logged an error**, extension pages included. That is the point of
the layer: a bundle that throws while it loads passes ESLint and every unit test, and has
shipped once that way.

What they do not reach: speech in either direction, Kokoro, real vendors, Chrome's Allow
dialog, the side panel's own frame (its page is opened as a tab), the global shortcut, and
registering the vendor script ahead of a turn – the manifest grant skips registration, and
turns inject the script when they need it.

## The checklist

Run before a release on each system the release supports. Chromium, which the browser tests
use, has no on-device speech recognition, so the voice half of the product is only ever checked
here. Use Google Chrome, and a profile you do not mind changing.

**Never click Remove on an installed OpenPosse to load a different build** – it deletes the
assistants, the recipes and the downloaded voice. Load the new folder over it, or export each
assistant with Share first.

| Check | macOS | Windows | Linux |
|---|---|---|---|
| **Setup.** Load `dist/` unpacked; Settings opens; the microphone grant and the speech-model download both complete | ☐ | ☐ | ☐ |
| **The shortcut.** The default (⌘⇧9 on a Mac, Ctrl+Shift+9 elsewhere) starts a turn with Chrome not in front; a shortcut changed at `chrome://extensions/shortcuts` and ticked Global does too | ☐ | ☐ | ☐ |
| **Site access.** Record this tab on a real vendor: Chrome's dialog names the site, and after Allow, `await chrome.scripting.getRegisteredContentScripts()` in the service worker's console lists it | ☐ | ☐ | ☐ |
| **Recording.** Record a real assistant (Notion AI): the coaching ticks each step, the dry run passes, the assistant is named in Settings | ☐ | ☐ | ☐ |
| **A spoken turn.** "Ivan, …" is heard, routed, answered and spoken; a long answer is spoken as its first sentence and asks "Would you like to see it?" | ☐ | ☐ | ☐ |
| **Showing.** "Yes" and "show me" switch to the vendor's tab and raise its window; with no tab open, "No Notion tab is open." and nothing opens | ☐ | ☐ | ☐ |
| **System voices.** Step 4's list plays each voice at the set pace. On a Mac it lists Samantha, Fred, Daniel and Moira | ☐ | ☐ | ☐ |
| **Kokoro.** Step 5 downloads with a moving percentage and verifies; answers are spoken in Kokoro; with WebGPU off, the system voices take over | ☐ | ☐ | ☐ |
| **The side panel.** Opens from the icon and the shortcut, survives a click elsewhere, and nothing clips with the panel on the left at about 320px | ☐ | ☐ | ☐ |
| **Sharing.** Share an assistant, import the file into a second profile, ask it something | ☐ | ☐ | ☐ |
| **Nothing leaves the machine.** With a network monitor running, a whole turn makes no connection; only setup's downloads do | ☐ | ☐ | ☐ |

What differs by system, so a difference is not mistaken for a fault:

- **Voices.** Windows offers its own voices (David, Zira and Mark on a US install). Linux offers
  eSpeak voices through speech-dispatcher, often with no language recorded, or none at all.
  Choosing a curated set for each is parked for a later release.
- **WebGPU,** which Kokoro needs, is not available on every Linux setup; the system voices are
  the expected result there.
- **ChromeOS** has no global shortcuts, so it is driven from the toolbar icon only.
