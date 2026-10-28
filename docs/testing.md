# Testing OpenPosse

Three layers, each catching what the one before it cannot.

| Layer | Run with | Where it runs | What it proves |
|---|---|---|---|
| Unit tests | `npm test` | every push and pull request (`ci.yml`) | the pure modules: routing, selectors, lassos, voices, weights, sharing |
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
the network. `test/fixtures/fixture-crm.json` is its assistant, Acme, as a shared-lasso file.

`dist-e2e/` is a development build with one difference: its manifest grants
`https://*.fixture.test/*`. A real build is granted a site by the person clicking Allow in
Chrome's dialog, which automation cannot reach. It is never loaded by hand and never shipped.

What they check:

- **Every extension page opens without an error.** Settings, the side panel, and the
  offscreen page that speaks, opened as a tab because Chrome's own offscreen document is not a page
  Playwright watches. It carries ONNX Runtime for Supertonic, so a load-time throw there would
  otherwise only show as a voice that never speaks.
- **Phonon is offered first and answers once installed, without WebGPU.** It needs no
  agreement; with stand-ins for its files in its cache, Settings says it is installed, names
  Phonon as the voice that answers in a browser with no WebGPU, and lists its voices.
- **Phonon's runtime starts from the package.** phonon-tts imports from `vendor/phonon/`, starts
  its worker, compiles its WebAssembly under the extension's CSP and reads files from `blob:`
  URLs, refusing only the stand-in files themselves. Real speech needs the real weights, which
  the test browser cannot fetch: that is a hand check.
- **Supertonic's download waits for its licence.** Download is disabled until "I agree" is
  ticked; ticking stores the agreement, unticking withdraws it, and the full licence it links to is
  in the package. Nothing is downloaded.
- **A shared assistant is added from Settings**, through the same box a person pastes into.
  The same file a second time says "You already have this one" and adds nothing. A newer version
  of it offers only Replace, which keeps the assistant's name, voice and colour, and asked
  directly, the worker refuses to add a second assistant for the site.
- **An out-of-date lasso says so:** when the page no longer has the button the lasso clicks,
  the turn says how old the lasso is and to lasso it again.
- **A typed question reaches the vendor and its answer comes back to the panel.**
- **With no vendor tab open, a turn says "No Fixture tab is open." and opens nothing.**
- **The vendor's tab title follows the turn:** `typing…`, `answering…`, then `done`. A turn that
  fails gives the tab its own title back, and a page that renames itself mid-turn keeps the new
  name.
- **The OpenPosse tab group** (`grouping.spec.mjs`), against Chrome's real `tabGroups` API: a
  question puts the vendor's tab in one orange group called OpenPosse, and the next keeps it
  there; a tab dragged out rejoins; a tab in a group of the user's own, or pinned, is left where
  it is and still answers; a grouped tab is asked rather than the one in front; a renamed group is
  left alone and the next tab gets a fresh one; a second window gets its own. These tests run a
  copy of the build that holds `tabGroups` from the start, standing in for Chrome's prompt; the
  shipped manifest keeps it optional. Onboarding's step is in `extension.spec.mjs`: it starts on,
  either answer ticks it, and leaving the Permissions task asks Chrome for exactly `tabGroups`.

**A test fails if any page logged an error**, extension pages included. That is the point of
the layer: a bundle that throws while it loads passes ESLint and every unit test, and has
shipped once that way.

What they do not reach: speech in either direction, Supertonic and Kokoro, real vendors, Chrome's Allow
dialog, the side panel's own frame (its page is opened as a tab), the global shortcut, and
registering the vendor script ahead of a turn – the manifest grant skips registration, and
turns inject the script when they need it.

## The checklist

Run before a release on each system the release supports. Chromium, which the browser tests
use, has no on-device speech recognition, so the voice half of the product is only ever checked
here. Use Google Chrome, and a profile you do not mind changing.

**Never click Remove on an installed OpenPosse to load a different build** – it deletes the
assistants, the lassos and the downloaded voice. Load the new folder over it, or export each
assistant with Share first.

| Check | macOS | Windows | Linux |
|---|---|---|---|
| **Setup.** Load `dist/` unpacked into a profile without OpenPosse; Settings opens by itself with onboarding over it, on the welcome; the microphone grant and the speech-model download both complete in its tasks. Reloading the extension afterwards does not open it again | ☐ | ☐ | ☐ |
| **The shortcut.** The default (⌥V on a Mac, Ctrl+Shift+9 elsewhere) starts a turn with Chrome in front, and does nothing with it in the background; set to Global at `chrome://extensions/shortcuts`, it starts one with Chrome in the background too | ☐ | ☐ | ☐ |
| **Site access.** Record this tab on a real vendor: Chrome's dialog names the site, and after Allow, `await chrome.scripting.getRegisteredContentScripts()` in the service worker's console lists it | ☐ | ☐ | ☐ |
| **Recording.** Record a real assistant (Notion): the coaching ticks each step, the dry run passes, the assistant is named in Settings | ☐ | ☐ | ☐ |
| **A spoken turn.** "Ivan, …" is heard, routed, answered and spoken; a long answer is spoken as its first sentence and asks "Would you like to see it?" | ☐ | ☐ | ☐ |
| **Showing.** "Yes" and "show me" switch to the vendor's tab and raise its window; with no tab open, "No Notion tab is open." and nothing opens | ☐ | ☐ | ☐ |
| **Tab titles.** Asked from another tab, the vendor's tab reads `typing…`, `answering…`, then `done` before its title; clicking the tab or "show me" clears `done`, and left alone it clears within 90 s; asked from the vendor's own tab, `done` clears after about 5 s; reloading the extension mid-answer gives the tab its title back within about 90 s | ☐ | ☐ | ☐ |
| **System voices.** Step 4's list plays each voice at the set pace. On a Mac it lists Samantha, Fred, Daniel and Moira | ☐ | ☐ | ☐ |
| **Phonon.** Step 5 downloads 66 MB with a moving percentage and verifies, and Phonon becomes the voice even if Supertonic or Kokoro was chosen before; answers are spoken in Phonon, starting quickly; each of Harper, Miles, Maeve and Edwin plays from the voice list; prices, dates and an email address in the sample box are read out properly; with WebGPU off (`chrome://flags`, or a machine without it) Phonon still speaks; the console's first `spoke` line names the device it ran on | ☐ | ☐ | ☐ |
| **Kokoro.** Step 5 downloads with a moving percentage and verifies; answers are spoken in Kokoro; with WebGPU off, the system voices take over | ☐ | ☐ | ☐ |
| **An update keeps Kokoro.** On an install with only Kokoro downloaded, answers are still spoken in Kokoro after loading the new build | ☐ | ☐ | ☐ |
| **Supertonic.** Its Download stays disabled until "I agree" is ticked; it downloads 401 MB with a moving percentage and verifies; answers are spoken in Supertonic; with Kokoro too, "Which one speaks" switches between them; unticking "I agree", or removing Supertonic, returns answers to Kokoro | ☐ | ☐ | ☐ |
| **Another language.** With Supertonic answering, choose German under the pace; a German sentence in the sample box is read in German, and a German question typed to an assistant is answered and read in German | ☐ | ☐ | ☐ |
| **The side panel.** Opens from the icon and the shortcut, survives a click elsewhere, and nothing clips with the panel on the left at about 320px | ☐ | ☐ | ☐ |
| **Sharing.** Share an assistant, import the file into a second profile, ask it something; importing it again says "You already have this one"; a copy with one selector changed offers only Replace, and Replace keeps the assistant's voice; Record this tab on a site that already has an assistant re-records it and says so | ☐ | ☐ | ☐ |
| **Lassos from openposse.org.** In Settings, the cloud button lists the lassos on openposse.org (no Acme AI), with the sites you already have an assistant on greyed and marked; picking one fills the box and its preview, Add asks Chrome for that site, and it answers. Chrome's network panel shows nothing sent to openposse.org before the button is pressed | ☐ | ☐ | ☐ |
| **The tab group.** Welcome card or Settings switch: Chrome asks "View and manage your tab groups" and nothing else; updating from a build without grouping keeps the extension enabled with no new prompt. Then: two assistants share one OpenPosse group; a second window gets its own; ungroup a tab by hand and ask, it rejoins; rename the group, it is left alone; restart Chrome and ask, the same group is used; a pinned tab stays pinned; a tab in your own group stays there; collapse the group and "show me" opens it; Settings off ungroups and closes nothing; deleting an assistant ungroups its tab only when no other assistant uses it | ☐ | ☐ | ☐ |
| **Nothing leaves the machine.** With a network monitor running, a whole turn makes no connection; only setup's downloads do | ☐ | ☐ | ☐ |

What differs by system, so a difference is not mistaken for a fault:

- **Voices.** Windows offers its own voices (David, Zira and Mark on a US install). Linux offers
  eSpeak voices through speech-dispatcher, often with no language recorded, or none at all.
  Choosing a curated set for each is parked for a later release.
- **WebGPU,** which Supertonic and Kokoro both need, is not available on every Linux setup;
  Phonon on the processor, or the system voices, are the expected result there.
- **ChromeOS** has no global shortcuts, so it is driven from the toolbar icon only.
