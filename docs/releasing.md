# Releasing

OpenPosse reaches people through two Chrome Web Store items:

| Item | Who sees it | Updated |
|---|---|---|
| **OpenPosse Beta** | trusted testers only | on every merge to `main`, by `.github/workflows/beta.yml` |
| **OpenPosse** | everyone | not set up yet |

Version numbers, the changelog and GitHub releases come from **release-please**. After every merge
to `main` it keeps one release pull request up to date; merging that pull request bumps the
version in `package.json`, `package-lock.json` and `src/manifest.json`, tags the commit and
publishes a GitHub release, with the store zip (`openposse-<version>.zip`, built from the tag
and checked by `tools/check-zip.sh`) attached to it. Pull request titles become the changelog, so write them as
Conventional Commits (`feat: …`, `fix: …`); `docs:`, `chore:`, `test:`, `build:` and `ci:` are
left out of it.

Until 1.0 every release is a patch: `feat:` and `fix:` both give 0.9.1, 0.9.2 and so on, and a
breaking change (`feat!:`) gives the next minor, never 1.0.0. That is set by
`bump-patch-for-minor-pre-major` and `bump-minor-pre-major` in `release-please-config.json`.
1.0 happens only when asked for: merge a commit whose body has the line `Release-As: 1.0.0`.

## How a beta reaches testers

1. A pull request merges into `main`.
2. `beta.yml` runs the tests again, builds `openposse-beta.zip` and checks it.
3. The beta is numbered `<release>.<run>`: the 12th run on 0.3.1 sends **0.3.1.12**, shown in
   Chrome as "0.3.1 beta 12". The store refuses a version that is not higher than the last, and
   the fourth number is what lets every merge send one. See `tools/beta.mjs`.
4. The workflow signs in to Google without a stored key (below) and runs `tools/cws.mjs`, which:
   - **sends nothing if an earlier beta is still in review**, and says which version is waiting.
     Replacing it would cancel that review, and with merges landing faster than reviews finish,
     no beta would ever get through. The next merge, or a manual run, sends whatever is newest.
   - otherwise uploads the zip and submits it for review.
5. The store reviews it, which takes hours to days, then publishes it to testers by itself.

Each run's summary page says what happened, in one line. A refused upload is reported in the
store's own words.

**Running a beta by hand:** Actions → Beta → Run workflow, on `main`. **Re-running** an old run
does not work: it keeps its run number, so it sends a version the store already has. Start a new
run instead.

**From any branch but `main` the run is refused at sign-in.** Google Cloud trusts this repository's
`main` branch and nothing else, so a branch cannot publish.

## One-time setup

Done once, by whoever owns the OpenPosse Google account. The order matters only where a step
needs something from an earlier one.

### 1. Google Cloud: a service account GitHub can act as, with no key

The store API accepts a Google Cloud service account. Instead of storing that account's key in
GitHub, Google Cloud is told to trust GitHub's signed statement that a run comes from this
repository's `main` branch (workload identity federation). Nothing secret is kept anywhere.

With the [gcloud CLI](https://cloud.google.com/sdk/docs/install) installed, one command at a time:

```bash
gcloud auth login
gcloud projects create openposse-publish --name="OpenPosse publishing"
gcloud config set project openposse-publish
gcloud services enable chromewebstore.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com
gcloud iam service-accounts create cws-publisher --display-name="Chrome Web Store publisher"
```

**Owning the project is not enough for the next step.** The Owner role does not include
`iam.workloadIdentityPools.create`, so creating the pool is refused with `PERMISSION_DENIED` and
"(or it may not exist)", which reads like an API that has not finished switching on. It is not.
Grant yourself the role that has it first:

```bash
gcloud projects add-iam-policy-binding "$(gcloud config get-value project)" --member="user:$(gcloud config get-value account)" --role="roles/iam.workloadIdentityPoolAdmin" --condition=None
```

Then the pool, and a provider that trusts this repository's `main` branch only. The condition uses
the numeric IDs of the organisation (341850675) and the repository (1416647671), which never
change, rather than names, which a renamed or re-created repository could take over:

```bash
gcloud iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
gcloud iam workload-identity-pools providers create-oidc openposse-extension --location=global --workload-identity-pool=github --display-name="openposse-extension" --issuer-uri="https://token.actions.githubusercontent.com" --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref" --attribute-condition="assertion.repository_owner_id=='341850675' && assertion.repository_id=='1416647671' && assertion.ref=='refs/heads/main'"
gcloud iam service-accounts add-iam-policy-binding "cws-publisher@$(gcloud config get-value project).iam.gserviceaccount.com" --role=roles/iam.workloadIdentityUser --member="principalSet://iam.googleapis.com/projects/$(gcloud projects describe "$(gcloud config get-value project)" --format='value(projectNumber)')/locations/global/workloadIdentityPools/github/attribute.repository_id/1416647671"
```

### 2. The developer account

1. Register at the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole)
   with the OpenPosse Google account. There is a one-time fee.
2. In **Account**, add the service account `cws-publisher@openposse-publish.iam.gserviceaccount.com`.
   The store allows one service account per publisher.

### 3. The beta item

The API cannot create an item, and cannot fill in its listing, so the first package goes up by hand.

1. Build it, then put the development build back, because packaging overwrites `dist/` with a
   build that has no `key` (loading that instead would give the unpacked extension a new ID):

   ```bash
   BETA_BUILD=0 npm run package:beta
   npm run build
   ```

2. In the dashboard, **New item** → upload `openposse-beta.zip`. Note the item's ID.
3. **Store listing:** fill it in from the listing below.
4. **Privacy:** fill it in with the answers below.
5. **Distribution:** visibility **Private**, then choose the testers.
6. Leave it unsubmitted. The workflow's first run uploads a newer build over it and submits that,
   which proves the whole path at once.

#### The store listing

The beta and the public item share this listing. The beta adds the opening paragraph marked
below, which comes out for the public listing.

**Summary:** the store takes it from the manifest's `description`: *Talk to the AI assistants
you already use. It listens, works out who you meant, and asks them.*

**Category:** Productivity, and Tools if the dashboard asks for a subcategory.

**Language:** English.

**Description:** the store shows it as plain text, so it is written without formatting. Paste
everything inside the block.

```text
This is the beta of OpenPosse, for testers. It updates more often than the public version, and
things may change between versions. If something doesn't work as you'd expect, please let us
know at https://github.com/openposse-org/openposse-extension/issues

OpenPosse lets you talk to the AI assistants you already use, such as Notion AI, by voice.

Give each assistant a name, then simply ask: "Ivan, summarise the Q3 planning page." OpenPosse
works out which assistant you meant, types your question into that assistant in the tab you
already have open, waits for the reply, and reads it back to you in that assistant's own voice.
A follow-up such as "and what about next quarter?" goes to whoever answered last.

PRIVATE BY DESIGN
• Speech recognition, choosing the right assistant, and the voices all run on your computer.
• There is no OpenPosse account, API key or server, and nothing you say is sent to us.
• Your question goes only to the assistant you address, just as if you had typed it there.

WORKS WITH THE TABS YOU ALREADY HAVE
• OpenPosse uses the assistant in the tab you're signed into, and never opens a site by itself.
• Say "show me" to bring that tab forward when you'd like to see the full answer.
• Site access is requested one site at a time, only when you add an assistant there.

SIMPLE TO SET UP
• Add an assistant by showing OpenPosse how you use it, once. A short guided recording does the
  rest, with no code or configuration.
• Share an assistant with a colleague as a small file.
• Type your question instead of speaking whenever that suits you better.

NATURAL VOICES
• Use your computer's own voices, or download a neural voice once from Settings:
  – Supertonic: fast and natural, and able to read answers in 31 languages. Its licence
    includes use restrictions, which you agree to before downloading.
  – Kokoro: natural English, with no use restrictions.
• Every download is checked against a fingerprint built into OpenPosse before it is used.

GETTING STARTED
1. After installing, Settings opens with three short setup tasks. Allow the microphone and
   download the speech model.
2. Open the tab with your assistant, open OpenPosse from the toolbar, and choose Record this tab.
3. Press the shortcut (⌥V on a Mac, Ctrl+Shift+9 elsewhere, or any keys you choose) and talk.

Requires Chrome 139 or later. The neural voices need WebGPU; without it, your computer's own
voices are used. OpenPosse listens in English for now.

OpenPosse is open source, under the Apache-2.0 licence:
https://github.com/openposse-org/openposse-extension

Privacy policy:
https://github.com/openposse-org/openposse-extension/blob/main/PRIVACY.md
```

**Icon:** `public/icons/icon-128.png`.

**Screenshots:** 1280×800, PNG or JPEG, up to five; the first one leads the listing. Take them
in a workspace with no real company content, since anything on screen is public once the item
is listed.

1. **An answer, beside its assistant.** The side panel showing an answer, with the assistant's
   page beside it. The whole product in one picture.
2. **Listening.** The side panel listening on an ordinary page, with the question appearing as it
   is heard.
3. **Adding an assistant.** The recording guide in the side panel, partway through, with steps
   ticked off.
4. **Your assistants.** The list in Settings, with each assistant's name and voice.
5. **Voices.** Settings' voice step, with Supertonic and Kokoro side by side.

If the dashboard asks for a small promo tile (440×280), there is not one yet.

#### Answers for the Privacy tab

**Single purpose:** Talk to the AI assistants you already use in your browser, by voice.
OpenPosse sends your spoken question to the assistant you name, in the tab you already have open,
and reads its answer aloud.

| Permission | Justification |
|---|---|
| `activeTab` | Starts a recording on the tab the user is on when they choose "Record this tab". |
| `offscreen` | Hosts the microphone, on-device speech recognition and speech synthesis in a hidden extension page, so listening carries on across tab switches. |
| `storage` | Keeps the user's assistants, their lassos and their settings on the device. |
| `tabs` | Finds the tab where the user's assistant is already open, so a question goes to that tab and "show me" can switch to it. |
| `scripting` | Registers and injects the script that types into the assistant and reads its answer, on sites the user has granted. |
| `sidePanel` | OpenPosse's main window, opened from the toolbar or the keyboard shortcut. |
| `favicon` (optional) | Shows the icons of the user's assistants' sites, when the user turns that setting on. |
| Host permissions (optional, `https://*/*`) | Requested for one site at a time, when the user adds an assistant on that site, and used only to type into that assistant and read its answer. |

**Remote code:** No. Everything that runs is in the package, ONNX Runtime included. The Supertonic
and Kokoro voice files downloaded from setup are model data, checked against SHA-256 hashes built
into the package, not code.

**Data usage:** OpenPosse sends nothing to its developers. Your question reaches the assistant you
address, which receives it as if you had typed it there. Which categories, if any, that puts on the
form is the account owner's call; tick the three certifications.

**Privacy policy:** https://github.com/openposse-org/openposse-extension/blob/main/PRIVACY.md

### 4. The repository variables

Settings → Secrets and variables → Actions → **Variables**. None of them is secret.

| Variable | Value |
|---|---|
| `CWS_PUBLISHER_ID` | the publisher ID, the long ID after `devconsole/` in the dashboard's address |
| `CWS_BETA_ITEM_ID` | the beta item's ID |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | the output of `gcloud iam workload-identity-pools providers describe openposse-extension --location=global --workload-identity-pool=github --format='value(name)'` |
| `GCP_SERVICE_ACCOUNT` | `cws-publisher@openposse-publish.iam.gserviceaccount.com` |

Until all four exist, the workflow says which are missing and sends nothing. Once they do, run it
by hand once (Actions → Beta → Run workflow) to send the first beta.
