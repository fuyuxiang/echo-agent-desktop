import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/app.css"), "utf8");
const projectTabs = readFileSync(
  resolve(process.cwd(), "src/components/project-tabs.tsx"),
  "utf8",
);

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing CSS rule: ${selector}`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("}", start) + 1);
}

describe("project detail theme contract", () => {
  it("uses semantic surfaces for plan columns and cards", () => {
    const column = rule(".pd-board-col");
    const card = rule(".pd-board-card");

    expect(column).toContain("background: var(--echo-bg-secondary);");
    expect(column).toContain("border: 1px solid var(--echo-border-default);");
    expect(column).not.toContain("#f0f0f0");
    expect(card).toContain("background: var(--echo-bg-primary);");
    expect(card).toContain("border: 1px solid var(--echo-border-weak);");
  });

  it("keeps project primary controls legible in both themes", () => {
    for (const selector of [".pd-invite", ".pd-btn--primary", ".pd-pill--on", ".pd-composer__send"]) {
      const block = rule(selector);
      expect(block).toContain("background: var(--echo-button-primary-bg);");
      expect(block).toContain("color: var(--echo-button-primary-fg);");
    }

    expect(rule(".pd-composer__send:disabled")).toContain(
      "background: var(--echo-button-primary-bg-disabled);",
    );
  });

  it("uses theme-aware emphasis and status colours", () => {
    expect(rule(".pd-tab-btn--on")).toContain("border-bottom-color: var(--echo-brand);");
    expect(projectTabs).toContain('pending: "var(--echo-text-medium)"');
    expect(projectTabs).toContain('in_progress: "var(--echo-brand)"');
    expect(projectTabs).toContain('paused: "var(--echo-status-warning)"');
    expect(projectTabs).toContain('completed: "var(--echo-status-success)"');
  });

  it("preserves a visible interaction target for each column add action", () => {
    const add = rule(".pd-board-col__add");
    expect(add).toContain("width: 28px;");
    expect(add).toContain("height: 28px;");
    expect(rule(".pd-board-col__add:hover")).toContain("color: var(--echo-text-strong);");
  });
});
