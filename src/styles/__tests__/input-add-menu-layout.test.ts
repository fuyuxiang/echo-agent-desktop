import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appCss = readFileSync(resolve(process.cwd(), "src/styles/app.css"), "utf8");

describe("InputAddMenu layout contract", () => {
  it("keeps the primary and secondary menus at the same responsive width", () => {
    expect(appCss).toMatch(
      /\.iam-popover\s*\{[^}]*width:\s*280px;[^}]*max-width:\s*calc\(100vw - 16px\);/s,
    );
    expect(appCss).toMatch(
      /\.iam-submenu\s*\{[^}]*width:\s*280px;[^}]*max-width:\s*calc\(100vw - 16px\);/s,
    );
  });

  it("uses stable row dimensions and viewport-bounded submenu scrolling", () => {
    expect(appCss).toMatch(/\.iam-item\s*\{[^}]*height:\s*52px;/s);
    expect(appCss).toMatch(/\.iam-sub-item\s*\{[^}]*min-height:\s*48px;/s);
    expect(appCss).toMatch(
      /\.iam-submenu__scroll\s*\{[^}]*max-height:\s*min\(300px,\s*calc\(100vh - 28px\)\);/s,
    );
  });

  it("overrides the global focus ring with an inset menu focus treatment", () => {
    for (const selector of ["iam-item", "iam-sub-item", "iam-sub-footer"]) {
      expect(appCss).toMatch(
        new RegExp(`\\.${selector}:focus-visible\\s*\\{[^}]*outline:\\s*none;[^}]*box-shadow:\\s*inset`, "s"),
      );
    }
  });
});
