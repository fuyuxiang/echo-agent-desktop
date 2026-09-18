import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// 这些契约用来防止 .mcp-list / .mcp-item-wrap 的滚动与压缩约定再次回退。
// 背景：连接器页直接内联 McpModal 后，列表容器高度受限；
// .mcp-item-wrap 一旦允许压缩，会被 flex 收缩到只显示名称行。
// 通过把收缩锁死、明确滚动归属，把视觉错位从源头杜绝。

const appCss = readFileSync(
  resolve(process.cwd(), "src/styles/app.css"),
  "utf8",
);

describe("MCP 服务管理列表布局契约", () => {
  it(".mcp-item-wrap 必须 flex-shrink: 0，避免条目被压缩到只剩名称", () => {
    expect(appCss).toMatch(
      /\.mcp-item-wrap\s*\{[^}]*flex-shrink:\s*0;/s,
    );
  });

  it(".mcp-list 必须是 flex:1 1 auto + min-height:0 + overflow-y:auto 的滚动组合", () => {
    expect(appCss).toMatch(
      /\.mcp-list\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s,
    );
  });

  it(".mcp-modal-body / .mcp-panel 都应包含 min-height:0 以打通 flex 收缩链", () => {
    expect(appCss).toMatch(/\.mcp-modal-body\s*\{[^}]*min-height:\s*0;/s);
    expect(appCss).toMatch(/\.mcp-panel\s*\{[^}]*min-height:\s*0;/s);
  });

  it(".mcp-modal--embedded 必须 height:100%，确保铺满 um-scroll--mcp 容器", () => {
    expect(appCss).toMatch(
      /\.mcp-modal--embedded\s*\{[^}]*height:\s*100%;/s,
    );
  });

  it(".um-scroll--mcp 必须保持 overflow:hidden 但无 padding，避免引入竖向滚动条", () => {
    const block = appCss.match(/\.um-scroll--mcp\s*\{[^}]*\}/s)?.[0] ?? "";
    expect(block).toMatch(/overflow:\s*hidden;/);
    expect(block).toMatch(/padding:\s*0;/);
  });
});

describe("MCP 服务管理列表的交互反馈契约", () => {
  it(".mcp-item-wrap 必须有 hover 反馈，让卡片可点感更明显", () => {
    expect(appCss).toMatch(
      /\.mcp-item-wrap:hover\s*\{[^}]*border-color:[^;}]+;/s,
    );
  });

  it(".mcp-item-wrap--expanded 必须有更显眼的边框色，与 hover 区分", () => {
    expect(appCss).toMatch(
      /\.mcp-item-wrap--expanded\s*\{[^}]*border-color:[^;}]+;/s,
    );
  });

  it(".mcp-list 必须定制 webkit 滚动条样式以贴合 EchoAgent 风格", () => {
    expect(appCss).toMatch(/\.mcp-list::-webkit-scrollbar\s*\{/s);
  });
});