import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesDir = resolve(process.cwd(), "src/styles");
const appCss = readFileSync(resolve(stylesDir, "app.css"), "utf8");
const globalCss = readFileSync(resolve(stylesDir, "global.css"), "utf8");
const tokensCss = readFileSync(resolve(stylesDir, "tokens.css"), "utf8");

function darkBlocks(css: string): string[] {
  return [...css.matchAll(/\[data-theme=dark\],[\s\S]*?\n\}/g)].map((match) => match[0]);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:css|ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("theme token contract", () => {
  it("深色主题保留深色主表面和可见边框、图标", () => {
    const [base, components] = darkBlocks(tokensCss);

    expect(base).toContain("--echo-bg-primary: var(--echo-palette-gray-3);");
    expect(base).toContain("--echo-border-default: color-mix(in srgb, var(--echo-palette-white-100) 10%, transparent);");
    expect(components).toContain("--echo-icon-strong: color-mix(in srgb, var(--echo-palette-white-100) 96%, transparent);");
  });

  it("全局兼容层不再覆盖核心主题令牌", () => {
    for (const token of [
      "--echo-bg-primary",
      "--echo-bg-secondary",
      "--echo-bg-tertiary",
      "--echo-text-strong",
      "--echo-text-medium",
      "--echo-text-weak",
      "--echo-border-default",
    ]) {
      expect(globalCss).not.toMatch(new RegExp(`${token}\\s*:`));
    }
  });

  it("迁移中的共享页面使用的历史语义名都有统一映射", () => {
    for (const token of [
      "--echo-text-primary",
      "--echo-text-secondary",
      "--echo-text-light",
      "--echo-bg-elevated",
      "--echo-bg-input",
      "--echo-border",
      "--echo-border-soft",
      "--echo-danger",
      "--echo-link",
    ]) {
      expect(globalCss).toMatch(new RegExp(`${token}\\s*:`));
    }

    expect(appCss).not.toContain("--echo-brand-rgb");
    expect(appCss).not.toContain("--echo-palette-green-500");
  });

  it("源码引用的主题变量都存在定义", () => {
    const files = sourceFiles(resolve(process.cwd(), "src"));
    const sources = files.map((file) => readFileSync(file, "utf8"));
    const definitions = new Set(
      sources
        .filter((_, index) => files[index].endsWith(".css"))
        .flatMap((source) => [...source.matchAll(/(--(?:echo|ui|atm)-[a-z0-9-]+)\s*:/g)])
        .map((match) => match[1]),
    );
    const references = new Set(
      sources
        .flatMap((source) => [...source.matchAll(/var\((--(?:echo|ui|atm)-[a-z0-9-]+)/g)])
        .map((match) => match[1]),
    );

    expect([...references].filter((token) => !definitions.has(token)).sort()).toEqual([]);
  });
});
