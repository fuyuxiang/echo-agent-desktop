import { createMermaidConfig, detectMermaidDiagramKind, normalizeStandaloneMermaidSvg } from "./mermaid-svg";

let renderQueue: Promise<unknown> = Promise.resolve();
let mindmapRegistered = false;
let baseSecure: string[] | undefined;

const measurementCss = `[data-md-mermaid-scope],[data-md-mermaid-scope] *,
  [data-md-mermaid-scope] *::before,[data-md-mermaid-scope] *::after{
    transition:none!important;animation:none!important;
  }`;

/** initialize() is global; keep each configuration paired with its queued render. */
export function renderStandaloneMermaid(id: string, code: string, theme: "light" | "dark"): Promise<string> {
  const result = renderQueue.then(async () => {
    const mermaid = (await import("mermaid")).default;
    const kind = detectMermaidDiagramKind(code);
    if (kind === "mindmap" && !mindmapRegistered) {
      mermaid.registerLayoutLoaders([{ name: "echo-mindmap", loader: () => import("./mermaid-mindmap-layout") }]);
      mindmapRegistered = true;
    }
    await document.fonts?.ready;
    // Capture the site's policy before our first initialize. Kind-specific
    // protections belong to this render; inheriting the previous render's
    // secure list would disable valid directives on unrelated diagram kinds.
    baseSecure ??= [...new Set([
      ...(mermaid.mermaidAPI.defaultConfig.secure ?? []),
      ...(mermaid.mermaidAPI.getConfig().secure ?? []),
    ])];
    const config = createMermaidConfig(kind, theme, baseSecure);
    mermaid.initialize(config);
    const container = document.createElement("div");
    container.setAttribute("aria-hidden", "true");
    container.setAttribute("data-md-mermaid-scope", "");
    container.style.cssText = "position:fixed;left:-10000px;top:0;width:1600px;visibility:hidden;pointer-events:none";
    container.style.fontFamily = config.fontFamily;
    container.style.fontSize = "16px";
    // Mermaid clears the supplied container's innerHTML. Keep the scoped
    // reset outside it so transitions cannot affect transient font or SVG
    // geometry during either label measurement or node layout.
    const measurementStyle = document.createElement("style");
    measurementStyle.textContent = measurementCss;
    document.head.appendChild(measurementStyle);
    document.body.appendChild(container);
    try {
      const { svg } = await mermaid.render(id, code, container);
      return normalizeStandaloneMermaidSvg(svg);
    } finally {
      // Mermaid may leave its temporary error SVG behind when parsing fails.
      container.remove();
      measurementStyle.remove();
    }
  });
  // An invalid graph must not prevent subsequent code blocks from rendering.
  renderQueue = result.catch(() => {});
  return result;
}
