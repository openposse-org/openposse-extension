# Lasso identity and revisions

**Status:** Implemented in the extension, 2026-10-16 (§3 to §6; §7 on 2026-10-24; §5 is the website's) · **Decided:** lassos need an identity that survives leaving git, and a way to tell old from new (2026-10-16) · **Scope:** three optional fields in the shared file, replace-on-import in Settings, a date from the recorder; the website publishes the fields

## 1. Summary

A lasso has no identity outside the machine it was recorded on, and the shared file has a
version for its format but none for the lasso inside it. Sites change their pages, lassos get
re-recorded, and a person who imported an earlier one has no way to know. This spec adds:

| Field, in the envelope | What it is | Who sets it |
|---|---|---|
| `id` | The lineage: which assistant this is a lasso for, as a slug (`notion-ai`) | The publisher (the website); kept on import and written back on share |
| `recordedOn` | The day it was recorded, `YYYY-MM-DD` | The recorder, at save time |
| `hash` | The lasso's content, as 12 hex characters of SHA-256 over canonical JSON of `lasso` | Whoever writes the file: Settings on share, the website on publish; the same function in both |

With those, Settings can offer to replace an agent's lasso rather than add a second one, say
"you already have this one", and, when a turn fails on a selector, say which revision the person
has and that the site may have a newer one.

## 2. What exists today

- The extension stores a lasso under `lasso:<uuid>`, a UUID minted per install, and the roster
  entry points at it by `lassoID`. The same Notion lasso has a different id on every machine.
- The shared file is `{ format: "openposse.lasso", version: 1, name, lasso }` (`src/share.js`,
  `pack`/`unpack`). `version` is the format's. `unpack` reads only those four keys, keeps anything
  else, and accepts a higher `version` with a note, so optional fields can be added without a
  format bump.
- `lassos/` in this repo holds bare recordings (`agentName` plus the fields); its test packs each
  one and unpacks it. Git history is the only versioning the files have.
- The website's `/lassos/` index gives each entry an `id` (the product slug) and a `recordedOn`
  date (the source file's last commit), but neither is inside the file people download.
- Settings' import (`offer` in `src/setup.js`) previews the sentence and adds an agent; it does
  not look for an existing agent the file might be a newer version of.

## 3. The fields

### 3.1 `id`

A lower-case slug, `[a-z0-9-]+`, one per assistant lineage, chosen by the publisher. The website
derives it from the site's product (`notion.com` → `notion-ai`, `openposse.org` → `acme-ai`) and
refuses two source lassos for one product, so an `id` is unique on the site. A recording that
was never published has no `id`: Settings' share writes the field only when the agent carries
one, which it does from the day it was imported.

### 3.2 `recordedOn`

The date the recorder saved the lasso, written into the bare lasso at save time. In the shared
file it is an envelope field, so `pack` lifts it out of the lasso object and `unpack` reads it
from the envelope. The website prefers the file's own date and falls back to the source file's
commit date for recordings made before this.

### 3.3 `hash`

`sha256(canonical(lasso))`, first 12 hex characters, where canonical JSON has keys sorted at
every depth and no whitespace. Only `lasso` is hashed: the name, the id and the date are not
part of the content, so renaming Ivan or re-publishing on another day does not change the hash,
while one changed selector does. Machine-only fields are excluded by construction, because `pack`
never puts them in `lasso`. One exported function, `hashOf(lasso)`, lives in `share.js`; the
website's sync mirrors it exactly (the test in §6 pins the value for a fixture).

### 3.4 The format version stays 1

Adding optional envelope fields is compatible: `unpack` already keeps unknown fields and accepts
newer versions. `version` is bumped only when a file written today would be misread by an older
importer.

## 4. Behaviour

### 4.1 Share

`pack` writes `id`, `recordedOn` and `hash` when the agent has them, `hash` always. The
downloaded file is the same file the website would publish for that lasso, byte for byte, when
the lasso is the same.

### 4.2 Import

**One site, one assistant** (the user's rule, 2026-10-16). A site never has two lassos, so a
lasso for a site that already has an assistant can only replace that assistant's lasso.

`unpack` returns the three fields alongside `name` and `lasso`. Before adding, Settings looks
for the agent whose lasso is for the same site, whatever either is called. Failing that, it
looks for one with the same `id`, which finds an assistant whose site has moved (Notion's did, to
`app.notion.com`). Then:

- Same `hash`: "You already have this one, as Ivan." Nothing to add.
- Different `hash`: "Ivan already has a lasso for notion.com, recorded 1 October. Replace it with
  this one, recorded 16 October?" with **Replace** as the only button. Replace swaps the lasso
  and the lineage; the agent keeps its name, voice, colour and position.
- No match: added as today. The agent stores `origin: { id }` from the file.

The worker enforces the same rule, so no sender can add a second assistant for a site, or replace
a different one than the match.

**Recording** follows it too: "Record this tab" on a site that already has an assistant
re-records that assistant, and says so when it is done: "Ivan already worked on this site, so
this recording replaced Ivan's lasso."

An install from before this rule may already hold two assistants for one site. Nothing merges
them; matching takes the first, and deleting the other in Settings is the person's call.

**As built, each fact is stored once.**
- **The date lives in the stored lasso,** where the recorder writes it too, and `pack` lifts it
  into the envelope.
- **The hash is always computed, never stored.** A stored copy would go stale on the first
  re-record, and a file's own `hash` is a stranger's claim: `unpack` ignores it, and `hashOf`
  decides "same" and "different".
- **The agent keeps only the lineage, `origin.id`.** It keeps it across a re-record, since the
  lasso is still for that assistant.

The preview sentence gains the date: "…, recorded 16 October 2026".

### 4.3 Staleness

When a turn fails because the lasso's open or input selector matched nothing, the panel's
message names what the person has: "Ivan's lasso is from 1 October and Notion's page has
changed. There may be a newer one on openposse.org/lassos." for an imported agent, and "…Record
it again from Settings." for a local recording. Text only, no network.

As built, this applies to lassos that open the assistant by click: the button it clicks is
missing, or the box that should appear after the click. A lasso that opens by shortcut keeps its
own message, because a shortcut that opens nothing usually means the page ignores synthetic keys,
not that it changed. A lasso with no date says it "no longer matches" the page.

### 4.4 Fetching from the domain (still parked)

The parked "get one from the site" button, when it ships behind the privacy policy change, can
compare the site's index with the roster by `id` and `hash` and list "newer available". The
fields make that a comparison rather than a guess; nothing else here depends on it.

### 4.5 The recorder

Writes `recordedOn` into the bare lasso at save time. Nothing else changes in the recorder.

## 5. The website

Done on the website after this spec lands: the sync computes `hash` with the mirrored function,
sets `id` and `recordedOn`, writes them into the published envelope and into the index, and the
lassos page shows the revision next to the date. The published file for a lasso is then
identical to what Settings would share for it.

## 6. Tests

- `test/share.test.mjs`: `hashOf` is stable under key order and whitespace, changes on one
  selector, ignores name and date; a fixture's hash is pinned to a literal so the website's mirror
  can assert the same value; `pack` lifts `recordedOn` into the envelope and `unpack` returns the
  three fields; a file without them still imports.
- `test/e2e/extension.spec.mjs`: importing a file with the same `id` and a different hash offers
  Replace; the same hash says "already have"; Replace keeps the agent's name and voice.
- The recorder's test: a saved lasso carries today's `recordedOn`.

## 7. One shape in `lassos/` (done 2026-10-24)

Done: `lassos/` now holds shared files with the website's ids (`notion-ai`, `acme-ai`), and
the test unpacks them directly and checks each stored hash. What follows is the reasoning.

Before this, `lassos/` held bare recordings and Settings refuses a bare file, so a file copied from
GitHub cannot be pasted. Storing the shared file in `lassos/` instead, with the test unpacking it
directly rather than packing first, makes the repo's files usable as they are and gives them an
`id`, a date and a hash in the open. The bare shape stays the extension's internal storage only.
Independent of §3 to §6; worth doing with them.

## 8. Open questions

Answered 2026-10-16:

1. ~~**A recording shared before it was ever published.**~~ It carries no `id`. Import matches it
   by its site and name, and only the website hands out ids.
2. ~~**The default button.**~~ Replace is the only button: one site has one assistant, so there
   is no "Add as another assistant". The assistant keeps its name, voice, colour and place.
3. ~~**Naming the website in the staleness message.**~~ Yes, for imported assistants, as plain
   text.
