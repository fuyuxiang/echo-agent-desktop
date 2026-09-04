/**
 * 通知渠道管理面板 —— IM 渠道替代的 UI。
 *
 * 列出已注册通知渠道(Slack/Discord/webhook/desktop),支持添加/移除/测试发送。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadNotifyChannels,
  saveNotifyChannel,
  removeNotifyChannel,
  setNotifyChannelEnabled,
  testNotifyChannel,
  type NotifyChannel,
  type ChannelKind,
} from "@/lib/notify-channels";
import { useAppDialog } from "./AppDialog";

const KIND_LABELS: Record<ChannelKind, string> = {
  "slack-webhook": "Slack",
  "discord-webhook": "Discord",
  "generic-webhook": "Webhook",
  email: "邮件（旧配置，已停用）",
  desktop: "桌面通知",
};

const ADDABLE_KINDS: ChannelKind[] = [
  "slack-webhook",
  "discord-webhook",
  "generic-webhook",
  "desktop",
];

export function NotifyChannelsPanel({ onToast }: { onToast?: (msg: string) => void }) {
  const [channels, setChannels] = useState<NotifyChannel[]>([]);
  // 新渠道表单。
  const [newKind, setNewKind] = useState<ChannelKind>("slack-webhook");
  const [newLabel, setNewLabel] = useState("");
  const [newEndpoint, setNewEndpoint] = useState("");
  const { requestConfirmation, dialog } = useAppDialog();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutating, setMutating] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const mutationInFlight = useRef(false);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setLoadError(null);
    try {
      const items = await loadNotifyChannels();
      if (loadGeneration.current === generation) setChannels(items);
    } catch (error) {
      if (loadGeneration.current !== generation) return;
      const message = String(error).replace(/^Error:\s*/, "");
      setLoadError(message);
      onToast?.(`读取通知渠道失败：${message}`);
    } finally {
      if (loadGeneration.current === generation) setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current += 1;
    };
  }, [load]);

  const add = async () => {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    const id = `ch_${Date.now()}`;
    const label = newLabel.trim() || KIND_LABELS[newKind];
    const channel: NotifyChannel = {
      id,
      label,
      kind: newKind,
      endpoint: newEndpoint.trim() || undefined,
      enabled: true,
    };
    setMutating("add");
    try {
      await saveNotifyChannel(channel);
      setChannels((items) => [...items.filter((item) => item.id !== id), channel]);
    } catch (error) {
      onToast?.(`添加失败：${String(error).replace(/^Error:\s*/, "")}`);
      return;
    } finally {
      mutationInFlight.current = false;
      setMutating(null);
    }
    setNewLabel("");
    setNewEndpoint("");
    onToast?.(`已添加渠道 ${label}`);
  };

  const remove = (channel: NotifyChannel) => {
    requestConfirmation({
      title: "移除通知渠道？",
      description: `将移除“${channel.label}”的本机配置，之后不再向该渠道发送通知。`,
      confirmLabel: "移除",
      danger: true,
      action: async () => {
        await removeNotifyChannel(channel.id);
        setChannels((items) => items.filter((item) => item.id !== channel.id));
        onToast?.("已移除渠道");
      },
      onError: (error) => onToast?.(`移除失败：${String(error).replace(/^Error:\s*/, "")}`),
    });
  };

  const toggle = async (id: string) => {
    if (mutationInFlight.current) return;
    const ch = channels.find((c) => c.id === id);
    if (!ch) return;
    mutationInFlight.current = true;
    setMutating(`toggle:${id}`);
    try {
      await setNotifyChannelEnabled(id, !ch.enabled);
      setChannels((items) => items.map((item) => item.id === id ? { ...item, enabled: !item.enabled } : item));
    } catch (error) {
      onToast?.(`修改失败：${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      mutationInFlight.current = false;
      setMutating(null);
    }
  };

  const testSend = async (id: string) => {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setMutating(`test:${id}`);
    try {
      const result = await testNotifyChannel(id);
      onToast?.(result.ok ? "测试通知已发送" : `发送失败：${result.error ?? "检查 endpoint"}`);
    } catch (error) {
      onToast?.(`发送失败：${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      mutationInFlight.current = false;
      setMutating(null);
    }
  };

  return (
    <div className="notify-panel" role="region" aria-label="通知渠道">
      <div className="notify-panel__head">
        <span className="notify-panel__title">通知渠道</span>
        <span className="notify-panel__hint">推送 agent 通知到 Slack、Discord、Webhook 或系统桌面通知</span>
      </div>

      {loadError && (
        <div className="panel-inline-error" role="alert">
          <span>通知渠道加载失败：{loadError}</span>
          <button type="button" onClick={() => void load()} disabled={loading}>
            {loading ? "重试中…" : "重试"}
          </button>
        </div>
      )}
      {loading && channels.length === 0 && <div className="notify-panel__empty">正在加载通知渠道…</div>}

      {/* 已注册渠道列表 */}
      {channels.length > 0 ? (
        <ul className="notify-panel__list">
          {channels.map((ch) => (
            <li key={ch.id} className={"notify-panel__row" + (ch.enabled ? "" : " disabled")}>
              <span className="notify-panel__row-kind">{KIND_LABELS[ch.kind]}</span>
              <span className="notify-panel__row-label">{ch.label}</span>
              {ch.endpoint && <span className="notify-panel__row-endpoint" title={ch.endpoint}>{ch.endpoint.slice(0, 40)}{ch.endpoint.length > 40 ? "…" : ""}</span>}
              <div className="notify-panel__row-actions">
                <button type="button" className="notify-panel__btn" onClick={() => void toggle(ch.id)} title={ch.enabled ? "禁用" : "启用"} aria-label={`${ch.enabled ? "禁用" : "启用"} ${ch.label}`} disabled={mutating !== null}>
                  <span className={ch.enabled ? "notify-dot notify-dot--on" : "notify-dot"} />
                </button>
                <button type="button" className="notify-panel__btn" onClick={() => void testSend(ch.id)} disabled={!ch.enabled || mutating !== null} title="测试发送">
                  测试
                </button>
                <button type="button" className="notify-panel__btn notify-panel__btn--danger" onClick={() => remove(ch)} title="移除" aria-label={`移除 ${ch.label}`} disabled={mutating !== null}>
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : !loading && !loadError ? (
        <div className="notify-panel__empty">暂无通知渠道</div>
      ) : null}

      {/* 添加新渠道 */}
      <div className="notify-panel__add">
        <select aria-label="通知渠道类型" value={newKind} onChange={(e) => setNewKind(e.target.value as ChannelKind)}>
          {ADDABLE_KINDS.map((kind) => (
            <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>
          ))}
        </select>
        <input
          type="text"
          aria-label="通知渠道显示名"
          placeholder="显示名(可选)"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
        />
        <input
          type="text"
          aria-label="Webhook URL"
          placeholder={newKind === "desktop" ? "(桌面通知无需 endpoint)" : "Webhook URL"}
          value={newEndpoint}
          onChange={(e) => setNewEndpoint(e.target.value)}
          disabled={newKind === "desktop"}
        />
        <button type="button" className="notify-panel__add-btn" onClick={() => void add()} disabled={mutating !== null}>
          {mutating === "add" ? "添加中…" : "+ 添加"}
        </button>
      </div>
      {dialog}
    </div>
  );
}
