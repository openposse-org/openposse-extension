# OpenPosse privacy policy

Effective 28 October 2026. This covers the OpenPosse extension and OpenPosse Beta.

**In short:** OpenPosse has no servers. It collects nothing, sends nothing to its developers, and
keeps no record of what you say.

## When you talk to an assistant

- **Your voice becomes text on your computer.** OpenPosse uses Chrome's on-device speech
  recognition and requires it: if Chrome cannot recognise speech on the device, OpenPosse stops
  with an error rather than letting an online service do it. Audio is not recorded or kept.
- **Working out which assistant you meant happens on your computer.**
- **Your question goes to the assistant you named, and only there.** OpenPosse types it into that
  assistant in the browser tab you already have open, and reads the answer back from the page.
  The assistant's service, Notion AI for example, receives your question exactly as if you had
  typed it yourself, and that service's own privacy policy covers it.
- **The answer is spoken by a voice on your computer**: the Phonon, Supertonic or Kokoro voice, or one of
  your system's built-in voices. Voices that would send text to an online service are never used.
- **Questions and answers are not saved.** They stay on screen until your next question. They are
  not logged, stored or sent anywhere else.

## What is stored on your computer

In Chrome's storage for the extension, on your computer only:

- **Your assistants**: the names you gave them, their voices and colours, and each one's lasso,
  meaning which site it is on and which buttons and boxes to use. A lasso contains nothing from
  your conversations.
- **Your settings**, such as speaking pace, the language answers are read in, and appearance.
- **Whether you agreed to the Supertonic voice's licence**, which version, and when.
- **The addresses of the sites your assistants are on**, to show their icons if you turn site
  icons on. Chrome supplies those icons from its own cache; OpenPosse does not download them.
- **The Phonon, Supertonic and Kokoro voice files**, if you download them.
- **Whether you answered the tab group question, and the ids of the OpenPosse tab groups**, if
  you turn grouping on, so the same group is used again.

Removing the extension deletes all of it.

## What goes over the network

- **The voice downloads, when you ask for them.** Pressing Download in setup fetches the
  Phonon, Supertonic or Kokoro voice files from Hugging Face (huggingface.co); Supertonic's only once you
  have agreed to its licence. Each file is checked against a fingerprint built into the extension
  before it is used, and one that does not match is thrown away. Hugging Face sees an ordinary
  download from your browser. This happens only when you press a button, and never while you are
  talking to an assistant. Your agreement to the licence is kept on your computer and sent
  nowhere.
- **The lassos list on openposse.org, when you ask for it.** Pressing "Get more from
  openposse.org" in Settings reads the list of shared AI assistants at
  `https://openposse.org/lassos/index.json`, and picking one reads that one file from beside it.
  Nothing about you or your assistants is sent, and no cookies go with it; openposse.org sees an
  ordinary request from your browser. A file is only shown if it matches the list, and it is added
  only when you press Add and allow its site, as with a file someone sends you.
- **Nothing else.** No analytics, no crash reports, no accounts and no advertising. OpenPosse has
  no server to send anything to.

Links on the Settings page, such as the website and GitHub, open in a tab when you click them,
like any other link.

## Access to websites

OpenPosse can read and change pages only on sites you allow, one site at a time, when you add an
assistant there. Chrome asks you each time. OpenPosse uses that access to type your question into
the assistant, press its send button, read its answer and show its listening indicator on that
page. It never reads, stores or sends passwords, cookies or what you type into forms.

While you record a new assistant, OpenPosse watches which controls you use on that tab so that it
can use them later. It does not record what you type.

## Tab groups

If you turn it on, OpenPosse keeps the tabs it talks to in a tab group called OpenPosse, one per
window. Chrome asks you first, in its words "View and manage your tab groups". OpenPosse uses that
only to put those tabs in its group, to find the group again, and to ungroup them when you turn it
off. It never opens or closes a tab, and leaves tabs in groups of your own where they are. A tab
group gives OpenPosse no access to a site: that is still asked for one site at a time.

## Sharing an assistant

Share makes a file that you choose to send to someone. It holds the assistant's name and lasso,
and nothing from your conversations.

## Changes

If any of this changes, this page will change first, with a new date.

## Questions

Open an issue at https://github.com/openposse-org/openposse-extension/issues.
