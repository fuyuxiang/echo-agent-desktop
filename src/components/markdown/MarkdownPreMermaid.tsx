import { memo, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { CodeBlockActions } from "./CodeBlockActions";
import type { MarkdownConfig } from "./types";

type Props = {
  content?: string;
  complete?: boolean;
  language?: string;
  theme?: "light" | "dark";
  children?: ReactNode;
  onDownloadMermaid?: MarkdownConfig["onDownloadMermaid"];
  onPreviewMermaid?: MarkdownConfig["onPreviewMermaid"];
  codeBlockActions?: MarkdownConfig["codeBlockActions"];
  requestId?: string;
  onCodeBlockAction?: MarkdownConfig["onCodeBlockAction"];
  onApplyCode?: MarkdownConfig["onApplyCode"];
  expandThreshold?: number;
};

/**
 * Mermaid fenced block. While streaming (`complete === false`) we only show
 * the source so partial graphs never throw. On complete we lazy-load mermaid.
 */
export const MarkdownPreMermaid = memo(function MarkdownPreMermaid({
  content = "",
  complete = true,
  language = "mermaid",
  theme = "light",
  children,
  onDownloadMermaid,
  codeBlockActions,
  requestId,
  onCodeBlockAction,
}: Props) {
  const reactId = useId().replace(/:/g, "");
  const [mode, setMode] = useState<"diagram" | "code">("diagram");
  const [svg, setSvg] = useState<string | null>(null);
  const [svgUrl, setSvgUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);

  const code = content || "";

  useEffect(() => {
    if (!complete || mode !== "diagram" || !code.trim()) {
      setSvg(null);
      setError(null);
      setRendering(false);
      return;
    }

    let cancelled = false;
    setRendering(true);
    setError(null);

    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: theme === "dark" ? "dark" : "default",
          fontFamily: "inherit",
        });
        const id = `md-mermaid-${reactId}-${Date.now()}`;
        const { svg: rendered } = await mermaid.render(id, code);
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setSvg(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setRendering(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [complete, mode, code, theme, reactId]);

  // Render generated SVG through the browser's image decoder instead of
  // injecting it into the application DOM. Even though Mermaid runs in
  // `strict` mode, model-authored diagrams are untrusted input and future
  // Mermaid regressions must not turn SVG markup into executable WebView DOM.
  useEffect(() => {
    if (!svg || typeof URL.createObjectURL !== "function") {
      setSvgUrl(null);
      return;
    }
    const nextUrl = URL.createObjectURL(
      new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
    );
    setSvgUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [svg]);

  const handleDownload = useMemo(() => {
    return () => {
      if (!svg) return;
      if (onDownloadMermaid) {
        onDownloadMermaid(svg, code);
        return;
      }
      try {
        const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "diagram.svg";
        a.click();
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    };
  }, [svg, code, onDownloadMermaid]);

  const showSource = !complete || mode === "code" || !!error;

  return (
    <div className="md-code-wrapper md-mermaid-wrapper">
      <div className="md-code-container">
        <div className="md-code-header">
          <strong className="md-code-lang">mermaid</strong>
          <div className="md-mermaid-toolbar">
            {complete ? (
              <button
                type="button"
                className="md-code-action"
                onClick={() => setMode((m) => (m === "diagram" ? "code" : "diagram"))}
                title={mode === "diagram" ? "查看源码" : "查看图表"}
              >
                <span className="md-code-action-label">
                  {mode === "diagram" ? "源码" : "图表"}
                </span>
              </button>
            ) : (
              <span className="md-mermaid-pending">生成中…</span>
            )}
            {svg ? (
              <button
                type="button"
                className="md-code-action"
                onClick={handleDownload}
                title="下载 SVG"
              >
                <span className="md-code-action-label">下载</span>
              </button>
            ) : null}
            <CodeBlockActions
              code={code}
              language={language}
              actions={codeBlockActions}
              requestId={requestId}
              onAction={onCodeBlockAction}
              copyIconOnly
            />
          </div>
        </div>

        {showSource ? (
          <pre className="md-code-pre md-mermaid-source">
            {children ?? <code className="language-mermaid">{code}</code>}
            {error ? <div className="md-mermaid-error">Mermaid 渲染失败: {error}</div> : null}
          </pre>
        ) : rendering ? (
          <div className="md-mermaid-loading">正在渲染图表…</div>
        ) : svg && svgUrl ? (
          <div className="md-mermaid-diagram">
            <img src={svgUrl} alt="Mermaid 图表" />
          </div>
        ) : (
          <pre className="md-code-pre">
            <code className="language-mermaid">{code}</code>
          </pre>
        )}
      </div>
    </div>
  );
});
