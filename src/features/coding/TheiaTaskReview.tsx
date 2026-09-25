import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { Check, ExternalLink, LoaderCircle, X } from "lucide-react";
import { codingApi } from "./lib/tauri-api";

interface Props {
  root: string;
  taskId: string;
  path: string;
  onClose: () => void;
  onOpenFile: () => void;
  onReviewed: () => Promise<void>;
  onToast?: (message: string) => void;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: "c", cc: "cpp", cpp: "cpp", cs: "csharp", css: "css",
  go: "go", h: "cpp", html: "html", java: "java", js: "javascript",
  json: "json", jsx: "javascript", kt: "kotlin", less: "less",
  md: "markdown", mdx: "mdx", php: "php", py: "python",
  rb: "ruby", rs: "rust", scss: "scss", sh: "shell", sql: "sql",
  swift: "swift", ts: "typescript", tsx: "typescript", xml: "xml",
  yaml: "yaml", yml: "yaml",
};

export function reviewLanguage(path: string): string {
  const name = path.replaceAll("\\", "/").split("/").pop() ?? "";
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return LANGUAGE_BY_EXTENSION[extension] ?? "plaintext";
}

export function TheiaTaskReview({ root, taskId, path, onClose, onOpenFile, onReviewed, onToast }: Props) {
  const [diff, setDiff] = useState<{ original: string; modified: string; binary: boolean; modifiedHash: string } | null>(null);
  const [error, setError] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [binaryAcknowledged, setBinaryAcknowledged] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute("data-theme") === "dark" ? "vs-dark" : "vs");

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "vs-dark" : "vs");
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError("");
    setBinaryAcknowledged(false);
    codingApi.changeDiff(root, taskId, path).then((result) => {
      if (!cancelled) setDiff(result);
    }).catch((reason) => {
      if (!cancelled) setError(String(reason));
    });
    return () => { cancelled = true; };
  }, [root, taskId, path, reloadVersion]);

  const markReviewed = async () => {
    if (!diff?.modifiedHash) {
      onToast?.("无法确认当前差异版本，请重新打开差异后再审阅");
      return;
    }
    setReviewing(true);
    try {
      await codingApi.markReviewed(root, taskId, path, diff.modifiedHash);
      await onReviewed();
      onToast?.(`已审阅 ${path}`);
    } catch (reason) {
      const message = String(reason).replace(/^Error:\s*/, "");
      setError(`审阅失败：${message}`);
      setDiff(null);
      onToast?.(`审阅失败：${message}`);
    } finally {
      setReviewing(false);
    }
  };

  return (
    <section className="echo-theia-review" aria-label={`任务差异 ${path}`}>
      <header className="echo-theia-review__header">
        <div><strong>任务差异</strong><span>{path}</span></div>
        <div>
          <button type="button" onClick={onOpenFile}><ExternalLink size={14} />打开文件</button>
          <button type="button" disabled={!diff?.modifiedHash || reviewing || (diff.binary && !binaryAcknowledged)} onClick={() => void markReviewed()}>
            {reviewing ? <LoaderCircle size={14} className="is-spinning" /> : <Check size={14} />}
            标记已审阅
          </button>
          <button type="button" aria-label="关闭差异" onClick={onClose}><X size={16} /></button>
        </div>
      </header>
      {error && <div className="echo-theia-review__state">{error}<button type="button" onClick={() => setReloadVersion((value) => value + 1)}>刷新差异</button></div>}
      {!error && !diff && <div className="echo-theia-review__state"><LoaderCircle size={17} className="is-spinning" />正在读取任务差异…</div>}
      {diff?.binary && (
        <div className="echo-theia-review__state echo-theia-review__binary">
          <p>此文件无法显示文本差异。请先在 IDE 或专用工具中核对文件内容，再确认已审阅。</p>
          <button type="button" onClick={onOpenFile}><ExternalLink size={14} /> 在 IDE 中打开文件</button>
          <label>
            <input type="checkbox" checked={binaryAcknowledged} onChange={(event) => setBinaryAcknowledged(event.target.checked)} />
            我已核对当前版本的二进制文件
          </label>
        </div>
      )}
      {diff && !diff.binary && (
        <DiffEditor
          original={diff.original}
          modified={diff.modified}
          language={reviewLanguage(path)}
          theme={theme}
          options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, automaticLayout: true }}
        />
      )}
    </section>
  );
}
