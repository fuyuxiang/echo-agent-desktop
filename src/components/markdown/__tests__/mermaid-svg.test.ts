import { describe, expect, it } from "vitest";
import {
  createMermaidConfig,
  detectMermaidDiagramKind,
  normalizeStandaloneMermaidSvg,
} from "../mermaid-svg";

describe("Mermaid standalone SVG", () => {
  it("detects diagram kinds after init directives and comments", () => {
    expect(detectMermaidDiagramKind('%%{init: {"theme":"neutral"}}%%\n%% comment\nmindmap')).toBe("mindmap");
    expect(detectMermaidDiagramKind('---\nconfig:\n  theme: neutral\n---\n%% comment\n%%{init: {"fontSize": 18}}%%\nmindmap')).toBe("mindmap");
    expect(detectMermaidDiagramKind("flowchart LR\nA-->B")).toBe("flowchart");
    expect(detectMermaidDiagramKind("sequenceDiagram\nA->>B: hello")).toBe("other");
  });

  it("uses concrete dimensions for standalone images", () => {
    const source = '<svg width="100%" style="max-width: 2400px;" viewBox="-8 -8 2400 400" xmlns="http://www.w3.org/2000/svg"></svg>';
    const normalized = normalizeStandaloneMermaidSvg(source);
    expect(normalized).toContain('width="2400"');
    expect(normalized).toContain('height="400"');
    expect(normalized).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(normalized).not.toContain("max-width: 2400px");
  });

  it("keeps mindmap labels wrapped and disables responsive sizing", () => {
    const config = createMermaidConfig("mindmap", "light", ["securityLevel"]);
    expect(config.htmlLabels).toBe(true);
    expect(config.useMaxWidth).toBe(false);
    expect(config.mindmap).toEqual({ useMaxWidth: false, maxNodeWidth: 240, padding: 12 });
    expect(config.layout).toBe("echo-mindmap");
    expect(config.secure).toEqual(expect.arrayContaining(["securityLevel", "htmlLabels", "fontFamily", "useMaxWidth", "layout", "themeCSS"]));
  });

  it("pads the clipping viewport while preserving the text anchor, card and source label", () => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg" class="mindmapDiagram" viewBox="-40 -30 80 60">
      <g class="nodes"><g><rect class="label-container" width="60" height="48"/>
        <g class="label" transform="translate(-18,-12)"><foreignObject width="36" height="24">
          <div xmlns="http://www.w3.org/1999/xhtml" style="display:inline-block;max-width:240px">grep_中文</div>
        </foreignObject></g></g></g></svg>`;
    const normalized = normalizeStandaloneMermaidSvg(source);
    const xml = new DOMParser().parseFromString(normalized, "image/svg+xml");
    expect(Number(xml.querySelector("foreignObject")?.getAttribute("width"))).toBeGreaterThan(37);
    expect(Number(xml.querySelector("foreignObject")?.getAttribute("height"))).toBeGreaterThan(24);
    expect(xml.querySelector(".label")?.getAttribute("transform")).toBe("translate(-18,-12)");
    expect(xml.querySelector(".label-container")?.getAttribute("width")).toBe("60");
    expect(xml.querySelector("foreignObject")?.textContent?.trim()).toBe("grep_中文");
    expect(xml.documentElement.getAttribute("viewBox")).toBe("-40 -30 80 60");
    expect(normalizeStandaloneMermaidSvg(normalized)).toBe(normalized);
  });

  it("does not pad other diagram types or unrelated embedded SVG content", () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><foreignObject width="40" height="24"/></svg>';
    const xml = new DOMParser().parseFromString(normalizeStandaloneMermaidSvg(source), "image/svg+xml");
    expect(xml.querySelector("foreignObject")?.getAttribute("width")).toBe("40");
    const mindmap = source.replace('viewBox=', 'class="mindmapDiagram" viewBox=');
    const other = new DOMParser().parseFromString(normalizeStandaloneMermaidSvg(mindmap), "image/svg+xml");
    expect(other.querySelector("foreignObject")?.getAttribute("width")).toBe("40");
  });

  it("reports invalid label geometry instead of exporting a silently broken image", () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" class="mindmapDiagram" viewBox="0 0 100 80"><g class="nodes"><g class="label"><foreignObject width="NaN" height="24"/></g></g></svg>';
    expect(() => normalizeStandaloneMermaidSvg(source)).toThrow("图表标签尺寸无效");
  });

  it("serializes HTML line breaks and void elements as valid standalone XHTML", () => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg" class="mindmapDiagram" viewBox="0 0 300 100">
      <g class="nodes"><g class="label"><foreignObject width="240" height="72">
        <div xmlns="http://www.w3.org/1999/xhtml"><span class="nodeLabel"><p>第一行<br>second<br/>第三行<wbr>结束</p></span></div>
      </foreignObject></g></g></svg>`;
    const normalized = normalizeStandaloneMermaidSvg(source);
    const xml = new DOMParser().parseFromString(normalized, "image/svg+xml");
    expect(xml.querySelector("parsererror")).toBeNull();
    expect(xml.querySelectorAll("br")).toHaveLength(2);
    expect(xml.querySelector("wbr")?.namespaceURI).toBe("http://www.w3.org/1999/xhtml");
    expect(xml.querySelector(".nodeLabel")?.textContent).toBe("第一行second第三行结束");
    expect(normalizeStandaloneMermaidSvg(normalized)).toBe(normalized);
  });

  it("preserves escaped source text, attributes and embedded CSS when serializing labels", () => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg" class="mindmapDiagram" viewBox="0 0 300 100">
      <style>#example .label div{color:rgb(1,2,3)}</style>
      <g class="nodes"><g class="label" transform="translate(-20,-12)"><foreignObject width="40" height="24">
        <div xmlns="http://www.w3.org/1999/xhtml" title="a &amp; b"><p>&lt;br&gt; &amp; &lt;script&gt;alert(1)&lt;/script&gt;</p></div>
      </foreignObject></g></g></svg>`;
    const xml = new DOMParser().parseFromString(normalizeStandaloneMermaidSvg(source), "image/svg+xml");
    expect(xml.querySelector("parsererror")).toBeNull();
    expect(xml.querySelector("br, script")).toBeNull();
    expect(xml.querySelector("p")?.textContent).toBe("<br> & <script>alert(1)</script>");
    expect(xml.querySelector("foreignObject div")?.getAttribute("title")).toBe("a & b");
    expect(xml.querySelector("style")?.textContent).toBe("#example .label div{color:rgb(1,2,3)}");
    expect(xml.querySelector(".label")?.getAttribute("transform")).toBe("translate(-20,-12)");
  });
});
