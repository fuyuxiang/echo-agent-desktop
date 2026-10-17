import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Read only the graphical session flags, never account details or pixels.
export function readNativeReviewSession() {
  const script = 'ObjC.import("CoreGraphics"); var reviewSession = ObjC.deepUnwrap(ObjC.castRefToObject($.CGSessionCopyCurrentDictionary())); JSON.stringify({ screenLocked: reviewSession.CGSSessionScreenIsLocked === true, onConsole: reviewSession.kCGSSessionOnConsoleKey === true, loginDone: reviewSession.kCGSessionLoginDoneKey === true });';
  return JSON.parse(execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8', timeout: 3000 }));
}

export function assertNativeReviewSessionUnlocked(readSession = readNativeReviewSession) {
  const session = readSession();
  assert(session?.screenLocked === false && session.onConsole === true && session.loginDone === true,
    'Native UI acceptance requires an unlocked macOS console session; no application was launched. Unlock locally and retry.');
}

export function activateNativeReviewWindow(pid) {
  assert(Number.isSafeInteger(pid) && pid > 1, 'Only the runner-owned application PID may be activated');
  const script = `ObjC.import("AppKit"); var reviewOwner = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); Boolean(reviewOwner && typeof reviewOwner.activateWithOptions === "function" && reviewOwner.activateWithOptions(3));`;
  try {
    return execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { encoding: 'utf8', timeout: 3000 }).trim() === 'true';
  } catch { return false; }
}
