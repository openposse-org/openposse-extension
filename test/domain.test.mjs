// The pattern derived from a recorded page decides which sites the extension may read, so the
// cases that matter are the ones where a mistake **grants access** rather than failing.
//
// Ported from `Tests/OpenPosseSharedTests/` on the parked Swift side, and extended: the
// public-suffix cases are the reason this file exists, so they are enumerated rather than
// sampled.

import test from 'node:test';
import assert from 'node:assert/strict';
import { patternForHost, matchPattern } from '../src/domain.js';

test('an ordinary vendor host wildcards to its registrable domain', () => {
  // The case the whole thing is for: vendors put each customer on their own subdomain, so a
  // lasso pinned to one workspace would look broken the moment somebody switched.
  assert.equal(patternForHost('demo-au.leanix.net'), '*.leanix.net');
  assert.equal(patternForHost('acme.leanix.net'), '*.leanix.net');
  assert.equal(patternForHost('www.notion.so'), '*.notion.so');
  assert.equal(patternForHost('notion.so'), '*.notion.so');
});

test('a public suffix never becomes a pattern', () => {
  // `*.co.uk` is every commercial site in the United Kingdom. This is the failure the file
  // exists to prevent, and it has four shapes that all look like "last two labels".
  assert.equal(patternForHost('assistant.example.co.uk'), '*.example.co.uk');
  assert.equal(patternForHost('chat.acme.com.au'), '*.acme.com.au');
  assert.equal(patternForHost('ai.corp.co.jp'), '*.corp.co.jp');
  assert.equal(patternForHost('app.loja.com.br'), '*.loja.com.br');

  // And the suffix on its own is not a registrable domain at all, so it stays exact.
  assert.equal(patternForHost('co.uk'), 'co.uk');
  assert.equal(patternForHost('com.au'), 'com.au');
});

test('a two-letter TLD is what makes `co` special, not the word', () => {
  // `co.example.com` is an ordinary subdomain. Treating `co` as a suffix marker everywhere
  // would widen this to `*.example.com` — which is right by accident here and wrong in
  // general, so the rule is asserted rather than the outcome.
  assert.equal(patternForHost('co.example.com'), '*.example.com');
  // Three labels under a gTLD keep two, not three.
  assert.equal(patternForHost('a.b.example.com'), '*.example.com');
});

test('hosts with no registrable domain stay exact', () => {
  // A wildcard needs something to wildcard. `*.192.168` is meaningless and `*.localhost` would
  // be a pattern over every development server on the machine.
  assert.equal(patternForHost('192.168.1.10'), '192.168.1.10');
  assert.equal(patternForHost('127.0.0.1'), '127.0.0.1');
  assert.equal(patternForHost('::1'), '::1');
  assert.equal(patternForHost('[::1]'), '[::1]');
  assert.equal(patternForHost('localhost'), 'localhost');
  assert.equal(patternForHost('intranet'), 'intranet');
});

test('a host under an umbrella domain stays exact', () => {
  // `*.google.com` for Gemini would ask for Gmail, Docs and every other Google site.
  assert.equal(patternForHost('gemini.google.com'), 'gemini.google.com');
  assert.equal(patternForHost('Gemini.Google.com.'), 'gemini.google.com');
  assert.equal(patternForHost('copilot.microsoft.com'), 'copilot.microsoft.com');
  assert.equal(patternForHost('google.com'), 'google.com');
  // Only the domain itself counts, not a name that ends the same way.
  assert.equal(patternForHost('chat.notgoogle.com'), '*.notgoogle.com');
});

test('a number-shaped host that is not an IP is still a host', () => {
  // Four numeric labels are an IP; three are not, and `1.2.3` must not be mistaken for one.
  // 999 is out of range, so this is a (very odd) hostname rather than an address.
  assert.equal(patternForHost('1.2.3'), '*.2.3');
  assert.equal(patternForHost('999.1.1.1'), '*.1.1');
});

test('input is normalised before it is trusted', () => {
  assert.equal(patternForHost('WWW.Notion.SO'), '*.notion.so');
  assert.equal(patternForHost('notion.so.'), '*.notion.so');
  assert.equal(patternForHost(''), '');
  assert.equal(patternForHost(null), '');
  assert.equal(patternForHost(undefined), '');
});

test('there is one match pattern, and it round-trips what was derived', () => {
  // The three consumers — the permission request, the script registration and the tab query —
  // must build the same string. Them disagreeing means granted for one, registered for
  // another, injected never, with nothing reporting a problem.
  assert.equal(matchPattern('*.notion.so'), 'https://*.notion.so/*');
  assert.equal(matchPattern('localhost'), 'https://localhost/*');
  assert.equal(matchPattern(patternForHost('demo-au.leanix.net')), 'https://*.leanix.net/*');
});
