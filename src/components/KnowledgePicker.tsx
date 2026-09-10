import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Building2, Check, ChevronDown, FolderOpen } from "lucide-react";
import { agentSetKnowledgeSources } from "@/lib/agent-client";
import { listKbProviders } from "@/lib/knowledge-base";
import { useKnowledgeStore, type KnowledgeSource } from "@/stores/knowledge-store";
import { useOrgSessionStore } from "@/stores/org-session-store";

function sourceLabel(sources: KnowledgeSource[]): string {
  if (sources.length === 0) return "知识来源";
  if (sources.length === 2) return "知识来源 2";
  return sources[0] === "personal" ? "个人知识" : "组织知识";
}

export function KnowledgePicker({
  sessionId,
  disabled = false,
  onManage,
  onOpenOrganization,
  onToast,
}: {
  sessionId?: string;
  disabled?: boolean;
  onManage?: () => void;
  onOpenOrganization?: () => void;
  onToast?: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const sourceCount = useKnowledgeStore((state) => state.sourceCount);
  const defaultSources = useKnowledgeStore((state) => state.defaultSources);
  const sessionSources = useKnowledgeStore((state) => sessionId ? state.sessionSources[sessionId] : undefined);
  const selected = sessionId ? sessionSources ?? [] : defaultSources;
  const providers = useMemo(() => listKbProviders(), [sourceCount]);
  const orgSession = useOrgSessionStore((state) => state.session);
  const orgHydrated = useOrgSessionStore((state) => state.hydrated);
  const hasSharedScope = Boolean(orgSession?.bootstrap?.scopes.some(
    (scope) => scope.kind === "team" || scope.kind === "org",
  ));
  const organizationAvailable = orgHydrated
    && orgSession?.loggedIn === true
    && hasSharedScope
    && orgSession.organizationMemoryEnabled === true;
  const organizationReason = !orgHydrated
    ? "正在检查组织连接状态"
    : !orgSession?.loggedIn
      ? "登录组织后可用"
      : !hasSharedScope
        ? "当前账号暂无团队或组织知识权限"
        : !orgSession.organizationMemoryEnabled
          ? "组织服务不可连接或登录已过期"
          : "使用组织账号中你有权限的知识";

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

  const applySelection = (next: KnowledgeSource[]) => {
    if (syncingRef.current) return;
    const state = useKnowledgeStore.getState();
    if (sessionId) {
      const previous = [...selected];
      state.setSessionSources(sessionId, next);
      syncingRef.current = true;
      setSyncing(true);
      void agentSetKnowledgeSources(sessionId, next)
        .catch((error) => {
          // Native reconciliation is transactional; mirror that behaviour in
          // the picker so the checkmarks always describe the capabilities the
          // Runtime actually owns.
          useKnowledgeStore.getState().setSessionSources(sessionId, previous);
          onToast?.(`知识来源同步失败，已恢复上一选择：${String(error).replace(/^Error:\s*/, "")}`);
        })
        .finally(() => {
          syncingRef.current = false;
          setSyncing(false);
        });
    } else {
      state.setDefaultSources(next);
    }
  };

  const toggle = (source: KnowledgeSource) => {
    const active = selected.includes(source);
    if (!active && source === "personal" && sourceCount === 0) {
      setOpen(false);
      onManage?.();
      return;
    }
    if (!active && source === "organization" && !organizationAvailable) {
      return;
    }
    applySelection(active
      ? selected.filter((item) => item !== source)
      : [...selected, source]);
  };

  const personalSelected = selected.includes("personal");
  const organizationSelected = selected.includes("organization");
  const hasUnavailableSelection = (personalSelected && sourceCount === 0)
    || (organizationSelected && !organizationAvailable);
  const label = sourceLabel(selected);
  const detail = selected.length === 0
    ? "未选择知识来源，本次任务不会读取个人或组织知识库"
    : `已选择：${[
        personalSelected ? "个人知识库" : null,
        organizationSelected ? "组织知识库" : null,
      ].filter(Boolean).join("、")}`;

  return (
    <div className="knowledge-picker" ref={rootRef}>
      <button
        type="button"
        className={`knowledge-picker__trigger${selected.length > 0 ? " is-active" : ""}${hasUnavailableSelection ? " is-error" : ""}`}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        disabled={disabled}
        aria-busy={syncing}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label}${selected.length === 0 ? "，未选择" : ""}`}
        title={detail}
      >
        <BookOpen size={15} />
        <span>{label}</span>
        <ChevronDown size={13} />
      </button>

      {open && (
        <div className="knowledge-picker__menu" role="menu" aria-label="选择知识来源" aria-busy={syncing}>
          <div className="knowledge-picker__heading">知识来源</div>
          <div className="knowledge-picker__hint">
            可多选。未选择时不会读取任何知识库；选择只作用于当前任务。
          </div>

          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={personalSelected}
            aria-disabled={!personalSelected && sourceCount === 0}
            disabled={syncing}
            className={`knowledge-picker__source-option${personalSelected ? " is-selected" : ""}${sourceCount === 0 ? " is-unavailable" : ""}`}
            onClick={() => toggle("personal")}
          >
            <span className="knowledge-picker__source-icon"><FolderOpen size={16} /></span>
            <span className="knowledge-picker__source-copy">
              <span className="knowledge-picker__source-title">
                <strong>个人知识库</strong>
                <span className="knowledge-picker__availability">
                  {sourceCount > 0 ? `${sourceCount} 个来源` : "未配置"}
                </span>
              </span>
              <small>{sourceCount > 0 ? "来自「更多 → 个人知识库」中的本地文件夹" : "先添加本地文件夹后即可选择"}</small>
            </span>
            <span className="knowledge-picker__checkbox" aria-hidden="true">
              {personalSelected && <Check size={13} />}
            </span>
          </button>

          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={organizationSelected}
            aria-disabled={!organizationSelected && !organizationAvailable}
            disabled={syncing}
            className={`knowledge-picker__source-option${organizationSelected ? " is-selected" : ""}${!organizationAvailable ? " is-unavailable" : ""}`}
            onClick={() => toggle("organization")}
          >
            <span className="knowledge-picker__source-icon"><Building2 size={16} /></span>
            <span className="knowledge-picker__source-copy">
              <span className="knowledge-picker__source-title">
                <strong>组织知识库</strong>
                <span className={`knowledge-picker__availability${organizationAvailable ? " is-ready" : ""}`}>
                  {organizationAvailable ? "可用" : "不可用"}
                </span>
              </span>
              <small>{organizationReason}</small>
            </span>
            <span className="knowledge-picker__checkbox" aria-hidden="true">
              {organizationSelected && <Check size={13} />}
            </span>
          </button>

          {syncing && (
            <div className="knowledge-picker__connected" role="status" aria-live="polite">
              正在为当前任务同步知识来源…
            </div>
          )}

          {providers.length > 0 && (
            <div className="knowledge-picker__connected" title={providers.map((source) => source.label).join("\n")}>
              个人知识已连接：{providers.map((source) => source.label).join("、")}
            </div>
          )}

          <div className="knowledge-picker__actions">
            {onManage && (
              <button type="button" disabled={syncing} onClick={() => { setOpen(false); onManage(); }}>
                管理个人知识库
              </button>
            )}
            {!organizationAvailable && onOpenOrganization && (
              <button type="button" disabled={syncing} onClick={() => { setOpen(false); onOpenOrganization(); }}>
                {orgSession?.loggedIn ? "查看组织连接" : "登录组织"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
