import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertNativeReviewSessionUnlocked, activateNativeReviewWindow } from './lib/native-review-window.mjs';

test('locked or disconnected sessions cannot start real UI acceptance', () => {
  for (const session of [{ screenLocked: true, onConsole: true, loginDone: true },
    { screenLocked: false, onConsole: false, loginDone: true }, { screenLocked: false, onConsole: true, loginDone: false }, null, {}]) {
    assert.throws(() => assertNativeReviewSessionUnlocked(() => session), /unlocked macOS console/);
  }
});
test('an explicitly unlocked console session permits UI acceptance', () => {
  assert.doesNotThrow(() => assertNativeReviewSessionUnlocked(() => ({ screenLocked: false, onConsole: true, loginDone: true })));
});
test('window activation refuses an invalid or shell-bearing PID before any OS call', () => {
  for (const pid of [undefined, 0, 1, -1, 1.5, '123; arbitrary-command']) assert.throws(() => activateNativeReviewWindow(pid), /runner-owned/);
});
