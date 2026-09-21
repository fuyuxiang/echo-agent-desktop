import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/coding-workbench.css"), "utf8");

describe("coding workbench grid contract", () => {
  it("pins every workbench region to an explicit grid track", () => {
    expect(css).toMatch(/\.coding-workbench__topbar\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*grid-row:\s*1 \/ 2;/s);
    expect(css).toMatch(/\.coding-workbench__activity\s*\{[^}]*grid-column:\s*1 \/ 2;[^}]*grid-row:\s*2 \/ 4;/s);
    expect(css).toMatch(/\.coding-workbench__explorer\s*\{[^}]*grid-column:\s*2 \/ 3;[^}]*grid-row:\s*2 \/ 3;/s);
    expect(css).toMatch(/\.coding-workbench__vsplit--explorer\s*\{[^}]*grid-column:\s*3 \/ 4;/s);
    expect(css).toMatch(/\.coding-workbench__main\s*\{[^}]*grid-column:\s*4 \/ 5;[^}]*grid-row:\s*2 \/ 3;/s);
    expect(css).toMatch(/\.coding-workbench__vsplit--agent\s*\{[^}]*grid-column:\s*5 \/ 6;/s);
    expect(css).toMatch(/\.coding-workbench__agent\s*\{[^}]*grid-column:\s*6 \/ 7;[^}]*grid-row:\s*2 \/ 3;/s);
    expect(css).toMatch(/\.coding-bottom\s*\{[^}]*grid-column:\s*2 \/ -1;[^}]*grid-row:\s*3 \/ 4;/s);
    expect(css).toMatch(/\.coding-workbench__status\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*grid-row:\s*4 \/ 5;/s);
  });

  it("keeps execution cards at natural height and scrolls the transcript viewport", () => {
    expect(css).toMatch(
      /\.coding-agent__stream-shell\s*\{[^}]*flex:\s*1;[^}]*min-height:\s*0;/s,
    );
    expect(css).toMatch(
      /\.coding-agent__stream\s*\{[^}]*height:\s*100%;[^}]*overflow-y:\s*auto;[^}]*scrollbar-gutter:\s*stable;/s,
    );
    expect(css).toMatch(
      /\.coding-agent__stream-content\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*min-height:\s*100%;/s,
    );
    expect(css).toMatch(/\.coding-agent__stream-content\s*>\s*\*\s*\{[^}]*flex:\s*none;/s);
  });

  it("keeps Monaco syntax, caret, and selection visible without runtime theme CSS", () => {
    for (const theme of ["echo-light", "echo-dark", "echo-hc-light", "echo-hc-dark"]) {
      expect(css).toContain(`.coding-monaco .monaco-editor.${theme} {`);
    }
    expect(css).toMatch(/\.coding-monaco \.monaco-editor\s*\{[^}]*forced-color-adjust:\s*none;/s);
    expect(css).toMatch(/\.coding-monaco \.monaco-editor \.mtk1\s*\{[^}]*--echo-monaco-token-1/s);
    expect(css).toMatch(/\.coding-monaco \.monaco-editor \.cursors-layer > \.cursor\s*\{[^}]*editorCursor-foreground/s);
    expect(css).toMatch(/\.coding-monaco \.monaco-editor \.focused \.selected-text\s*\{[^}]*selectionBackground/s);
  });
});
