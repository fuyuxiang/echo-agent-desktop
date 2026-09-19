/** Global application shortcuts must never mutate content behind a dialog or
 *  a context menu, otherwise the menu loses focus and the palette steals the
 *  keystroke.
 */
export function isGlobalShortcutBlocked(): boolean {
  if (document.querySelector('[role="dialog"], [role="alertdialog"]')) {
    return true;
  }
  if (document.querySelector('[role="menu"], .context-menu')) {
    return true;
  }
  return false;
}
