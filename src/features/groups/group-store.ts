import { create } from "zustand";
import { useEffect } from "react";
import { groupList, groupSnapshot, onGroupChanged, type Group, type TeamTemplate } from "./group-client";
import { readDurable, writeDurable, isStringMap } from "@/lib/durable-ui-state";
import type { RuntimeTeamInfo } from "@/lib/agent-client";

export interface GroupDraftOptions { targets: string[]; discussion: boolean; replyTo: string | null }
interface GroupState {
  groups: Group[]; currentId: string | null; current: Group | null; error: string | null; loading: boolean;
  createFrom: { sessionId: string; team: RuntimeTeamInfo; referenceText?: string } | null;
  createTemplate: TeamTemplate | null;
  drafts: Record<string, string>;
  outbox: Record<string, string>;
  requestId: (id: string, fingerprint: string) => string;
  acknowledgeSend: (id: string) => void;
  readRevisions: Record<string, number>;
  markRead: (id: string, revision: number) => void;
  refresh: () => Promise<void>; select: (id: string | null) => Promise<void>;
  fromTeam: (sessionId: string, team: RuntimeTeamInfo, referenceText?: string) => void;
  setDraft: (id: string, text: string) => void;
  draftOptions: (id: string) => GroupDraftOptions;
  setDraftOptions: (id: string, options: GroupDraftOptions) => void;
}
let listGeneration = 0, selectionGeneration = 0;
export const useGroupStore = create<GroupState>((set, get) => ({
  groups: [], currentId: null, current: null, error: null, loading: false, createFrom: null, createTemplate: null,
  drafts: readDurable("echoagent.group-drafts.v1", {}, isStringMap),
  outbox: readDurable("echoagent.group-outbox.v1", {}, isStringMap),
  requestId: (id, fingerprint) => {
    try {
      const pending = JSON.parse(get().outbox[id] ?? "null");
      if (pending?.fingerprint === fingerprint && typeof pending.id === "string") return pending.id;
    } catch { /* Replace an invalid pending record before sending. */ }
    const requestId = crypto.randomUUID();
    const outbox = { ...get().outbox, [id]: JSON.stringify({ id: requestId, fingerprint }) };
    if (!writeDurable("echoagent.group-outbox.v1", outbox)) throw new Error("暂时无法保存待发送消息，请释放存储空间后重试");
    set({ outbox });
    return requestId;
  },
  acknowledgeSend: (id) => {
    const outbox = { ...get().outbox }; delete outbox[id];
    writeDurable("echoagent.group-outbox.v1", outbox); set({ outbox });
  },
  readRevisions: readDurable<Record<string, number>>("echoagent.group-read.v1", {}, (value): value is Record<string, number> => !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every(value => typeof value === "number" && Number.isFinite(value))),
  markRead: (id, revision) => { if ((get().readRevisions[id] ?? 0) >= revision) return; const readRevisions = { ...get().readRevisions, [id]: revision }; if (writeDurable("echoagent.group-read.v1", readRevisions)) set({ readRevisions }); },
  refresh: async () => {
    const generation = ++listGeneration;
    try {
      const groups = await groupList();
      if (!Array.isArray(groups)) throw new Error("群聊列表未返回有效数据，请稍后重试");
      if (generation !== listGeneration) return;
      set({ groups, error: null });
    } catch (error) { if (generation === listGeneration) set({ error: String(error).replace(/^Error:\s*/, "") }); }
  },
  select: async (id) => {
    const generation = ++selectionGeneration;
    set({ currentId: id, ...(get().current?.id === id ? {} : { current: null }), loading: !!id, createFrom: null, createTemplate: null });
    if (!id) return;
    try {
      const current = await groupSnapshot(id);
      if (!current || current.id !== id || !Array.isArray(current.messages) || !Array.isArray(current.members)) throw new Error("群聊记录未返回有效数据，请稍后重试");
      if (generation === selectionGeneration) {
        const previous = get().current;
        if (previous?.id === current.id) {
          const messages = new Map(previous.messages.map(message => [message.id, message]));
          current.messages = current.messages.map(message => {
            const old = messages.get(message.id);
            return old && JSON.stringify(old) === JSON.stringify(message) ? old : message;
          });
        }
        set({ current, loading: false, error: null });
      }
    } catch (error) { if (generation === selectionGeneration) set({ loading: false, error: String(error).replace(/^Error:\s*/, "") }); }
  },
  fromTeam: (sessionId, team, referenceText) => {
    const existing = get().groups.find(group => group.sourceSessionId === sessionId && group.sourceTeamId === team.teamId && !group.archived);
    if (existing) { void get().select(existing.id); return; }
    ++selectionGeneration;
    set({ currentId: null, current: null, createTemplate: null, createFrom: { sessionId, team, referenceText } });
  },
  setDraft: (id, text) => {
    const drafts = { ...get().drafts, [id]: text };
    if (writeDurable("echoagent.group-drafts.v1", drafts)) set({ drafts });
  },
  draftOptions: (id) => {
    const raw = get().drafts[`options:${id}`];
    if (raw) try {
      const value = JSON.parse(raw);
      if (Array.isArray(value.targets) && value.targets.every((target: unknown) => typeof target === "string") && typeof value.discussion === "boolean" && (value.replyTo === null || typeof value.replyTo === "string")) return value;
    } catch { /* Preserve the draft text even if its optional selection is invalid. */ }
    return { targets: [], discussion: false, replyTo: null };
  },
  setDraftOptions: (id, options) => {
    const key = `options:${id}`, raw = JSON.stringify(options);
    if (get().drafts[key] !== raw) get().setDraft(key, raw);
  },
}));

/** Mounted by App, so navigating away does not disconnect group updates. */
export function useGroupEvents(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    let closed = false, timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    const dirty = new Set<string>();
    void useGroupStore.getState().refresh();
    void onGroupChanged(id => {
      dirty.add(id);
      timer ??= setTimeout(() => {
        timer = undefined;
        if (closed) return;
        const state = useGroupStore.getState();
        void state.refresh();
        if (state.currentId && dirty.has(state.currentId)) void state.select(state.currentId);
        dirty.clear();
      }, 100);
    }).then(stop => { if (closed) stop(); else unlisten = stop; }).catch(error => useGroupStore.setState({ error: String(error) }));
    return () => { closed = true; unlisten?.(); if (timer) clearTimeout(timer); };
  }, [ready]);
}
