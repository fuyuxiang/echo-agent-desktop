import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesDir = resolve(process.cwd(), "src/styles");
const appCss = readFileSync(resolve(stylesDir, "app.css"), "utf8");
const globalCss = readFileSync(resolve(stylesDir, "global.css"), "utf8");
const tokensCss = readFileSync(resolve(stylesDir, "tokens.css"), "utf8");
const visualPolishCss = readFileSync(resolve(stylesDir, "visual-polish.css"), "utf8");

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

  it("通知筛选的激活态在浅色背景上保持可见", () => {
    const baseRule = visualPolishCss.indexOf(".notification-filter {");
    const activeRule = visualPolishCss.indexOf(
      ".notification-filter.notification-filter--active {",
    );
    const activeBlock = visualPolishCss.slice(
      activeRule,
      visualPolishCss.indexOf("}", activeRule) + 1,
    );

    expect(baseRule).toBeGreaterThanOrEqual(0);
    expect(activeRule).toBeGreaterThan(baseRule);
    expect(activeBlock).toContain("background: var(--echo-brand);");
    expect(activeBlock).toContain("color: var(--echo-text-on-primary, #fff);");
  });

  it("插件市场主操作在最后样式层保持主题对比度", () => {
    const genericRule = visualPolishCss.indexOf(
      ".resources-panel__action-btn,\n.plugins-panel__action-btn,\n.marketplace-panel__action-btn {",
    );
    const primarySelector =
      ".marketplace-panel__action-btn.marketplace-panel__action-btn--primary {";
    const primaryRule = visualPolishCss.indexOf(primarySelector);
    const primaryBlock = visualPolishCss.slice(
      primaryRule,
      visualPolishCss.indexOf("}", primaryRule) + 1,
    );
    const disabledSelector =
      ".marketplace-panel__action-btn.marketplace-panel__action-btn--primary:disabled {";
    const disabledRule = visualPolishCss.indexOf(disabledSelector);
    const disabledBlock = visualPolishCss.slice(
      disabledRule,
      visualPolishCss.indexOf("}", disabledRule) + 1,
    );

    expect(genericRule).toBeGreaterThanOrEqual(0);
    expect(primaryRule).toBeGreaterThan(genericRule);
    expect(primaryBlock).toContain("background: var(--echo-button-primary-bg);");
    expect(primaryBlock).toContain("color: var(--echo-button-primary-fg);");
    expect(disabledRule).toBeGreaterThan(primaryRule);
    expect(disabledBlock).toContain("background: var(--echo-button-primary-bg-disabled);");
    expect(disabledBlock).toContain("color: var(--echo-button-primary-fg-disabled);");
    expect(disabledBlock).toContain("opacity: 1;");
  });
});
