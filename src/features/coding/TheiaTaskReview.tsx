import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { Check, LoaderCircle, X } from "lucide-react";
import { codingApi } from "./lib/tauri-api";

interface Props {
  root: string;
  taskId: string;
  path: string;
  onClose: () => void;
  onReviewed: () => Promise<void>;
  onToast?: (message: string) => void;
}

export function TheiaTaskReview({ root, taskId, path, onClose, onReviewed, onToast }: Props) {
  const [diff, setDiff] = useState<{ original: string; modified: string; binary: boolean } | null>(null);
  const [error, setError] = useState("");
  const [reviewing, setReviewing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError("");
    codingApi.changeDiff(root, taskId, path).then((result) => {
      if (!cancelled) setDiff(result);
    }).catch((reason) => {
      if (!cancelled) setError(String(reason));
    });
    return () => { cancelled = true; };
  }, [root, taskId, path]);

  const markReviewed = async () => {
    setReviewing(true);
    try {
      await codingApi.markReviewed(root, taskId, path);
      await onReviewed();
      onToast?.(`已审阅 ${path}`);
    } catch (reason) {
      onToast?.(`审阅失败：${String(reason)}`);
    } finally {
      setReviewing(false);
    }
  };

  return (
    <section className="echo-theia-review" aria-label={`任务差异 ${path}`}>
      <header className="echo-theia-review__header">
        <div><strong>任务差异</strong><span>{path}</span></div>
        <div>
          <button type="button" disabled={!diff || diff.binary || reviewing} onClick={() => void markReviewed()}>
            {reviewing ? <LoaderCircle size={14} className="is-spinning" /> : <Check size={14} />}
            标记已审阅
          </button>
          <button type="button" aria-label="关闭差异" onClick={onClose}><X size={16} /></button>
        </div>
      </header>
      {error && <div className="echo-theia-review__state">{error}</div>}
      {!error && !diff && <div className="echo-theia-review__state"><LoaderCircle size={17} className="is-spinning" />正在读取任务差异…</div>}
      {diff?.binary && <div className="echo-theia-review__state">二进制文件无法显示文本差异</div>}
      {diff && !diff.binary && (
        <DiffEditor
          original={diff.original}
          modified={diff.modified}
          language={path.split(".").slice(-1)[0] ?? "plaintext"}
          theme="vs-dark"
          options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, automaticLayout: true }}
        />
      )}
    </section>
  );
}
