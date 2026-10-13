// The beta build's version is what the store judges every upload by. It refuses one that is not
// higher than the last, so a numbering mistake does not fail here: it fails in the store, on
// the next merge, as an upload refused for a reason three steps away from the cause.

import test from 'node:test';
import assert from 'node:assert/strict';
import { betaManifest, MAX_PART } from '../tools/beta.mjs';

const store = {
  name: 'OpenPosse',
  version: '0.3.1',
  action: { default_title: 'OpenPosse', default_popup: 'popup.html' },
  permissions: ['storage'],
};

test('a beta is named, numbered and titled as the beta item', () => {
  const beta = betaManifest(store, '12');
  assert.equal(beta.name, 'OpenPosse Beta');
  assert.equal(beta.version, '0.3.1.12');
  assert.equal(beta.version_name, '0.3.1 beta 12');
  assert.equal(beta.action.default_title, 'OpenPosse Beta');
  // Everything else is the store build, untouched.
  assert.equal(beta.action.default_popup, 'popup.html');
  assert.deepEqual(beta.permissions, ['storage']);
  assert.equal(store.name, 'OpenPosse', 'the store manifest itself is not changed');
});

test('0 is a build number: it is the package uploaded by hand to create the item', () => {
  assert.equal(betaManifest(store, '0').version, '0.3.1.0');
  assert.equal(betaManifest(store, 0).version, '0.3.1.0');
});

test('a missing or malformed build number stops the build instead of reusing a version', () => {
  for (const bad of [undefined, '', ' ', '-1', '1.5', 'twelve', String(MAX_PART + 1)]) {
    assert.throws(() => betaManifest(store, bad), /BETA_BUILD must be a whole number/, `"${bad}"`);
  }
  assert.equal(betaManifest(store, String(MAX_PART)).version, `0.3.1.${MAX_PART}`);
});

test('every beta of the next release sorts after every beta of this one', () => {
  // Chrome compares versions part by part as numbers, which is what makes the fourth part safe.
  const parts = (v) => v.split('.').map(Number);
  const newer = (a, b) => {
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < 4; i += 1) if (x[i] !== y[i]) return x[i] > y[i];
    return false;
  };
  const late = betaManifest(store, String(MAX_PART)).version;
  const early = betaManifest({ ...store, version: '0.3.2' }, '1').version;
  assert.ok(newer(early, late), `${early} should sort after ${late}`);
  assert.ok(newer(betaManifest(store, '10').version, betaManifest(store, '9').version));
});

test('a release version that is already four parts long is refused', () => {
  assert.throws(() => betaManifest({ ...store, version: '0.3.1.4' }, '1'), /three-part release version/);
});
