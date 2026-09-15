import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/app.css"), "utf8");

describe("tool side panel layout contract", () => {
  it("keeps an expanded navigation wide enough for its selector and controls", () => {
    expect(css).toMatch(
      /\.tool-side-panel__nav:not\(\.tool-side-panel__nav--collapsed\)\s*\{[^}]*min-width:\s*140px;[^}]*max-width:\s*360px;/s,
    );
  });

  it("does not shrink icon buttons when the navigation becomes constrained", () => {
    expect(css).toMatch(
      /\.tool-side-panel__icon-btn\s*\{[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*flex:\s*0 0 28px;/s,
    );
  });
});
