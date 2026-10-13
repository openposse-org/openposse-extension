// The theme's two decisions that need no page: what a stored choice and the system come to, and
// whether a T was typing or the shortcut.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme, isTyping } from '../src/theme.js';

test('a stored choice wins over the system', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});

test('with no choice, or a value nobody wrote, the system decides', () => {
  for (const stored of [null, undefined, '', 'system', 'Light']) {
    assert.equal(resolveTheme(stored, true), 'dark');
    assert.equal(resolveTheme(stored, false), 'light');
  }
});

test('T in a field is typing, T anywhere else is the shortcut', () => {
  assert.equal(isTyping({ tagName: 'INPUT' }), true);
  assert.equal(isTyping({ tagName: 'textarea' }), true);
  assert.equal(isTyping({ tagName: 'SELECT' }), true);
  assert.equal(isTyping({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isTyping({ tagName: 'BUTTON' }), false);
  assert.equal(isTyping({ tagName: 'BODY' }), false);
  assert.equal(isTyping(null), false);
});
