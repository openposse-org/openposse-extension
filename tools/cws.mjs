// Sends a package to a Chrome Web Store item and submits it for review, through the Chrome Web
// Store API v2. The beta workflow runs it on every merge to main; see docs/releasing.md.
//
//   CWS_PUBLISHER_ID=… CWS_ITEM_ID=… CWS_ACCESS_TOKEN=… node tools/cws.mjs openposse-beta.zip
//
// Three calls: the item's status, the upload, the submission. A submission still in review is
// left alone and the run says which version is waiting. Replacing it would cancel that review,
// and with merges landing faster than reviews finish, every review would be cancelled before it
// ended. The next run sends whatever is newest by then.
//
// The store's own error text is printed whole, because it is the only account of why an upload
// was refused. Nothing else is printed but versions and states, and the token never is.

import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API = 'https://chromewebstore.googleapis.com';

/** How long the store may take to process an upload before this gives up and says so. */
const UPLOAD_DEADLINE_MS = 120_000;
const UPLOAD_POLL_MS = 5_000;

/**
 * The submission waiting for review, as `{ version }` (null when the store does not say which
 * version), or null when nothing is waiting.
 */
export function pendingReview(status) {
  const submitted = status?.submittedItemRevisionStatus;
  if (submitted?.state !== 'PENDING_REVIEW') return null;
  return { version: submitted.distributionChannels?.[0]?.crxVersion || null };
}

/**
 * Where an upload stands: 'done', 'processing' or 'failed'. A state this does not know counts
 * as failed, and the caller names it, rather than being waited on until the deadline.
 */
export function uploadProgress(state) {
  if (state === 'SUCCEEDED') return 'done';
  // The API reference names IN_PROGRESS; the publishing guide's example says
  // UPLOAD_IN_PROGRESS. They mean the same thing, so either is treated as still working.
  if (state === 'IN_PROGRESS' || state === 'UPLOAD_IN_PROGRESS') return 'processing';
  return 'failed';
}

/**
 * One message for a call the store refused, in its own words: Google APIs answer with
 * `{ error: { code, status, message, details } }`, and the details are where a refused upload
 * says which rule it broke.
 */
export function describeFailure(step, httpStatus, body) {
  const error = typeof body === 'object' ? body?.error : null;
  const kind = error?.status ? `, ${error.status}` : '';
  const said = error?.message || (typeof body === 'string' && body.trim()) || 'the store gave no reason';
  const details = (error?.details ?? []).map((detail) => `\n  ${JSON.stringify(detail)}`).join('');
  return `${step} failed (HTTP ${httpStatus}${kind}): ${said}${details}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(step, method, url, { token, body, contentType }) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(contentType && { 'content-type': contentType }) },
      body,
    });
  } catch (error) {
    throw new Error(`${step} failed: the Chrome Web Store could not be reached (${error.cause?.code ?? error.message})`);
  }
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // Not JSON – an HTML error page from a proxy, say. Kept as text so the message quotes it.
    parsed = text;
  }
  if (!response.ok) throw new Error(describeFailure(step, response.status, parsed));
  return parsed;
}

/** A line for the log, the run's summary page and, as a notice, the run's annotations. */
async function report(line, level = 'notice') {
  console.log(`::${level}::${line}`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

async function main() {
  const [zipPath] = process.argv.slice(2);
  const env = {
    CWS_PUBLISHER_ID: process.env.CWS_PUBLISHER_ID,
    CWS_ITEM_ID: process.env.CWS_ITEM_ID,
    CWS_ACCESS_TOKEN: process.env.CWS_ACCESS_TOKEN,
  };
  const missing = Object.keys(env).filter((key) => !env[key]);
  if (!zipPath) missing.unshift('the path of the zip to send');
  if (missing.length > 0) throw new Error(`nothing was sent: missing ${missing.join(', ')}`);

  const token = env.CWS_ACCESS_TOKEN;
  const item = `publishers/${env.CWS_PUBLISHER_ID}/items/${env.CWS_ITEM_ID}`;
  const fetchStatus = (step) => call(step, 'GET', `${API}/v2/${item}:fetchStatus`, { token });

  const status = await fetchStatus('Reading the item');
  if (status.takenDown) await report('The store has taken this item down; see the dashboard.', 'warning');
  if (status.warned) await report('The store has a warning on this item; see the dashboard.', 'warning');

  const waiting = pendingReview(status);
  if (waiting) {
    await report(
      `Nothing sent: ${waiting.version ?? 'an earlier version'} is still in review. ` +
        'The next merge, or a manual run, sends the newest build.',
    );
    return;
  }

  const zip = await readFile(zipPath);
  let upload = await call('Uploading the package', 'POST', `${API}/upload/v2/${item}:upload`, {
    token,
    body: zip,
    contentType: 'application/zip',
  });

  // A large package can be accepted before it is processed; the status call reports the end.
  const started = Date.now();
  let state = upload.uploadState;
  while (uploadProgress(state) === 'processing') {
    if (Date.now() - started > UPLOAD_DEADLINE_MS) {
      throw new Error(
        `the store was still processing the upload after ${UPLOAD_DEADLINE_MS / 1000} s; ` +
          'nothing was submitted, and the item in the dashboard shows where it got to',
      );
    }
    await sleep(UPLOAD_POLL_MS);
    state = (await fetchStatus('Checking the upload')).lastAsyncUploadState;
  }
  if (uploadProgress(state) === 'failed') {
    throw new Error(
      `the store did not accept the package (upload state ${state ?? 'missing'}, with no reason ` +
        'given in the response); the item in the dashboard shows why',
    );
  }

  const version = upload.crxVersion || 'the package';
  const submitted = await call('Submitting for review', 'POST', `${API}/v2/${item}:publish`, {
    token,
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
    contentType: 'application/json',
  });
  await report(`Submitted ${version} for review (store state: ${submitted.state ?? 'not reported'}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    await report(error.message, 'error').catch((summaryError) => {
      console.error(`::error::could not write the run summary either: ${summaryError.message}`);
    });
    process.exitCode = 1;
  });
}
