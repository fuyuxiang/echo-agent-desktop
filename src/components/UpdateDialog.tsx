import { AlertTriangle, CheckCircle2, Download, Loader2, X } from "lucide-react";
import { APP_VERSION } from "@/lib/app-version";
import { useUpdateStore } from "@/stores/update-store";

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 MB";
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function UpdateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const status = useUpdateStore((state) => state.status);
  const currentVersion = useUpdateStore((state) => state.currentVersion);
  const update = useUpdateStore((state) => state.update);
  const downloaded = useUpdateStore((state) => state.downloaded);
  const total = useUpdateStore((state) => state.total);
  const error = useUpdateStore((state) => state.error);
  const check = useUpdateStore((state) => state.check);
  const install = useUpdateStore((state) => state.install);
  const busy = status === "checking" || status === "downloading" || status === "installing";
  const progress = total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : undefined;

  if (!open) return null;

  return (
    <div className="update-dialog__overlay" role="presentation" onClick={() => !busy && onClose()}>
      <section
        className="update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          className="update-dialog__close"
          onClick={onClose}
          disabled={busy}
          aria-label="关闭更新窗口"
        >
          <X size={18} />
        </button>

        <header className="update-dialog__header">
          <span className={`update-dialog__icon update-dialog__icon--${status}`}>
            {status === "checking" || status === "downloading" || status === "installing" ? (
              <Loader2 size={24} className="update-dialog__spinner" />
            ) : status === "up-to-date" ? (
              <CheckCircle2 size={24} />
            ) : status === "error" ? (
              <AlertTriangle size={24} />
            ) : (
              <Download size={24} />
            )}
          </span>
          <div>
            <h2 id="update-dialog-title">
              {status === "checking" && "正在检查更新"}
              {status === "available" && `发现 EchoAgent ${update?.version ?? "新版本"}`}
              {status === "downloading" && `正在下载 ${update?.version ?? "更新"}`}
              {status === "installing" && "正在安装更新"}
              {status === "up-to-date" && "已是最新版本"}
              {status === "error" && "检查更新失败"}
              {status === "idle" && "EchoAgent 版本更新"}
            </h2>
            <p>当前版本 v{currentVersion ?? APP_VERSION}</p>
          </div>
        </header>

        {status === "available" && update && (
          <div className="update-dialog__release">
            <div className="update-dialog__version-row">
              <strong>v{update.version}</strong>
              {update.mandatory && <span className="update-dialog__required">重要更新</span>}
              {update.publishedAt && (
                <time dateTime={update.publishedAt}>
                  {new Date(update.publishedAt).toLocaleDateString("zh-CN")}
                </time>
              )}
            </div>
            <div className="update-dialog__notes">
              {update.notes?.trim() || "此版本包含稳定性和安全性改进。"}
            </div>
            <p className="update-dialog__security">安装前会自动校验发布签名。</p>
          </div>
        )}

        {(status === "downloading" || status === "installing") && (
          <div className="update-dialog__progress-wrap">
            <div className="update-dialog__progress-label">
              <span>{status === "installing" ? "下载完成，正在安装…" : "正在安全下载…"}</span>
              <span>
                {progress !== undefined ? `${progress}%` : formatBytes(downloaded)}
              </span>
            </div>
            <div
              className={`update-dialog__progress${progress === undefined ? " update-dialog__progress--indeterminate" : ""}`}
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              <span style={progress === undefined ? undefined : { width: `${progress}%` }} />
            </div>
            {total && status === "downloading" ? (
              <small>{formatBytes(downloaded)} / {formatBytes(total)}</small>
            ) : null}
          </div>
        )}

        {status === "up-to-date" && (
          <p className="update-dialog__message">EchoAgent v{currentVersion ?? APP_VERSION} 已是服务器上的最新稳定版。</p>
        )}
        {status === "error" && <p className="update-dialog__error">{error ?? "未知错误"}</p>}
        {status === "idle" && (
          <p className="update-dialog__message">将从 EchoAgent 内网发布服务检查签名更新。</p>
        )}

        <footer className="update-dialog__actions">
          {!busy && <button className="settings-btn" onClick={onClose}>稍后再说</button>}
          {status === "available" && (
            <button className="settings-btn settings-btn--primary" onClick={() => void install()}>
              <Download size={15} /> 下载并安装
            </button>
          )}
          {(status === "idle" || status === "error" || status === "up-to-date") && (
            <button className="settings-btn settings-btn--primary" onClick={() => void check(true)}>
              <Download size={15} /> 重新检查
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
