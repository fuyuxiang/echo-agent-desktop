// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { applyFontSize, DEFAULT_FONT_SIZE, FONT_SIZE_KEY, normalizeFontSize, readFontSize, saveFontSize } from "../font-size";

describe("font size preference", () => {
  afterEach(() => {
    localStorage.removeItem(FONT_SIZE_KEY);
    document.documentElement.style.fontSize = "";
  });

  it("validates persisted values before applying them", () => {
    localStorage.setItem(FONT_SIZE_KEY, "not-a-number");
    expect(readFontSize()).toBe(DEFAULT_FONT_SIZE);
    expect(normalizeFontSize(99)).toBe(DEFAULT_FONT_SIZE);
    applyFontSize(readFontSize());
    expect(document.documentElement.style.fontSize).toBe("16px");
  });

  it("scales the root typography immediately and persists the selection", () => {
    saveFontSize(16);
    expect(readFontSize()).toBe(16);
    expect(document.documentElement.style.fontSize).toBe(`${(16 * 16) / 13}px`);
  });
});
