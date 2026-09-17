import { useEffect, useMemo, useRef, useState } from "react";
import { XCloseIcon, FolderOpenIcon } from "@/foundation/components/Icon/icons";
import { filesystemPickDirectory, filesystemPickFiles, skillsInspectPackage, skillsInstallPackage } from "@/lib/agent-client";
import type { SkillPackageInspection, SkillRiskLevel } from "@/lib/types";
import { useModalFocus } from "@/lib/use-modal-focus";
import { SkillCapabilityStatus } from "./SkillCapabilityStatus";

const RISK_LABEL: Record<SkillRiskLevel, string> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
};

/** 单个待处理技能包在批量安装队列里的状态。 */
interface PendingItem {
  /** 仅用于 React key 和 DOM 测试的本地唯一 id。 */
  id: string;
  /** 用户选中的本地绝对路径。 */
  path: string;
  status: "inspecting" | "ready" | "installing" | "done" | "error";
  inspection: SkillPackageInspection | null;
  error: string | null;
  /** 高风险项需要用户勾选后才能安装。 */
  approvedHighRisk: boolean;
}

let itemIdCounter = 0;
function nextItemId(): string {
  itemIdCounter += 1;
  return `item-${Date.now().toString(36)}-${itemIdCounter}`;
}

function basenameOf(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").pop() || path;
}

/** Managed local Skill installer: inspect first, then copy/update atomically.
 *
 * 重写为列表队列:支持多选文件/批量 inspect,提供「安装全部低风险」与逐项安装。
 * 选择目录仍走单条 inspect(目录本身就是一个技能包,不是多个)。 */
export function ImportSkillModal({
  onClose, onToast, onInstalled,
}: {
  onClose: () => void;
  onToast?: (m: string) => void;
  onInstalled?: () => void;
}) {
  const [autoInstall, setAutoInstall] = useState(false);
  const [items, setItems] = useState<PendingItem[]>([]);
  const [globalError, setGlobalError] = useState("");
  // commitInstall 必须能同步读到当前 items;用 ref 跟踪最新值,避免依赖 setState
  // updater(React 18 不保证同步执行)导致的空读 race。
  const itemsRef = useRef<PendingItem[]>(items);
  useEffect(() => { itemsRef.current = items; }, [items]);
  const dialogRef = useModalFocus<HTMLDivElement>(true, () => {
    if (!isBusy(items)) onClose();
  });

  const updateItem = (id: string, patch: Partial<PendingItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  };

  const inspectOne = async (path: string): Promise<PendingItem> => {
    const item: PendingItem = {
      id: nextItemId(),
      path,
      status: "inspecting",
      inspection: null,
      error: null,
      approvedHighRisk: false,
    };
    setItems((prev) => [...prev, item]);
    try {
      const report = await skillsInspectPackage(path);
      let completedItem: PendingItem = { ...item, status: "ready", inspection: report };
      setItems((prev) =>
        prev.map((it) => (it.id === item.id ? completedItem : it)),
      );
      // 仅在勾选了「自动安装低风险」时才自动开装,中/高风险一律等用户确认。
      if (autoInstall && report.riskLevel === "low") {
        await commitInstall(completedItem.id);
      }
      return completedItem;
    } catch (e) {
      const message = String(e).replace(/^Error:\s*/, "");
      const failed: PendingItem = { ...item, status: "error", error: message };
      setItems((prev) => prev.map((it) => (it.id === item.id ? failed : it)));
      return failed;
    }
  };

  const commitInstall = async (id: string, approved?: boolean) => {
    // 同步读最新 item,避免 setState 异步导致空 read。
    const target = itemsRef.current.find((it) => it.id === id);
    if (!target || !target.inspection) return;
    const inspection = target.inspection;
    const approve = approved ?? target.approvedHighRisk;
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, status: "installing" } : it)),
    );
    try {
      const result = await skillsInstallPackage(target.path, inspection.sourceHash, approve);
      setItems((prev) =>
        prev.map((it) =>
          it.id === id ? { ...it, status: "done", inspection: result.inspection } : it,
        ),
      );
      onToast?.(`${result.updated ? "已更新" : "已安装"}技能「${result.inspection.name}」`);
      onInstalled?.();
    } catch (e) {
      const message = String(e).replace(/^Error:\s*/, "");
      setItems((prev) =>
        prev.map((it) =>
          it.id === id ? { ...it, status: "error", error: message } : it,
        ),
      );
    }
  };

  const installAllLowRisk = async () => {
    const readyLow = items.filter(
      (it) => it.status === "ready" && it.inspection?.riskLevel === "low",
    );
    await Promise.all(readyLow.map((it) => commitInstall(it.id)));
  };

  const removeItem = (id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  };

  const pickFile = async () => {
    setGlobalError("");
    try {
      const selected = await filesystemPickFiles({
        title: "选择技能文件（Markdown 或 ZIP）",
        extensions: ["md", "markdown", "zip"],
        multiple: true,
        maxFiles: 50,
      });
      if (!selected || selected.length === 0) return;
      // 并行 inspect;每条独立更新,失败也不会阻塞其它行。
      await Promise.all(selected.map((path) => inspectOne(path)));
    } catch (cause) {
      setGlobalError(`选择技能文件失败：${String(cause).replace(/^Error:\s*/, "")}`);
    }
  };

  const pickFolder = async () => {
    setGlobalError("");
    try {
      const selected = await filesystemPickDirectory();
      if (!selected) return;
      await inspectOne(selected);
    } catch (cause) {
      setGlobalError(`选择技能文件夹失败：${String(cause).replace(/^Error:\s*/, "")}`);
    }
  };

  const readyLowCount = useMemo(
    () =>
      items.filter((it) => it.status === "ready" && it.inspection?.riskLevel === "low")
        .length,
    [items],
  );
  const busy = isBusy(items);

  return (
    <div className="modal-overlay sk-import-overlay" onClick={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <div
        ref={dialogRef}
        className="sk-import sk-import--managed"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="安装本地技能"
        tabIndex={-1}
      >
        <div className="sk-import-head">
          <div>
            <h3>安装本地技能</h3>
            <p>可一次选择多个 Markdown / ZIP，逐项检查后批量安装低风险项</p>
          </div>
          <button
            type="button"
            className="sk-import-close"
            onClick={onClose}
            disabled={busy}
            aria-label="关闭"
            data-modal-initial-focus
          >
            <XCloseIcon size="md" />
          </button>
        </div>
        <div className="sk-import-body">
          <div
            className={`sk-drop${busy ? " sk-drop--busy" : ""}`}
            role="button"
            tabIndex={busy ? -1 : 0}
            aria-label="选择 Markdown 或 ZIP 技能文件"
            onClick={() => { if (!busy) void pickFile(); }}
            onKeyDown={(event) => {
              if (!busy && (event.key === "Enter" || event.key === " ")) {
                event.preventDefault();
                void pickFile();
              }
            }}
          >
            <FolderOpenIcon size="xl" className="sk-drop-icon" />
            <div className="sk-drop-title">
              {busy ? "正在处理…" : "点击选择 Markdown / ZIP（可多选）"}
            </div>
          </div>
          <button type="button" className="sk-import-folder" onClick={pickFolder} disabled={busy}>
            或选择一个包含 SKILL.md 的文件夹
          </button>

          <label className="sk-import-check">
            <input
              type="checkbox"
              checked={autoInstall}
              disabled={busy}
              onChange={(e) => setAutoInstall(e.target.checked)}
            />
            <span>仅在检查结果为低风险时自动安装</span>
          </label>

          {globalError && <div className="sk-install-error" role="alert">{globalError}</div>}

          {items.length > 0 && (
            <div className="sk-batch">
              <div className="sk-batch-head">
                <span>已选择 {items.length} 个技能包</span>
                {readyLowCount > 0 && (
                  <button
                    type="button"
                    className="um-btn um-btn--primary sk-batch-install-all"
                    onClick={() => void installAllLowRisk()}
                    disabled={busy}
                  >
                    安装全部低风险（{readyLowCount}）
                  </button>
                )}
              </div>
              <ul className="sk-batch-list">
                {items.map((item) => (
                  <SkillBatchRow
                    key={item.id}
                    item={item}
                    busy={busy}
                    onApprove={(approved) =>
                      updateItem(item.id, { approvedHighRisk: approved })
                    }
                    onInstall={() => void commitInstall(item.id)}
                    onRemove={() => removeItem(item.id)}
                  />
                ))}
              </ul>
            </div>
          )}

          {items.length === 0 && !globalError && (
            <div className="sk-import-req">
              <div className="sk-import-req-title">安装检查</div>
              <ul className="sk-import-req-list">
                <li>验证 SKILL.md、文件数量、大小和目录安全</li>
                <li>校验 echo.skill.json 执行入口、依赖、账号和产物契约</li>
                <li>扫描脚本、敏感文件访问、网络和依赖安装风险</li>
                <li>生成内容指纹，并支持后续原子更新和安全卸载</li>
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function isBusy(items: PendingItem[]): boolean {
  return items.some((it) => it.status === "inspecting" || it.status === "installing");
}

function SkillBatchRow({
  item, busy, onApprove, onInstall, onRemove,
}: {
  item: PendingItem;
  busy: boolean;
  onApprove: (approved: boolean) => void;
  onInstall: () => void;
  onRemove: () => void;
}) {
  const inspection = item.inspection;
  const fileName = basenameOf(item.path);
  const requiresApproval =
    inspection?.riskLevel === "high" && item.status === "ready";
  const canInstall =
    inspection
    && item.status === "ready"
    && (inspection.riskLevel !== "high" || item.approvedHighRisk)
    && !busy;
  const installLabel = item.status === "installing"
    ? "安装中…"
    : inspection?.alreadyInstalled ? "更新技能" : "安装技能";

  return (
    <li className={`sk-batch-row sk-batch-row--${item.status}`}>
      <div className="sk-batch-row-main">
        <div className="sk-batch-row-name" title={item.path}>{fileName}</div>
        <div className="sk-batch-row-status">
          {item.status === "inspecting" && <span>检查中…</span>}
          {item.status === "ready" && inspection && (
            <span className="sk-batch-row-tagline">
              <span className={`sk-risk sk-risk--${inspection.riskLevel}`}>
                {RISK_LABEL[inspection.riskLevel]}
              </span>
              <span>{inspection.name}</span>
              {inspection.version && <span>v{inspection.version}</span>}
            </span>
          )}
          {item.status === "installing" && <span>安装中…</span>}
          {item.status === "done" && (
            <span className="sk-batch-row-done">已安装</span>
          )}
          {item.status === "error" && (
            <span className="sk-batch-row-error" role="alert">{item.error}</span>
          )}
        </div>
      </div>
      <div className="sk-batch-row-actions">
        {item.status === "ready" && inspection && (
          <details className="sk-batch-row-detail">
            <summary>详情</summary>
            <p className="sk-inspection-desc">{inspection.description}</p>
            <SkillCapabilityStatus report={inspection.capability} />
            {inspection.findings.length > 0 && (
              <div className="sk-findings">
                {inspection.findings.map((finding, index) => (
                  <div
                    key={`${finding.code}-${finding.path ?? index}`}
                    className={`sk-finding sk-finding--${finding.level}`}
                  >
                    <span>{finding.message}</span>
                    {finding.path && <code>{finding.path}</code>}
                  </div>
                ))}
              </div>
            )}
            {inspection.warnings.map((warning) => (
              <div key={warning} className="sk-install-warning">{warning}</div>
            ))}
          </details>
        )}
        {requiresApproval && (
          <label className="sk-high-risk-confirm">
            <input
              type="checkbox"
              checked={item.approvedHighRisk}
              onChange={(e) => onApprove(e.target.checked)}
              disabled={busy}
            />
            <span>我已查看风险</span>
          </label>
        )}
        {item.status === "ready" && (
          <button
            type="button"
            className="um-btn um-btn--primary sk-batch-row-install"
            onClick={onInstall}
            disabled={!canInstall}
            aria-label={installLabel}
          >
            {installLabel}
          </button>
        )}
        {(item.status === "done" || item.status === "error") && (
          <button
            type="button"
            className="sk-batch-row-remove"
            onClick={onRemove}
            aria-label={`移除 ${fileName}`}
          >
            <XCloseIcon size="sm" />
          </button>
        )}
      </div>
    </li>
  );
}