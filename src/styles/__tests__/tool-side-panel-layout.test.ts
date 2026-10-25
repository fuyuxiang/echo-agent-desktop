import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/app.css"), "utf8");
const details = readFileSync(resolve(process.cwd(), "src/styles/task-details.css"), "utf8");

describe("tool side panel layout contract", () => {
  it("lets a single list or preview fill the panel and lets preview content shrink inside its scroll viewport", () => {
    expect(details).toMatch(/\.task-details__content\s*\{[^}]*display:flex;[^}]*min-height:0;[^}]*min-width:0;/);
    expect(details).toMatch(/\.task-details__list\s*\{[^}]*flex:1;[^}]*overflow:auto;/);
    expect(details).toMatch(/\.task-details__body\s*\{[^}]*min-width:0;[^}]*overflow:auto;/);
  });

  it("keeps the panel actions large enough to target without allowing flex shrink", () => {
    expect(css).toMatch(/\.tool-side-panel__icon-btn\s*\{[^}]*width:\s*32px;[^}]*height:\s*32px;[^}]*flex:\s*0 0 32px;/s);
  });
});
