import { afterEach, describe, expect, it } from "vitest";
import { isGlobalShortcutBlocked } from "../keyboard-scope";

afterEach(() => {
  document.body.replaceChildren();
});

describe("isGlobalShortcutBlocked", () => {
  it("任何 dialog 存在时屏蔽全局快捷键", () => {
    expect(isGlobalShortcutBlocked()).toBe(false);
    const dialog = document.createElement("section");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    expect(isGlobalShortcutBlocked()).toBe(true);
  });

  it("危险确认 alertdialog 存在时同样屏蔽全局快捷键", () => {
    const dialog = document.createElement("section");
    dialog.setAttribute("role", "alertdialog");
    document.body.appendChild(dialog);
    expect(isGlobalShortcutBlocked()).toBe(true);
  });
});
