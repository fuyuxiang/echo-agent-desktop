/**
 * 插件面板 - 对接 EchoAgent 的 echo.agent/plugins/list + echo.agent/plugins/action
 *
 * 显示已安装的 EchoAgent 插件（含 skills/agents/hooks/mcp 计数），支持启用/禁用。
 * 对应 EchoAgent 的 plugins-panel。
 *
 * 插件来源：~/.echo-agent/plugins/、项目 .echo-agent/plugins/ 及已配置的本地目录。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  PuzzlePieceIcon,
  RefreshCwIcon,
  SparklesIcon,
  SkillIcon,
  AgentToolIcon,
  McpIcon,
} from "@/foundation/components/Icon/icons";
import { pluginsAction, pluginsList } from "@/lib/agent-client";
import type { PluginEntry } from "@/lib/types";
import { CapabilityEmptyState, CapabilityError, CapabilityPage } from "./experts-panel/shared/CapabilityPage";

interface PluginsPanelProps {
  /** Current session id (for the plugins/list call). */
  sessionId?: string;
  onToast?: (msg: string) => void;
}

export function PluginsPanel({ sessionId, onToast }: PluginsPanelProps) {
  const [plugins, setPlugins] = useState<PluginEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const reloadGeneration = useRef(0);
  const actionInFlight = useRef(false);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;

  const reload = useCallback(async (rescan = false) => {
    const generation = ++reloadGeneration.current;
    setLoading(true);
    setLoadError(null);
    try {
      if (rescan && sessionId) {
        await pluginsAction(sessionId, { type: "reload" });
        if (reloadGeneration.current !== generation) return;
      }
      const resp = await pluginsList(sessionId);
      if (reloadGeneration.current !== generation) return;
      setPlugins(resp.plugins ?? []);
    } catch (e) {
      if (reloadGeneration.current !== generation) return;
      const message = String(e).replace(/^Error:\s*/, "");
      setLoadError(message);
      onToast?.(`加载插件失败：${message}`);
    } finally {
      if (reloadGeneration.current === generation) setLoading(false);
    }
  }, [sessionId, onToast]);

  useEffect(() => {
    void reload();
    return () => { reloadGeneration.current += 1; };
  }, [reload]);

  useEffect(() => { setPlugins([]); }, [sessionId]);

  const handleToggle = useCallback(
    async (plugin: PluginEntry) => {
      if (actionInFlight.current) return;
      if (!sessionId) {
        onToast?.("请先从首页发起任务，再启用或禁用插件");
        return;
      }
      const pluginId = plugin.id ?? plugin.name;
      actionInFlight.current = true;
      setBusy(pluginId);
      try {
        await pluginsAction(sessionId, {
          type: plugin.enabled ? "disable" : "enable",
          // Runtime actions use the stable backend-generated ID; display names
          // are not unique across project/user scopes.
          pluginId,
        });
        if (currentSession.current !== sessionId) return;
        onToast?.(plugin.enabled ? `已禁用「${plugin.name}」` : `已启用「${plugin.name}」`);
        await reload();
      } catch (e) {
        onToast?.(`操作失败：${String(e).replace(/^Error:\s*/, "")}`);
      } finally {
        actionInFlight.current = false;
        setBusy(null);
      }
    },
    [sessionId, onToast, reload],
  );

  const enabledCount = plugins.filter((p) => p.enabled).length;
  const trustedCount = plugins.filter((p) => p.trusted).length;
  const query = search.trim().toLowerCase();
  const visible = plugins.filter(plugin => !query || [plugin.name, plugin.description, plugin.root, scopeLabel(plugin.scope)]
    .some(value => value?.toLowerCase().includes(query)));

  return (
    <CapabilityPage title="已安装插件" className="capability-page--plugins"
      search={{ value: search, onChange: setSearch, label: "搜索插件", placeholder: "搜索插件…" }}
      actions={
        <button
          type="button" className="capability-button"
          onClick={() => void reload(true)}
          disabled={loading || busy !== null}
          title="刷新"
        >
          <RefreshCwIcon size="sm" /> 刷新
        </button>
      }
      summary={loadError && plugins.length === 0
          ? "插件列表未加载"
          : loading && plugins.length === 0 ? "正在读取插件…" : `${plugins.length} 个插件 · ${enabledCount} 启用 · ${trustedCount} 受信任`}>

      {!sessionId && (
        <p className="capability-notice">
          启用或禁用插件需要已打开的任务会话，请先从首页发起任务。
        </p>
      )}

      <div className="plugins-panel__list">
        {loadError && (
          <CapabilityError onRetry={() => void reload(true)} retrying={loading || busy !== null}>
            插件列表加载失败：{loadError}{plugins.length > 0 ? "。下方保留上次加载的结果。" : ""}
          </CapabilityError>
        )}
        {plugins.length === 0 && !loading && !loadError && (
          <CapabilityEmptyState icon={<PuzzlePieceIcon size="lg" />} title="暂无插件。"
            description="支持加载本地插件，安装位置和加载方式见下方说明。" />
        )}
        {plugins.length > 0 && visible.length === 0 && (
          <CapabilityEmptyState icon={<PuzzlePieceIcon size="lg" />} title={`没有找到与「${search}」匹配的插件`} onClear={() => setSearch("")} />
        )}
        {visible.map((p) => (
          <div
            key={p.id ?? p.name}
            className={`plugins-panel__item ${p.enabled ? "" : "plugins-panel__item--muted"}`}
          >
            <div className="plugins-panel__item-icon">
              <PuzzlePieceIcon size="md" />
            </div>
            <div className="plugins-panel__item-content">
              <div className="plugins-panel__item-name">
                {p.name}
                {p.version && (
                  <span className="plugins-panel__version">v{p.version}</span>
                )}
                <span className={`plugins-panel__scope plugins-panel__scope--${p.scope}`}>
                  {scopeLabel(p.scope)}
                </span>
                {!p.trusted && (
                  <span className="plugins-panel__warn">未受信任</span>
                )}
              </div>
              {p.description && (
                <div className="plugins-panel__item-desc">{p.description}</div>
              )}
              <div className="plugins-panel__item-meta">
                {p.skillCount !== undefined && p.skillCount > 0 && (
                  <span title="技能"><SkillIcon size="sm" /> {p.skillCount}</span>
                )}
                {p.agentCount !== undefined && p.agentCount > 0 && (
                  <span title="专家"><AgentToolIcon size="sm" /> {p.agentCount}</span>
                )}
                {p.mcpServerCount !== undefined && p.mcpServerCount > 0 && (
                  <span title="MCP"><McpIcon size="sm" /> {p.mcpServerCount}</span>
                )}
                {p.hookCount !== undefined && p.hookCount > 0 && (
                  <span title="Hooks"><SparklesIcon size="sm" /> {p.hookCount}</span>
                )}
              </div>
            </div>
            <div className="plugins-panel__item-actions">
              <button
                className={`plugins-panel__toggle ${p.enabled ? "plugins-panel__toggle--on" : ""}`}
                onClick={() => handleToggle(p)}
                disabled={loading || busy !== null || !sessionId}
                title={p.enabled ? "禁用" : "启用"}
              >
                {busy === (p.id ?? p.name) ? "…" : p.enabled ? "已启用" : "已禁用"}
              </button>
            </div>
          </div>
        ))}
        {loading && <div className="capability-loading" role="status">加载中…</div>}
      </div>
      <details className="capability-help">
        <summary>本地插件加载说明</summary>
        <p>默认用户插件目录为 <code>~/.echo-agent/plugins/</code>，项目插件目录为 <code>.echo-agent/plugins/</code>；自定义数据目录下使用对应的 <code>plugins/</code> 文件夹。</p>
        <p>新建任务时会加载本地插件；已有任务可点击「刷新」重新加载。</p>
      </details>
    </CapabilityPage>
  );
}

function scopeLabel(scope?: string): string {
  switch (scope) {
    case "user":
      return "用户";
    case "project":
      return "项目";
    case "config":
      return "配置";
    case "cli":
      return "命令行";
    default:
      return scope ?? "";
  }
}
