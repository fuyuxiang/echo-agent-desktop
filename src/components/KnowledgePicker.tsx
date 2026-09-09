import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Check, ChevronDown } from "lucide-react";
import { listKbProviders } from "@/lib/knowledge-base";
import { openLocalPath } from "@/lib/agent-client";
import { useKnowledgeStore, type KnowledgeMode } from "@/stores/knowledge-store";

export function KnowledgePicker({
  sessionId,
  disabled = false,
  onManage,
}: {
  sessionId?: string;
  disabled?: boolean;
  onManage?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const sourceCount = useKnowledgeStore((state) => state.sourceCount);
  const defaultMode = useKnowledgeStore((state) => state.defaultMode);
  const sessionMode = useKnowledgeStore((state) => sessionId ? state.sessionModes[sessionId] : undefined);
  const retrieval = useKnowledgeStore((state) => sessionId ? state.retrievals[sessionId] : undefined);
  const mode = sessionMode ?? defaultMode;
  const sources = useMemo(() => listKbProviders(), [sourceCount]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const setMode = (next: KnowledgeMode) => {
    const state = useKnowledgeStore.getState();
    if (sessionId) state.setSessionMode(sessionId, next);
    else state.setDefaultMode(next);
  };

  const status = (() => {
    if (mode === "off") return { label: "知识库已关闭", detail: "当前任务不会检索个人知识库" };
    if (sourceCount === 0) return { label: "添加知识库", detail: "添加本地文件夹后可在任务中自动检索" };
    if (retrieval?.state === "searching") return { label: "正在检索", detail: `正在搜索 ${sourceCount} 个个人知识源` };
    if (retrieval?.state === "used") return {
      label: `已引用 ${retrieval.resultCount} 条`,
      detail: `本次回答检索到：${retrieval.titles.join("、")}`,
    };
    if (retrieval?.state === "no-match") return { label: "知识库未命中", detail: `已搜索 ${retrieval.sourceCount} 个知识源，未找到相关内容` };
    if (retrieval?.state === "blocked") return { label: "知识库不可用", detail: retrieval.message };
    if (retrieval?.state === "error") return { label: "知识库检索失败", detail: retrieval.message };
    return { label: `知识库 ${sourceCount}`, detail: "发送时自动检索相关内容，并要求回答标注来源" };
  })();

  return (
    <div className="knowledge-picker" ref={rootRef}>
      <button
        type="button"
        className={`knowledge-picker__trigger${mode === "auto" && sourceCount > 0 ? " is-active" : ""}${retrieval?.state === "error" || retrieval?.state === "blocked" ? " is-error" : ""}`}
        onClick={(event) => {
          event.stopPropagation();
          if (sourceCount === 0 && onManage) {
            onManage();
            return;
          }
          setOpen((value) => !value);
        }}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={status.label}
        title={status.detail}
      >
        <BookOpen size={15} />
        <span>{status.label}</span>
        {sourceCount > 0 && <ChevronDown size={13} />}
      </button>
      {open && sourceCount > 0 && (
        <div className="knowledge-picker__menu" role="menu" aria-label="个人知识库设置">
          <div className="knowledge-picker__heading">个人知识库</div>
          <div className="knowledge-picker__hint">
            在本机检索，命中的片段会随问题发送给当前模型，并要求回答标注来源。
          </div>
          {([
            ["auto", "自动使用", "从相关文件中检索，未命中时正常回答"],
            ["off", "本次关闭", "当前任务不读取个人知识库"],
          ] as const).map(([value, label, description]) => (
            <button
              key={value}
              type="button"
              role="menuitemradio"
              aria-checked={mode === value}
              className="knowledge-picker__option"
              onClick={() => {
                setMode(value);
                setOpen(false);
              }}
            >
              <span className="knowledge-picker__check">{mode === value && <Check size={15} />}</span>
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
            </button>
          ))}
          <div className="knowledge-picker__sources" title={sources.map((source) => source.label).join("\n")}>
            已连接 {sourceCount} 个知识源
          </div>
          {retrieval?.state === "used" && (
            <div className="knowledge-picker__last-results">
              <strong>上次回答引用</strong>
              {retrieval.items.map((item, index) => item.path ? (
                <button
                  key={`${item.path}-${index}`}
                  type="button"
                  title={item.path}
                  onClick={() => void openLocalPath(item.path!).catch(() => {})}
                >
                  {item.title}
                </button>
              ) : <span key={`${item.title}-${index}`}>{item.title}</span>)}
            </div>
          )}
          {onManage && (
            <button
              type="button"
              className="knowledge-picker__manage"
              onClick={() => { setOpen(false); onManage(); }}
            >
              管理个人知识库
            </button>
          )}
        </div>
      )}
    </div>
  );
}
