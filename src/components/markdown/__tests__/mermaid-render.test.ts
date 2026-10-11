import { beforeEach, describe, expect, it, vi } from "vitest";
import mermaid from "mermaid";

const statefulMermaid = vi.hoisted(() => {
  let config: { secure?: string[]; [key: string]: unknown } = {};
  return {
    resetConfig: () => { config = { secure: ["securityLevel", "themeVariables"] }; },
    mermaid: {
      initialize: vi.fn((next: typeof config) => { config = structuredClone(next); }),
      render: vi.fn(),
      registerLayoutLoaders: vi.fn(),
      mermaidAPI: {
        defaultConfig: { secure: ["secure", "securityLevel", "maxEdges"] },
        getConfig: () => config,
      },
    },
  };
});
vi.mock("mermaid", () => ({ default: statefulMermaid.mermaid }));

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"></svg>';
let renderStandaloneMermaid: typeof import("../mermaid-render").renderStandaloneMermaid;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  statefulMermaid.resetConfig();
  ({ renderStandaloneMermaid } = await import("../mermaid-render"));
  vi.mocked(mermaid.render).mockResolvedValue({ svg, diagramType: "flowchart-v2" });
});

describe("Mermaid render configuration isolation", () => {
  it("isolates the live measurement tree and removes its CSS after rendering", async () => {
    vi.mocked(mermaid.render).mockImplementationOnce(async (_id, _code, container) => {
      expect(container).toHaveAttribute("data-md-mermaid-scope");
      expect(container).toHaveAttribute("aria-hidden", "true");
      expect(container?.isConnected).toBe(true);
      // Mermaid clears the container before inserting its temporary SVG.
      container!.innerHTML = "";
      expect([...document.head.querySelectorAll("style")].some((style) =>
        style.textContent?.includes("[data-md-mermaid-scope]")
        && style.textContent.includes("transition:none!important"))).toBe(true);
      return { svg, diagramType: "flowchart-v2" };
    });
    await renderStandaloneMermaid("scoped", "flowchart LR\nA-->B", "light");
    expect(document.querySelector("[data-md-mermaid-scope]")).toBeNull();
    expect([...document.head.querySelectorAll("style")].some((style) =>
      style.textContent?.includes("[data-md-mermaid-scope]"))).toBe(false);
  });

  it("keeps concurrent light/dark diagrams paired with their own configuration", async () => {
    let release!: (value: { svg: string; diagramType: string }) => void;
    const pending = new Promise<{ svg: string; diagramType: string }>((resolve) => { release = resolve; });
    const firstStarted = new Promise<void>((resolve) => {
      vi.mocked(mermaid.render).mockImplementationOnce(() => { resolve(); return pending; });
    });
    const first = renderStandaloneMermaid("light", "flowchart LR\nA-->B", "light");
    const second = renderStandaloneMermaid("dark", "mindmap\nroot\n  child", "dark");
    await firstStarted;
    expect(mermaid.initialize).toHaveBeenCalledTimes(1);
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "default", htmlLabels: false }));
    release({ svg, diagramType: "flowchart-v2" });
    await Promise.all([first, second]);
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({
      layout: "echo-mindmap", htmlLabels: true, themeVariables: expect.objectContaining({ darkMode: true }),
    }));
    expect(mermaid.render).toHaveBeenNthCalledWith(2, "dark", "mindmap\nroot\n  child", expect.any(HTMLDivElement));
  });

  it("keeps default and site security keys without carrying mindmap protections to later diagrams", async () => {
    await renderStandaloneMermaid("before", "flowchart LR\nA-->B", "light");
    const before = structuredClone(mermaid.mermaidAPI.getConfig());
    await renderStandaloneMermaid("mindmap", "mindmap\nroot\n  child", "light");
    expect(mermaid.mermaidAPI.getConfig().secure).toEqual(expect.arrayContaining(["layout", "themeCSS"]));
    await renderStandaloneMermaid("after", "flowchart LR\nA-->B", "light");
    expect(mermaid.mermaidAPI.getConfig()).toEqual(before);
    await renderStandaloneMermaid("other", "sequenceDiagram\nA->>B: hello", "light");
    const after = mermaid.mermaidAPI.getConfig().secure;
    expect(after).toEqual(expect.arrayContaining(["secure", "securityLevel", "maxEdges", "themeVariables"]));
    expect(after).not.toContain("layout");
    expect(after).not.toContain("themeCSS");
  });

  it("continues rendering after an invalid graph fails", async () => {
    vi.mocked(mermaid.render).mockRejectedValueOnce(new Error("parse error"));
    const invalid = renderStandaloneMermaid("invalid", "not a diagram", "light");
    const valid = renderStandaloneMermaid("valid", "flowchart LR\nA-->B", "light");
    await expect(invalid).rejects.toThrow("parse error");
    await expect(valid).resolves.toContain('width="100"');
    expect(mermaid.render).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(mermaid.render).mock.calls) {
      expect(call[2]?.isConnected).toBe(false);
    }
    expect([...document.head.querySelectorAll("style")].some((style) =>
      style.textContent?.includes("[data-md-mermaid-scope]"))).toBe(false);
  });
});
