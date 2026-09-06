// Tests for the generated-id heuristic. Run with `npm test` in `extension/`.
//
// Plain `node --test`, no framework: this is one pure function, and the DOM-touching parts of
// `selector.js` are exercised by the recorder against real pages. What needs pinning here is
// the judgement call — which ids are framework noise — because being wrong in either direction
// is expensive and neither shows up as an error.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isGeneratedID } from '../src/selector.js';

test('React useId values are rejected', () => {
  // The one that started this: Notion's composer recorded as `#\:rim\:` on the first real
  // capture. It resolves during the dry run and is gone by the next page load.
  for (const id of [':rim:', ':r0:', ':r1a:', 'radix-:r3:']) {
    assert.equal(isGeneratedID(id), true, `${id} should be rejected`);
  }
});

test('Framework counters are rejected', () => {
  for (const id of ['mui-1', 'cdk-overlay-0', 'ng-1', 'headlessui-menu-3',
                    'react-aria-12', 'downshift-0', 'chakra-modal-4', 'mantine-7']) {
    assert.equal(isGeneratedID(id), true, `${id} should be rejected`);
  }
});

test('Bare counters and UUIDs are rejected', () => {
  assert.equal(isGeneratedID('12345'), true);
  assert.equal(isGeneratedID('3f2504e0-4f89-11d3-9a0c-0305e82c3301'), true);
});

test('Author-written ids are kept', () => {
  // The other half of the trade. Rejecting one of these would push a perfectly good selector
  // down to a structural path — which is the *fragile* case, so over-eagerness is not free.
  for (const id of ['message', 'chat-input', 'ea-assistant-input', 'composer',
                    'app', 'main-content', 'search_box', 'assistantPanel',
                    // Digits are fine when they are not the whole identity, and a framework
                    // name without a trailing counter is a real word someone chose.
                    'chat-input-2', 'ng-container-title', 'aria-described-panel']) {
    assert.equal(isGeneratedID(id), false, `${id} should be kept`);
  }
});
