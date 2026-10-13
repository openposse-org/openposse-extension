// The decisions `tools/cws.mjs` makes on the store's answers. The calls themselves are not
// tested here: a fake store would only repeat what the code already assumes about the real one.
// The first beta run against the real store is that test.
//
// The response shapes below are the ones the Chrome Web Store API v2 reference documents for
// fetchStatus, upload and Google's standard error body. The wording of the sample error is made
// up; its shape is not.

import test from 'node:test';
import assert from 'node:assert/strict';
import { describeFailure, pendingReview, uploadProgress } from '../tools/cws.mjs';

test('a submission in review is reported with its version, so the run can say what is waiting', () => {
  const status = {
    submittedItemRevisionStatus: {
      state: 'PENDING_REVIEW',
      distributionChannels: [{ deployPercentage: 100, crxVersion: '0.3.1.11' }],
    },
  };
  assert.deepEqual(pendingReview(status), { version: '0.3.1.11' });
});

test('only a review in progress holds a run back', () => {
  for (const state of ['PUBLISHED', 'PUBLISHED_TO_TESTERS', 'STAGED', 'REJECTED', 'CANCELLED']) {
    assert.equal(pendingReview({ submittedItemRevisionStatus: { state } }), null, state);
  }
  // A new item, or one whose only version is live, has no submitted revision at all.
  assert.equal(pendingReview({ publishedItemRevisionStatus: { state: 'PUBLISHED' } }), null);
  assert.equal(pendingReview({}), null);
  assert.equal(pendingReview(undefined), null);
});

test('a review whose version the store leaves out still holds the run back', () => {
  const status = { submittedItemRevisionStatus: { state: 'PENDING_REVIEW' } };
  assert.deepEqual(pendingReview(status), { version: null });
});

test('an upload is done, still processing, or failed – and an unknown state is not waited on', () => {
  assert.equal(uploadProgress('SUCCEEDED'), 'done');
  assert.equal(uploadProgress('IN_PROGRESS'), 'processing');
  assert.equal(uploadProgress('UPLOAD_IN_PROGRESS'), 'processing');
  for (const state of ['FAILED', 'NOT_FOUND', 'UPLOAD_STATE_UNSPECIFIED', 'SOMETHING_NEW', undefined]) {
    assert.equal(uploadProgress(state), 'failed', String(state));
  }
});

test("a refused call is reported in the store's own words, details included", () => {
  const body = {
    error: {
      code: 400,
      status: 'INVALID_ARGUMENT',
      message: 'The version of the uploaded package must be higher than the published one.',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'VERSION_TOO_LOW' }],
    },
  };
  const message = describeFailure('Uploading the package', 400, body);
  assert.match(message, /^Uploading the package failed \(HTTP 400, INVALID_ARGUMENT\): The version/);
  assert.match(message, /VERSION_TOO_LOW/);
});

test('a body that is not JSON is quoted, and an empty one says so rather than saying nothing', () => {
  assert.equal(
    describeFailure('Reading the item', 502, 'Bad Gateway'),
    'Reading the item failed (HTTP 502): Bad Gateway',
  );
  assert.equal(
    describeFailure('Reading the item', 500, {}),
    'Reading the item failed (HTTP 500): the store gave no reason',
  );
});
