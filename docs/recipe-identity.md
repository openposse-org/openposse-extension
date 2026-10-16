# Recipe identity and revisions

**Status:** Draft 0.1, 2026-10-16 · **Decided:** recipes need an identity that survives leaving git, and a way to tell old from new (2026-10-16) · **Scope:** three optional fields in the shared file, replace-on-import in Settings, a date from the recorder; the website publishes the fields

## 1. Summary

A recipe has no identity outside the machine it was recorded on, and the shared file has a
version for its format but none for the recipe inside it. Sites change their pages, recipes get
re-recorded, and a person who imported an earlier one has no way to know. This spec adds:

| Field, in the envelope | What it is | Who sets it |
|---|---|---|
| `id` | The lineage: which assistant this is a recipe for, as a slug (`notion-ai`) | The publisher (the website); kept on import and written back on share |
| `recordedOn` | The day it was recorded, `YYYY-MM-DD` | The recorder, at save time |
| `hash` | The recipe's content, as 12 hex characters of SHA-256 over canonical JSON of `recipe` | Whoever writes the file: Settings on share, the website on publish; the same function in both |

With those, Settings can offer to replace an agent's recipe rather than add a second one, say
"you already have this one", and, when a turn fails on a selector, say which revision the person
has and that the site may have a newer one.

## 2. What exists today

- The extension stores a recipe under `recipe:<uuid>`, a UUID minted per install, and the roster
  entry points at it by `recipeID`. The same Notion recipe has a different id on every machine.
- The shared file is `{ format: "openposse.recipe", version: 1, name, recipe }` (`src/share.js`,
  `pack`/`unpack`). `version` is the format's. `unpack` reads only those four keys, keeps anything
  else, and accepts a higher `version` with a note, so optional fields can be added without a
  format bump.
- `recipes/` in this repo holds bare recordings (`agentName` plus the fields); its test packs each
  one and unpacks it. Git history is the only versioning the files have.
- The website's `/recipes/` index gives each entry an `id` (the product slug) and a `recordedOn`
  date (the source file's last commit), but neither is inside the file people download.
- Settings' import (`offer` in `src/setup.js`) previews the sentence and adds an agent; it does
  not look for an existing agent the file might be a newer version of.

## 3. The fields

### 3.1 `id`

A lower-case slug, `[a-z0-9-]+`, one per assistant lineage, chosen by the publisher. The website
derives it from the site's product (`notion.com` → `notion-ai`, `openposse.org` → `acme-ai`) and
refuses two source recipes for one product, so an `id` is unique on the site. A recording that
was never published has no `id`: Settings' share writes the field only when the agent carries
one, which it does from the day it was imported.

### 3.2 `recordedOn`

The date the recorder saved the recipe, written into the bare recipe at save time. In the shared
file it is an envelope field, so `pack` lifts it out of the recipe object and `unpack` reads it
from the envelope. The website prefers the file's own date and falls back to the source file's
commit date for recordings made before this.

### 3.3 `hash`

`sha256(canonical(recipe))`, first 12 hex characters, where canonical JSON has keys sorted at
every depth and no whitespace. Only `recipe` is hashed: the name, the id and the date are not
part of the content, so renaming Ivan or re-publishing on another day does not change the hash,
while one changed selector does. Machine-only fields are excluded by construction, because `pack`
never puts them in `recipe`. One exported function, `hashOf(recipe)`, lives in `share.js`; the
website's sync mirrors it exactly (the test in §6 pins the value for a fixture).

### 3.4 The format version stays 1

Adding optional envelope fields is compatible: `unpack` already keeps unknown fields and accepts
newer versions. `version` is bumped only when a file written today would be misread by an older
importer.

## 4. Behaviour

### 4.1 Share

`pack` writes `id`, `recordedOn` and `hash` when the agent has them, `hash` always. The
downloaded file is the same file the website would publish for that recipe, byte for byte, when
the recipe is the same.

### 4.2 Import

`unpack` returns the three fields alongside `name` and `recipe`. Before adding, Settings looks
for an agent with the same `id`; failing that, one whose recipe is for the same site and whose
name matches the file's. Then:

- Same `hash`: "You already have this one, as Ivan." Nothing to add.
- Different `hash`: "Ivan already has a recipe for notion.com, recorded 1 Oct. Replace it with
  this one, recorded 16 Oct?" with **Replace** and **Add as another assistant**. Replace swaps
  the recipe and the origin fields; the agent keeps its name, voice, colour and position.
- No match: added as today. The agent stores `origin: { id, recordedOn, hash }` from the file.

The preview sentence gains the date: "…, recorded 16 October 2026".

### 4.3 Staleness

When a turn fails because the recipe's open or input selector matched nothing, the panel's
message names what the person has: "Ivan's recipe is from 1 October and Notion's page has
changed. There may be a newer one on openposse.org/recipes." for an imported agent, and "…Record
it again from Settings." for a local recording. Text only, no network.

### 4.4 Fetching from the domain (still parked)

The parked "get one from the site" button, when it ships behind the privacy policy change, can
compare the site's index with the roster by `id` and `hash` and list "newer available". The
fields make that a comparison rather than a guess; nothing else here depends on it.

### 4.5 The recorder

Writes `recordedOn` into the bare recipe at save time. Nothing else changes in the recorder.

## 5. The website

Done on the website after this spec lands: the sync computes `hash` with the mirrored function,
sets `id` and `recordedOn`, writes them into the published envelope and into the index, and the
recipes page shows the revision next to the date. The published file for a recipe is then
identical to what Settings would share for it.

## 6. Tests

- `test/share.test.mjs`: `hashOf` is stable under key order and whitespace, changes on one
  selector, ignores name and date; a fixture's hash is pinned to a literal so the website's mirror
  can assert the same value; `pack` lifts `recordedOn` into the envelope and `unpack` returns the
  three fields; a file without them still imports.
- `test/e2e/extension.spec.mjs`: importing a file with the same `id` and a different hash offers
  Replace; the same hash says "already have"; Replace keeps the agent's name and voice.
- The recorder's test: a saved recipe carries today's `recordedOn`.

## 7. One shape in `recipes/` (recommended, separate PR)

Today `recipes/` holds bare recordings and Settings refuses a bare file, so a file copied from
GitHub cannot be pasted. Storing the shared file in `recipes/` instead, with the test unpacking it
directly rather than packing first, makes the repo's files usable as they are and gives them an
`id`, a date and a hash in the open. The bare shape stays the extension's internal storage only.
Independent of §3 to §6; worth doing with them.

## 8. Open questions

1. **A recording shared before it was ever published** has no `id`. Leave it without one, or
   derive a provisional `local-<domain-slug>` so two such files from two machines can still be
   told apart?
2. **The default button** when a match is found: Replace (most people are updating) or Add
   (never destructive)?
3. **Naming the website in the staleness message**: it is plain text and sends nothing, but it is
   the first place the product points at the site.
