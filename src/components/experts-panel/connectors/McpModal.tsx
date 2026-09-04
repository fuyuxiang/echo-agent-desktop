import { useCallback, useEffect, useRef, useState } from "react";
import {
  XCloseIcon, SearchIcon, ConfigureIcon, McpIcon, DeleteIcon, RefreshCwIcon,
} from "@/foundation/components/Icon/icons";
import {
  mcpDelete, mcpList, mcpSetup, mcpToggle, mcpToggleTool, onMcpStatusEvent,
} from "@/lib/agent-client";
import { ensureSession } from "@/lib/ensure-session";
import { useSessionStore } from "@/stores/session-store";
import type { McpServerEntry } from "@/lib/types";
import { McpConfigEditor } from "./McpConfigEditor";
import { useModalFocus } from "@/lib/use-modal-focus";
import { useAppDialog } from "../../AppDialog";

/** MCP management with persisted state, live health and per-server tool details. */
export function McpModal({
  onClose, onToast, initialEditing = false, embedded = false,
}: {
  onClose: () => void;
  onToast?: (m: string) => void;
  initialEditing?: boolean;
  /** Render directly inside the connectors page instead of as a modal. */
  embedded?: boolean;
}) {
  const [editing, setEditing] = useState(initialEditing);
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mutating, setMutating] = useState<string | null>(null);
  const [setupDrafts, setSetupDrafts] = useState<Record<string, Record<string, string>>>({});
  const [diagnostics, setDiagnostics] = useState<Record<string, { status?: string; reason?: string; detail?: string }>>({});
  const dialogRef = useModalFocus<HTMLDivElement>(!embedded, onClose);
  const activeSessionId = useSessionStore((state) => state.sessionId);
  const { requestConfirmation, dialog } = useAppDialog(activeSessionId);
  const reloadGeneration = useRef(0);

  const reload = useCallback(async (refresh = false) => {
    const generation = ++reloadGeneration.current;
    refresh ? setRefreshing(true) : setLoading(true);
    setError("");
    try {
      const next = await mcpList(activeSessionId ?? undefined, refresh);
      if (reloadGeneration.current === generation) setServers(next);
    } catch (e) {
      if (reloadGeneration.current !== generation) return;
      const message = String(e).replace(/^Error:\s*/, "");
      setError(message);
      if (refresh) onToast?.(`MCP 诊断失败：${message}`);
    } finally {
      if (reloadGeneration.current === generation) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [activeSessionId, onToast]);

  useEffect(() => {
    void reload();
    return () => {
      reloadGeneration.current += 1;
    };
  }, [reload]);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    onMcpStatusEvent((payload) => {
      const status = payload as { name?: string; status?: string; reason?: string; detail?: string };
      if (status.name) {
        setDiagnostics((current) => ({ ...current, [status.name!]: status }));
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { void reload(); }, 250);
    }).then((fn) => { unlisten = fn; });
    return () => {
      if (timer) clearTimeout(timer);
      unlisten?.();
    };
  }, [reload]);

  const filtered = servers.filter((server) => {
    const query = search.trim().toLowerCase();
    return !query
      || server.name.toLowerCase().includes(query)
      || server.displayName?.toLowerCase().includes(query)
      || server.target?.toLowerCase().includes(query);
  });

  const handleToggle = async (server: McpServerEntry, enabled: boolean) => {
    setMutating(server.name);
    try {
      const result = await mcpToggle(
        activeSessionId ?? undefined,
        server.name,
        enabled,
      );
      const action = enabled ? "已启用" : "已停用";
      onToast?.(result.warnings[0] ? `${action}；${result.warnings[0]}` : action);
      await reload();
    } catch (e) {
      onToast?.(`切换失败：${String(e).replace(/^Error:\s*/, "")}`);
    } finally {
      setMutating(null);
    }
  };

  const handleDelete = (server: McpServerEntry) => {
    if (!server.editable) {
      onToast?.("该服务来自项目或插件，请在对应来源中管理");
      return;
    }
    requestConfirmation({
      title: `删除 MCP 服务“${server.displayName || server.name}”？`,
      description: "将移除本地服务配置。如需撤销第三方授权，还需前往对应服务处理。",
      confirmLabel: "删除服务",
      danger: true,
      action: async () => {
        setMutating(server.name);
        try {
          const result = await mcpDelete(
            activeSessionId ?? undefined,
            server.name,
          );
          if (expanded === server.name) setExpanded(null);
          await reload();
          onToast?.(result.warnings[0] ? `已删除；${result.warnings[0]}` : "已删除");
        } finally {
          setMutating(null);
        }
      },
      onError: (error) => onToast?.(`删除失败：${String(error).replace(/^Error:\s*/, "")}`),
    });
  };

  const handleSetup = async (server: McpServerEntry) => {
    if (!server.setup) return;
    const draft = setupDrafts[server.name] ?? {};
    const values = Object.fromEntries(server.setup.fields.map((field) => [
      field.id,
      draft[field.id] ?? server.setupValues[field.id] ?? field.default ?? "",
    ]).filter(([, value]) => Boolean(value)));
    const missing = server.setup.fields.find((field) => field.required && !values[field.id]);
    if (missing) {
      onToast?.(`请选择「${missing.label}」`);
      return;
    }
    setMutating(`setup:${server.name}`);
    try {
      const sessionId = activeSessionId ?? await ensureSession();
      await mcpSetup(sessionId, server.name, values);
      onToast?.(`已完成「${server.displayName || server.name}」配置并启动`);
      await reload(true);
    } catch (e) {
      onToast?.(`配置失败：${String(e).replace(/^Error:\s*/, "")}`);
    } finally {
      setMutating(null);
    }
  };

  const handleToolToggle = async (server: McpServerEntry, toolName: string, enabled: boolean) => {
    const key = `tool:${server.name}:${toolName}`;
    setMutating(key);
    try {
      const sessionId = activeSessionId;
      if (!sessionId) throw new Error("工具尚未加载到活动会话");
      await mcpToggleTool(sessionId, server.name, toolName, enabled);
      onToast?.(enabled ? "已在当前会话启用工具" : "已在当前会话停用工具");
      await reload();
    } catch (e) {
      onToast?.(`工具切换失败：${String(e).replace(/^Error:\s*/, "")}`);
    } finally {
      setMutating(null);
    }
  };

  const content = (
      <div
        ref={dialogRef}
        className={`mcp-modal${embedded ? " mcp-modal--embedded" : ""}`}
        onClick={(e) => e.stopPropagation()}
        role={embedded ? undefined : "dialog"}
        aria-modal={embedded ? undefined : "true"}
        aria-label={embedded ? undefined : "MCP 服务管理"}
        tabIndex={embedded ? undefined : -1}
      >
        <div className="mcp-modal-head">
          <div className="mcp-modal-titlewrap">
            <span className="mcp-modal-glyph"><McpIcon size="md" /></span>
            <div>
              <div className="mcp-modal-title">MCP 服务管理</div>
              <div className="mcp-modal-sub">配置可离线完成；有活动会话时自动热加载并显示实时健康状态</div>
            </div>
          </div>
          <div className="mcp-modal-headright">
            {!editing && (
              <>
                <button type="button" className="um-btn um-btn--grey"
                  disabled={refreshing} onClick={() => void reload(true)}>
                  <RefreshCwIcon size="sm" /><span>{refreshing ? "诊断中…" : "刷新诊断"}</span>
                </button>
                <button type="button" className="um-btn um-btn--grey" onClick={() => setEditing(true)}>
                  <ConfigureIcon size="sm" /><span>配置 MCP</span>
                </button>
              </>
            )}
            {!embedded && (
              <button type="button" className="mcp-modal-close" onClick={onClose} aria-label="关闭" data-modal-initial-focus>
                <XCloseIcon size="md" />
              </button>
            )}
          </div>
        </div>

        <div className="mcp-modal-body">
          {editing ? (
            <McpConfigEditor onBack={() => setEditing(false)}
              onSaved={() => void reload(true)} onToast={onToast} />
          ) : (
            <div className="mcp-panel">
              <div className="mcp-panel-searchrow">
                <div className="um-search um-search--flex">
                  <SearchIcon size="sm" className="um-search-icon" />
                  <input className="um-search-input" value={search} placeholder="搜索名称、命令或 URL…"
                    aria-label="搜索 MCP 服务"
                    onChange={(e) => setSearch(e.target.value)} />
                </div>
                <span className="mcp-summary">{servers.length} 个服务 · {servers.reduce((sum, s) => sum + s.tools.length, 0)} 个工具</span>
              </div>

              {error && (
                <div className="mcp-load-error">
                  <span>{error}</span>
                  <button type="button" onClick={() => void reload(true)}>重试</button>
                </div>
              )}

              {loading ? (
                <div className="ec-loading">加载中…</div>
              ) : error && servers.length === 0 ? null : servers.length === 0 ? (
                <div className="mcp-empty">
                  <McpIcon size="xl" className="mcp-empty-icon" />
                  <div className="mcp-empty-title">暂无 MCP 服务</div>
                  <div className="mcp-empty-hint">可直接配置，不需要先创建模型会话</div>
                  <button type="button" className="um-btn um-btn--primary" onClick={() => setEditing(true)}>
                    添加 MCP 服务
                  </button>
                </div>
              ) : filtered.length === 0 ? (
                <div className="mcp-empty">
                  <div className="mcp-empty-hint">没有匹配「{search}」的服务</div>
                </div>
              ) : (
                <div className="mcp-list">
                  {filtered.map((server) => {
                    const state = statusOf(server);
                    const isExpanded = expanded === server.name;
                    return (
                      <div key={server.name} className={`mcp-item-wrap${isExpanded ? " mcp-item-wrap--expanded" : ""}`}>
                        <div className="mcp-item">
                          <button type="button" className="mcp-item-main"
                            onClick={() => setExpanded(isExpanded ? null : server.name)}>
                            <span className={`mcp-dot mcp-dot--${state.tone}`} />
                            <div className="mcp-item-info">
                              <div className="mcp-item-name">
                                {server.displayName || server.name}
                                {server.displayName && <code>{server.name}</code>}
                              </div>
                              <div className="mcp-item-meta">
                                <span>{transportLabel(server.transport)}</span>
                                <span>·</span>
                                <span className={`mcp-state mcp-state--${state.tone}`}>{state.label}</span>
                                <span>·</span>
                                <span>{server.tools.length} 个工具</span>
                              </div>
                              {server.target && <div className="mcp-item-target" title={server.target}>{server.target}</div>}
                            </div>
                          </button>
                          <label className="sk-toggle" title={server.enabled ? "已启用" : "已停用"}>
                            <input type="checkbox" checked={server.enabled}
                              aria-label={`${server.enabled ? "停用" : "启用"} MCP 服务 ${server.displayName || server.name}`}
                              disabled={mutating === server.name || server.setupRequired}
                              onChange={() => void handleToggle(server, !server.enabled)} />
                            <span className="sk-toggle-track"><span className="sk-toggle-thumb" /></span>
                          </label>
                          {server.editable && (
                            <button type="button" className="sk-inst-del" title="删除用户配置"
                              aria-label={`删除 MCP 服务 ${server.displayName || server.name}`}
                              disabled={mutating === server.name}
                              onClick={() => void handleDelete(server)}><DeleteIcon size="sm" /></button>
                          )}
                        </div>
                        {isExpanded && (
                          <div className="mcp-item-details">
                            <div className="mcp-detail-grid">
                              <span>来源</span><strong>{server.source || "本地"}{server.vendor ? ` · ${server.vendor}` : ""}</strong>
                              <span>运行方式</span><strong>{server.live ? "当前会话已加载" : "已持久化，等待会话加载"}</strong>
                            </div>
                            {diagnostics[server.name]?.detail && (
                              <div className="mcp-diagnostic-detail">
                                <strong>{diagnostics[server.name].reason || "runtime"}</strong>
                                <span>{diagnostics[server.name].detail}</span>
                              </div>
                            )}
                            {server.setup && server.setup.fields.length > 0 && (
                              <div className="mcp-setup-form">
                                <strong>{server.setupRequired ? "完成服务配置" : "服务配置"}</strong>
                                {server.setup.fields.map((field) => (
                                  <label key={field.id}>
                                    <span>{field.label}{field.required ? " *" : ""}</span>
                                    <select
                                      value={setupDrafts[server.name]?.[field.id]
                                        ?? server.setupValues[field.id]
                                        ?? field.default
                                        ?? ""}
                                      onChange={(event) => setSetupDrafts((current) => ({
                                        ...current,
                                        [server.name]: {
                                          ...current[server.name],
                                          [field.id]: event.target.value,
                                        },
                                      }))}
                                    >
                                      <option value="">请选择</option>
                                      {field.options.map((option) => (
                                        <option key={option.value} value={option.value}>{option.label}</option>
                                      ))}
                                    </select>
                                  </label>
                                ))}
                                <button type="button" className="um-btn um-btn--primary"
                                  disabled={mutating === `setup:${server.name}`}
                                  onClick={() => void handleSetup(server)}>
                                  {mutating === `setup:${server.name}` ? "应用中…" : server.setupRequired ? "应用并启动" : "更新配置"}
                                </button>
                              </div>
                            )}
                            {server.tools.length > 0 ? (
                              <div className="mcp-tools">
                                {server.tools.map((tool) => (
                                  <div key={tool.name} className={`mcp-tool${tool.enabled ? "" : " mcp-tool--disabled"}`}>
                                    <div>
                                      <strong>{tool.displayName || tool.name}</strong>
                                      {tool.description && <span>{tool.description}</span>}
                                    </div>
                                    <label className="sk-toggle mcp-tool-toggle" title="仅影响当前会话">
                                      <input type="checkbox" checked={tool.enabled}
                                        aria-label={`${tool.enabled ? "停用" : "启用"}工具 ${tool.displayName || tool.name}`}
                                        disabled={mutating === `tool:${server.name}:${tool.name}`}
                                        onChange={() => void handleToolToggle(server, tool.name, !tool.enabled)} />
                                      <span className="sk-toggle-track"><span className="sk-toggle-thumb" /></span>
                                    </label>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="mcp-no-tools">
                                {server.live ? "当前未获取到工具，可点击「刷新诊断」重试" : "创建会话后将完成握手并列出工具"}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
        {dialog}
      </div>
  );

  if (embedded) return content;

  return (
    <div className="modal-overlay mcp-overlay" onClick={onClose}>
      {content}
    </div>
  );
}

function statusOf(server: McpServerEntry): { label: string; tone: string } {
  if (!server.enabled) return { label: "已停用", tone: "off" };
  if (server.authRequired) return { label: "待授权", tone: "warn" };
  if (server.setupRequired) return { label: "待配置", tone: "warn" };
  if (!server.live) return { label: "待会话启动", tone: "idle" };
  switch (server.status) {
    case "ready": return { label: "可用", tone: "ready" };
    case "initializing": return { label: "初始化中", tone: "loading" };
    case "unavailable": return { label: "不可用", tone: "error" };
    case "setuprequired": return { label: "待配置", tone: "warn" };
    default: return { label: "已加载", tone: "ready" };
  }
}

function transportLabel(transport?: string): string {
  if (transport === "stdio") return "本地 stdio";
  if (transport === "streamable_http") return "Streamable HTTP";
  if (transport === "managed_gateway") return "托管网关";
  return transport || "未知传输";
}
