import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appCss = readFileSync(resolve(process.cwd(), "src/styles/app.css"), "utf8");

describe("settings content scrolling contract", () => {
  it("keeps the token usage page vertically scrollable inside the bounded modal", () => {
    expect(appCss).toMatch(
      /\.quota-panel\s*\{[^}]*min-height:\s*0;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;[^}]*scrollbar-gutter:\s*stable;/s,
    );
  });

  it("keeps token usage actions available while scrolling long content", () => {
    expect(appCss).toMatch(
      /\.quota-panel__head\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:\s*1;/s,
    );
  });
});
