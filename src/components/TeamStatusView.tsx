import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentsList, onTeamsChanged, teamCreate, teamDisband, teamSnapshot, type RuntimeTeamInfo } from "@/lib/agent-client";
import { deriveTeams, isTeamTool } from "@/lib/team-derive";
import { deriveSubagents } from "@/lib/subagents";
import { teamProgress, teamTasks } from "@/lib/team-progress";
import { useSubagentStore, type SubagentRuntime } from "@/stores/subagent-store";
import type { AgentEntry } from "@/lib/types";
import { useGroupStore } from "@/features/groups/group-store";
import type { ChatMessage } from "@/stores/session-store";

interface TeamStatusViewProps {
  sessionId: string | null;
  messages?: ChatMessage[];
  onUseTeam?: (teamId: string) => void;
  onViewTasks?: () => void;
  onOpenGroup?: (team: RuntimeTeamInfo) => void;
}
const EMPTY_LIVE: Record<string, SubagentRuntime> = {};
const EMPTY_MESSAGES: ChatMessage[] = [];
const readableError = (error: unknown) => String(error).replace(/^Error:\s*/, "");

export function TeamStatusView({ sessionId, messages = EMPTY_MESSAGES, onUseTeam, onViewTasks, onOpenGroup }: TeamStatusViewProps) {
  const linkedGroups = useGroupStore(state => state.groups);
  const [snapshot, setSnapshot] = useState<{ sessionId: string; teams: RuntimeTeamInfo[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const activeSession = useRef(sessionId);
  activeSession.current = sessionId;
  const loaded = snapshot?.sessionId === sessionId;
  const teams = loaded ? snapshot.teams : [];
  const liveMap = useSubagentStore((state) => sessionId ? state.bySession[sessionId] ?? EMPTY_LIVE : EMPTY_LIVE);
  const live = useMemo(() => Object.values(liveMap), [liveMap]);
  const activities = useMemo(() => deriveSubagents(messages), [messages]);
  const transcriptTeams = useMemo(() => deriveTeams(messages), [messages]);
  const lifecycle = JSON.stringify(messages.flatMap((message) => message.parts.flatMap((part) =>
    part.kind === "tool_call" && isTeamTool(part.toolCall) ? [[part.toolCall.toolCallId, part.toolCall.status]] : [])));

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    if (!sessionId) return;
    setLoading(true);
    try {
      const result = await teamSnapshot(sessionId);
      if (current !== generation.current || activeSession.current !== sessionId) return;
      setSnapshot({ sessionId, teams: result }); setError(null);
    } catch (cause) {
      if (current === generation.current && activeSession.current === sessionId) setError(readableError(cause));
    } finally {
      if (current === generation.current && activeSession.current === sessionId) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { void refresh(); }, [refresh, lifecycle]);
  useEffect(() => {
    let closed = false;
    let unlisten: (() => void) | undefined;
    void onTeamsChanged((changedSession) => { if (changedSession === sessionId) void refresh(); })
      .then((stop) => { if (closed) stop(); else unlisten = stop; })
      .catch(() => {});
    return () => { closed = true; unlisten?.(); };
  }, [sessionId, refresh]);
  useEffect(() => () => { generation.current += 1; }, []);

  const [formOpen, setFormOpen] = useState(false);
  const [experts, setExperts] = useState<AgentEntry[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [disbanding, setDisbanding] = useState<string | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  useEffect(() => {
    setFormOpen(false); setFormError(null); setError(null); setNotice(null); setDisbanding(null); setFormBusy(false); setMutationBusy(false);
  }, [sessionId]);

  const recovery = useMemo(() => {
    // Recovery requires durable evidence of delegation or an old create call.
    if (teams.length || (!activities.length && !live.length && !transcriptTeams.length)) return null;
    const old = transcriptTeams.find((team) => team.status === "completed" && team.members.length);
    if (old) return { name: old.teamId, text: old.members.join("、") };
    for (const message of [...messages].reverse()) {
      if (message.role !== "user") continue;
      const text = message.parts.map((part) => part.kind === "text" ? part.text : "").join("");
      if (/[？?`]/.test(text) || /如何|怎么|不要|如果/.test(text)) continue;
      const match = text.match(/(?:创建|组建|建立|新建)(?:一个)?(?:任务编组|专家团队|专家团|团队)\s*[「“"'‘]?([^\s，,。；;：:！!「」“”"'‘’]+)/);
      if (match) return { name: match[1], text };
    }
    return null;
  }, [teams.length, activities, live, transcriptTeams, messages]);

  const openForm = async (recover = false) => {
    const target = sessionId;
    setFormOpen(true); setFormBusy(true); setFormError(null); setNotice(null);
    setName(recover && recovery ? recovery.name : ""); setDescription(""); setSelected({});
    try {
      const entries = (await agentsList()).filter((agent) => agent.scope === "user");
      if (activeSession.current !== target) return;
      setExperts(entries);
      if (recover && recovery) setSelected(Object.fromEntries(entries.filter((agent) => recovery.text.includes(agent.name)).map((agent) => [agent.name, agent.description ?? ""])));
    } catch (cause) { if (activeSession.current === target) setFormError(`专家读取失败：${readableError(cause)}`); }
    finally { if (activeSession.current === target) setFormBusy(false); }
  };
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!sessionId || formBusy) return;
    const target = sessionId;
    if (!name.trim() || !Object.keys(selected).length) { setFormError("请填写任务编组名称，并至少选择一名专家。"); return; }
    setFormBusy(true); setFormError(null);
    try {
      await teamCreate(target, { team_id: name.trim(), members: Object.entries(selected).map(([member, role]) => ({ name: member, role })), description: description.trim() || undefined });
      if (activeSession.current !== target) return;
      setFormOpen(false); setNotice(`任务编组“${name.trim()}”已创建。请在对话中说明任务，再由 AI 分派给成员。`);
      await refresh();
    } catch (cause) { if (activeSession.current === target) setFormError(readableError(cause)); }
    finally { if (activeSession.current === target) setFormBusy(false); }
  };
  const disband = async (teamId: string) => {
    if (!sessionId || mutationBusy) return;
    const target = sessionId;
    setMutationBusy(true); setError(null);
    try {
      await teamDisband(target, teamId);
      if (activeSession.current !== target) return;
      setDisbanding(null); setNotice(`任务编组“${teamId}”已解散，专家和历史任务已保留。`); await refresh();
    } catch (cause) { if (activeSession.current === target) setError(readableError(cause)); }
    finally { if (activeSession.current === target) setMutationBusy(false); }
  };

  const transient = transcriptTeams.filter((team) => team.status !== "completed" && !teams.some((saved) => saved.teamId === team.teamId));
  return <div className="team-status-view" role="region" aria-label="任务编组状态">
    <div className="team-status-view__head">
      <span className="team-status-view__title">本会话任务编组 {teams.length > 0 && <span className="team-status-view__summary">{teams.length} 个 · {teams.reduce((count, team) => count + team.members.length, 0)} 名成员</span>}</span>
      <div className="team-status-view__head-actions">
        <button type="button" className="runtime-panel-refresh" onClick={() => void refresh()} disabled={!sessionId || loading}>{loading ? "刷新中…" : "刷新"}</button>
        <button type="button" className="team-status-view__primary" onClick={() => void openForm()} disabled={!sessionId || formOpen}>创建任务编组</button>
      </div>
    </div>
    {error && <div className="runtime-panel-empty runtime-panel-empty--error" role="alert">任务编组操作失败：{error}{loaded ? "。已保留上次结果，可重新刷新。" : "。请重试刷新。"}</div>}
    {notice && <p className="team-status-view__notice" role="status">{notice}</p>}
    {formOpen && <form className="team-status-view__form" aria-label="创建任务编组" onSubmit={(event) => void create(event)}>
      <label>任务编组名称<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required disabled={formBusy} placeholder="例如：需求交付组" /></label>
      <label>任务编组目标（选填）<textarea value={description} onChange={(event) => setDescription(event.target.value)} maxLength={4096} rows={2} disabled={formBusy} /></label>
      <fieldset disabled={formBusy}><legend>选择本地专家，并填写本任务编组分工</legend>
        {experts.map((expert) => <div className="team-status-view__expert" key={expert.name}>
          <label className="team-status-view__check"><input type="checkbox" checked={Object.prototype.hasOwnProperty.call(selected, expert.name)} onChange={(event) => setSelected((previous) => {
            if (event.target.checked) return { ...previous, [expert.name]: expert.description ?? "" }; const next = { ...previous }; delete next[expert.name]; return next;
          })} />{expert.name}</label>
          {Object.prototype.hasOwnProperty.call(selected, expert.name) && <input aria-label={`${expert.name}的分工`} maxLength={500} value={selected[expert.name]} onChange={(event) => setSelected((previous) => ({ ...previous, [expert.name]: event.target.value }))} placeholder="例如：分析需求与验收标准" />}
        </div>)}
        {!formBusy && experts.length === 0 && !formError && <p>还没有本地专家。请先到“专家”页面创建，再回来组队。</p>}
      </fieldset>
      {formError && <p className="runtime-panel-empty--error" role="alert">{formError}</p>}
      <div className="team-status-view__actions"><button type="button" className="runtime-panel-refresh" onClick={() => setFormOpen(false)} disabled={formBusy}>取消</button><button className="team-status-view__primary" type="submit" disabled={formBusy || !name.trim() || !Object.keys(selected).length}>{formBusy ? "正在准备…" : "确认创建"}</button>{formError && <button type="button" className="runtime-panel-refresh" onClick={() => void openForm(Boolean(recovery))}>重新读取专家</button>}</div>
    </form>}
    {!formOpen && !teams.length && !transient.length && !error && <div className="runtime-panel-empty" role={loading && !loaded ? "status" : undefined}>
      {!sessionId ? "开始会话后即可创建任务编组。" : loading && !loaded ? "正在读取任务编组状态…" : <>
        <p>本会话还没有任务编组。任务编组用于当前任务的成员分工；创建后可在对话中派发任务，也可用它创建独立的专家团。</p>
        {recovery && <><p>发现已分派的专家任务，但尚未登记任务编组。可恢复编组，已有任务会保留。</p><button type="button" className="team-status-view__primary" onClick={() => void openForm(true)}>恢复任务编组“{recovery.name}”</button></>}
        {!recovery && (activities.length > 0 || live.length > 0) && <p>已有专家任务可在“子代理”中查看。</p>}
      </>}
    </div>}
    {transient.map((team) => <p className="team-status-view__notice" role={team.status === "failed" ? "alert" : "status"} key={team.id}>{team.teamId || "任务编组"}：{team.status === "failed" ? "创建失败，请查看对话中的工具错误，或使用“创建任务编组”重新选择专家。" : "正在创建…"}</p>)}
    {teams.length > 0 && <ul className="team-status-view__list">{teams.map((team) => {
      const tasks = teamTasks(team, live, activities);
      const progress = teamProgress(team, tasks);
      return <li key={team.teamId} className="team-status-view__row">
        <div className="team-status-view__info">
          <div className="team-status-view__name-line"><strong className="team-status-view__team-id">{team.teamId}</strong><span className="team-status-view__status" data-status={progress}>{progress}</span></div>
          {team.description && <p className="team-status-view__description">{team.description}</p>}
          <ul className="team-status-view__member-list">{team.members.map((member) => {
            const own = tasks.filter((task) => task.member === member);
            const status = own.some((task) => ["running", "in_progress"].includes(task.status)) ? "执行中" : own.some((task) => ["failed", "cancelled"].includes(task.status)) ? "任务未完成" : own.length ? "已完成" : "待派发";
            return <li key={member}><span><strong>{member}</strong>{team.roles?.[member] && <small>{team.roles[member]}</small>}</span><span className="team-status-view__status" data-status={status}>{status}</span></li>;
          })}</ul>
          {tasks.length > 0 && <p className="team-status-view__description">{team.promptIds?.length ? "本轮任务" : "本会话成员任务"}：{tasks.filter((task) => task.status === "completed").length}/{tasks.length} 已完成</p>}
          <div className="team-status-view__actions">
            {onOpenGroup && <button type="button" className="team-status-view__primary" onClick={() => onOpenGroup(team)}>{linkedGroups.some(group => group.sourceSessionId === sessionId && group.sourceTeamId === team.teamId) ? "打开专家团" : "以此编组创建专家团"}</button>}
            {onUseTeam && <button type="button" className="runtime-panel-refresh" onClick={() => onUseTeam(team.teamId)}>使用此任务编组</button>}
            {onViewTasks && <button type="button" className="runtime-panel-refresh" onClick={onViewTasks}>查看任务详情</button>}
            <button type="button" className="runtime-panel-refresh" onClick={() => setDisbanding(team.teamId)} disabled={mutationBusy}>解散任务编组</button>
          </div>
          {disbanding === team.teamId && <div className="team-status-view__confirm" role="group" aria-label={`解散任务编组${team.teamId}`}><p>确认解散“{team.teamId}”？专家和历史任务会保留，运行中的任务会继续执行。</p><div className="team-status-view__actions"><button type="button" className="runtime-panel-refresh" onClick={() => setDisbanding(null)} disabled={mutationBusy}>取消解散</button><button type="button" className="team-status-view__primary" onClick={() => void disband(team.teamId)} disabled={mutationBusy}>{mutationBusy ? "正在解散…" : "确认解散"}</button></div></div>}
        </div>
      </li>;
    })}</ul>}
  </div>;
}
