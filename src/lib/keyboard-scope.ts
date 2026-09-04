/** Global application shortcuts must never mutate content behind a dialog. */
export function isGlobalShortcutBlocked(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}
