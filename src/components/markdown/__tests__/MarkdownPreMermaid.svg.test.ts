import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// jsdom does not implement SVG geometry. These measurements only let Mermaid
// complete its render; the assertions below concern the emitted SVG structure
// and label contents, not pixel dimensions.
type SVGGeometry = SVGElement & {
  getBBox?: () => DOMRect;
  getComputedTextLength?: () => number;
};
const svgPrototype = SVGElement.prototype as SVGGeometry;
const originalGetBBox = svgPrototype.getBBox;
const originalGetComputedTextLength = svgPrototype.getComputedTextLength;

beforeAll(() => {
  vi.stubGlobal("CSSStyleSheet", window.CSSStyleSheet);
  svgPrototype.getBBox = function () {
    return { x: 0, y: 0, width: Math.max(32, (this.textContent ?? "").length * 16), height: 24 } as DOMRect;
  };
  svgPrototype.getComputedTextLength = function () {
    return (this.textContent ?? "").length * 16;
  };
});

afterAll(() => {
  if (originalGetBBox) svgPrototype.getBBox = originalGetBBox;
  else Reflect.deleteProperty(svgPrototype, "getBBox");
  if (originalGetComputedTextLength) svgPrototype.getComputedTextLength = originalGetComputedTextLength;
  else Reflect.deleteProperty(svgPrototype, "getComputedTextLength");
  vi.unstubAllGlobals();
});

describe("Mermaid 独立 SVG", () => {
  it("真实渲染后的流程图保留全部中文节点和连线文字", async () => {
    const mermaid = (await import("mermaid")).default;
    const secure = new Set(mermaid.mermaidAPI.getConfig().secure ?? []);
    secure.add("htmlLabels");
    secure.add("fontFamily");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      secure: [...secure],
      htmlLabels: false,
      fontFamily: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
    });

    const source = [
      '%%{init: {"htmlLabels": true, "fontFamily": "inherit"}}%%',
      "flowchart LR",
      "A[技术革命] --> B{周期规律}",
      "B -->|技术进步| C[慢 · 沉淀 · 复利]",
      "B -->|人性波动| D[急 · 投机 · 泡沫]",
      "C --> E[价值创造]",
      "D --> F[泡沫与收缩]",
      "E --> G[永恒错误]",
      "F --> G",
    ].join("\n");
    const { svg } = await mermaid.render("md-mermaid-chinese-regression", source);
    const xml = new DOMParser().parseFromString(svg, "image/svg+xml");

    expect(xml.querySelector("parsererror")).toBeNull();
    expect(xml.querySelector("foreignObject")).toBeNull();
    expect(xml.querySelectorAll("text").length).toBeGreaterThan(0);
    for (const label of [
      "技术革命", "周期规律", "技术进步", "人性波动",
      "慢 · 沉淀 · 复利", "急 · 投机 · 泡沫", "价值创造", "泡沫与收缩", "永恒错误",
    ]) {
      expect(xml.documentElement.textContent).toContain(label);
    }
    expect(xml.querySelector("style")?.textContent).toContain("PingFang SC");
  });
});
