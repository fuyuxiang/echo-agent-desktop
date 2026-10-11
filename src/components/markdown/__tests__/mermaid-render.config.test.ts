import { afterEach, describe, expect, it, vi } from "vitest";
import type { MermaidConfig } from "mermaid";

afterEach(() => { vi.restoreAllMocks(); });

describe("Mermaid source directive isolation", () => {
  it("preserves flowchart directives across a protected mindmap using Mermaid's real parser", async () => {
    vi.resetModules();
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({ secure: [...(mermaid.mermaidAPI.defaultConfig.secure ?? []), "themeVariables"] });
    const { renderStandaloneMermaid } = await import("../mermaid-render");
    const configs: Pick<MermaidConfig, "layout" | "themeCSS" | "secure">[] = [];
    // jsdom lacks SVG geometry. Keep the actual directive/config parser and
    // replace only the drawing stage to inspect its effective configuration.
    vi.spyOn(mermaid, "render").mockImplementation(async (_id, source) => {
      const parsed = await mermaid.parse(source);
      const config = mermaid.mermaidAPI.getConfig();
      configs.push({ layout: config.layout, themeCSS: config.themeCSS, secure: [...(config.secure ?? [])] });
      return {
        svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"></svg>',
        diagramType: parsed ? parsed.diagramType : "",
      };
    });
    const themeCSS = ".node rect{fill:#ff0000;}";
    const flowchart = `%%{init: {"themeCSS":"${themeCSS}","layout":"elk"}}%%\nflowchart LR\nA-->B`;
    await renderStandaloneMermaid("before", flowchart, "light");
    await renderStandaloneMermaid("mindmap", '%%{init: {"layout":"cose-bilkent","themeCSS":".nodeLabel{white-space:nowrap!important}"}}%%\nmindmap\nroot\n  child', "light");
    await renderStandaloneMermaid("after", flowchart, "light");

    expect(configs[0]).toMatchObject({ layout: "elk", themeCSS });
    expect(configs[1].layout).toBe("echo-mindmap");
    expect(configs[1].themeCSS).toContain("white-space:pre-wrap!important");
    expect(configs[1].themeCSS).not.toContain("white-space:nowrap!important");
    expect(configs[2]).toEqual(configs[0]);
    for (const config of configs) {
      expect(config.secure).toEqual(expect.arrayContaining(["secure", "securityLevel", "maxEdges", "themeVariables"]));
    }
  }, 15000);
});
