import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  CheckCircle2,
  FileText,
  Loader2,
  LockKeyhole,
  LogOut,
  RefreshCw,
  Archive,
  History,
  ThumbsDown,
  ThumbsUp,
  Send,
  Upload,
  UserRound,
  UsersRound,
  WandSparkles,
  XCircle,
} from "lucide-react";
import { Markdown } from "./Markdown";
import {
  listenOrgAsk,
  orgAskCancel,
  orgAskStart,
  orgDocumentSubmissionsMine,
  orgArchiveDocument,
  orgFetchDocument,
  orgListDocuments,
  orgListScopes,
  orgListSkills,
  orgLogin,
  orgLogout,
  orgSession,
  orgSkillSubmissionsMine,
  orgSubmitDocument,
  orgNewDocumentVersion,
  orgPublishDocument,
  orgPublishSkill,
  orgQaFeedback,
  orgSetSkillPreference,
  orgSubmitSkill,
  orgSyncSkills,
  type AskCitation,
  type AskFinal,
  type OrgDocument,
  type OrgScope,
  type OrgSession,
  type OrgSkill,
  type Submission,
} from "@/lib/org-client";
import { useOrgSessionStore } from "@/stores/org-session-store";
import { filesystemPickFiles } from "@/lib/agent-client";

type Tab = "ask" | "documents" | "skills";

const scopeLabel = (kind: OrgScope["kind"]) =>
  kind === "personal" ? "仅自己" : kind === "team" ? "团队" : "全组织";

const stateLabel = (state: string) => ({
  pending: "待审核",
  approved: "已通过",
  rejected: "已拒绝",
  withdrawn: "已撤回",
  queued: "排队中",
  scanning: "扫描中",
  passed: "通过",
  processing: "解析中",
  parsing: "解析中",
  chunking: "切分中",
  embedding: "建立索引",
  ready: "可检索",
  failed: "处理失败",
  archived: "已归档",
}[state] ?? state);

const readableBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

function ScopeIcon({ kind }: { kind: OrgScope["kind"] }) {
  if (kind === "personal") return <UserRound size={14} />;
  if (kind === "team") return <UsersRound size={14} />;
  return <Building2 size={14} />;
}

export function OrganizationMemoryPanel({ onToast }: { onToast?: (message: string) => void }) {
  const [session, setSession] = useState<OrgSession | null>(null);
  const mirrorOrgSession = useOrgSessionStore((state) => state.setSession);
  const clearMirroredOrgSession = useOrgSessionStore((state) => state.clearSession);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState("https://");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [tab, setTab] = useState<Tab>("ask");
  const [scopes, setScopes] = useState<OrgScope[]>([]);
  const [selectedScope, setSelectedScope] = useState("");
  const [publishScope, setPublishScope] = useState("");
  const [documents, setDocuments] = useState<OrgDocument[]>([]);
  const [documentSubmissions, setDocumentSubmissions] = useState<Submission[]>([]);
  const [skills, setSkills] = useState<OrgSkill[]>([]);
  const [skillSubmissions, setSkillSubmissions] = useState<Submission[]>([]);
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState("auto");
  const [answer, setAnswer] = useState<AskFinal | null>(null);
  const [streamingAnswer, setStreamingAnswer] = useState("");
  const [streamingCitations, setStreamingCitations] = useState<AskCitation[]>([]);
  const [askStatus, setAskStatus] = useState("");
  const [asking, setAsking] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const activeRequest = useRef<string | null>(null);
  const ignoredRequests = useRef(new Set<string>());

  const loadWorkspace = useCallback(async () => {
    const [nextScopes, docs, nextSkills, docSubs, skillSubs] = await Promise.all([
      orgListScopes(),
      orgListDocuments(),
      orgListSkills(),
      orgDocumentSubmissionsMine(),
      orgSkillSubmissionsMine(),
    ]);
    setScopes(nextScopes);
    setDocuments(docs.items);
    setSkills(nextSkills);
    setDocumentSubmissions(docSubs);
    setSkillSubmissions(skillSubs);
    setSelectedScope((current) => nextScopes.some((scope) => scope.id === current)
      ? current
      : nextScopes.find((scope) => scope.kind === "personal")?.id || nextScopes[0]?.id || "");
    setPublishScope((current) => nextScopes.some((scope) => scope.id === current && scope.kind !== "personal")
      ? current
      : nextScopes.find((scope) => scope.kind === "team")?.id || nextScopes.find((scope) => scope.kind === "org")?.id || "");
  }, []);

  useEffect(() => {
    let alive = true;
    orgSession()
      .then(async (nextSession) => {
        if (!alive) return;
        setSession(nextSession);
        mirrorOrgSession(nextSession);
        if (nextSession.serverUrl) setServerUrl(nextSession.serverUrl);
        if (nextSession.user?.username) setUsername(nextSession.user.username);
        if (nextSession.loggedIn) await loadWorkspace();
      })
      .catch((reason) => alive && setError(String(reason)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [loadWorkspace, mirrorOrgSession]);

  useEffect(() => {
    if (!session?.loggedIn) return;
    const active = documentSubmissions.some((item) => item.scanStatus === "queued" || item.scanStatus === "scanning")
      || documents.some((item) => ["pending", "parsing", "chunking", "embedding"].includes(item.status));
    if (!active) return;
    const timer = window.setInterval(() => { void loadWorkspace(); }, 3000);
    return () => window.clearInterval(timer);
  }, [session?.loggedIn, documentSubmissions, documents, loadWorkspace]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listenOrgAsk((event) => {
      if (ignoredRequests.current.has(event.requestId)) return;
      if (activeRequest.current && event.requestId !== activeRequest.current) return;
      if (event.event === "status") {
        const data = event.data as { message?: string };
        setAskStatus(data.message ?? "正在处理…");
      } else if (event.event === "citation") {
        const citation = event.data as AskCitation;
        setStreamingCitations((current) => current.some((item) => item.id === citation.id) ? current : [...current, citation]);
      } else if (event.event === "delta") {
        const data = event.data as { text?: string };
        if (data.text) setStreamingAnswer((current) => current + data.text);
      } else if (event.event === "final") {
        setAnswer(event.data as AskFinal);
        setStreamingAnswer("");
        setStreamingCitations([]);
        setAskStatus("");
        setAsking(false);
        activeRequest.current = null;
      } else if (event.event === "error") {
        const data = event.data as { message?: string };
        setError(data.message ?? "组织问答失败");
        setStreamingAnswer("");
        setStreamingCitations([]);
        setAskStatus("");
        setAsking(false);
        activeRequest.current = null;
      }
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const uploadScope = useMemo(
    () => scopes.find((scope) => scope.id === selectedScope),
    [scopes, selectedScope],
  );
  const allowSkillSubmission = session?.bootstrap?.policy.allowSkillSubmission !== false;
  const allowDocumentUpload = uploadScope?.kind !== "personal"
    || session?.bootstrap?.policy.allowPersonalCloud !== false;
  const visibleDocuments = useMemo(
    () => selectedScope ? documents.filter((document) => document.scopeId === selectedScope) : documents,
    [documents, selectedScope],
  );
  const visibleSkills = useMemo(
    () => selectedScope ? skills.filter((skill) => skill.scopeId === selectedScope) : skills,
    [skills, selectedScope],
  );
  const visibleDocumentSubmissions = useMemo(
    () => selectedScope ? documentSubmissions.filter((submission) => submission.scopeId === selectedScope) : documentSubmissions,
    [documentSubmissions, selectedScope],
  );
  const visibleSkillSubmissions = useMemo(
    () => selectedScope ? skillSubmissions.filter((submission) => submission.scopeId === selectedScope) : skillSubmissions,
    [skillSubmissions, selectedScope],
  );

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const next = await orgLogin(serverUrl, username, password);
      setSession(next);
      mirrorOrgSession(next);
      setPassword("");
      await loadWorkspace();
    } catch (reason) {
      setError(String(reason).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
      setLoading(false);
    }
  };

  const refreshWorkspace = async () => {
    setBusy(true);
    setError(null);
    try {
      await loadWorkspace();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const resetWorkspace = () => {
    if (activeRequest.current) ignoredRequests.current.add(activeRequest.current);
    activeRequest.current = null;
    setSession({ loggedIn: false });
    clearMirroredOrgSession();
    setScopes([]);
    setSelectedScope("");
    setPublishScope("");
    setDocuments([]);
    setDocumentSubmissions([]);
    setSkills([]);
    setSkillSubmissions([]);
    setAnswer(null);
    setFeedbackSent(false);
    setStreamingAnswer("");
    setStreamingCitations([]);
    setAskStatus("");
    setAsking(false);
  };

  const handleLogout = async () => {
    setBusy(true);
    setError(null);
    // Hide the previous user's workspace immediately. Native logout clears its
    // local session before making a short best-effort server revocation call.
    resetWorkspace();
    try {
      await orgLogout();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const handleAsk = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = question.trim();
    if (!text || asking) return;
    setError(null);
    setAnswer(null);
    setStreamingAnswer("");
    setStreamingCitations([]);
    setAsking(true);
    setAskStatus("正在连接组织知识服务…");
    try {
      const requestId = await orgAskStart(text, mode, selectedScope ? [selectedScope] : undefined);
      activeRequest.current = requestId;
    } catch (reason) {
      setAsking(false);
      setAskStatus("");
      setError(String(reason));
    }
  };

  const cancelAsk = async () => {
    const requestId = activeRequest.current;
    if (requestId) ignoredRequests.current.add(requestId);
    activeRequest.current = null;
    setAsking(false);
    setAskStatus("");
    setStreamingAnswer("");
    setStreamingCitations([]);
    if (!requestId) return;
    try {
      await orgAskCancel(requestId);
    } catch (reason) {
      setError(String(reason));
    }
  };

  const pickAndUploadDocument = async () => {
    if (!uploadScope) return;
    const [path] = await filesystemPickFiles({
      multiple: false,
      title: "选择要提交的可检索文档",
      extensions: ["md", "txt", "pdf", "docx", "xlsx", "pptx", "png", "jpg", "jpeg"],
    });
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      const result = await orgSubmitDocument(path, uploadScope.id);
      onToast?.(result.state === "pending" ? "文档已提交，等待组织审核" : "文档已提交，正在建立索引");
      await loadWorkspace();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pickAndUploadSkill = async () => {
    if (!uploadScope) return;
    const [path] = await filesystemPickFiles({
      multiple: false,
      title: "选择要提交的 Skill ZIP",
      extensions: ["zip"],
    });
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      const result = await orgSubmitSkill(path, uploadScope.id);
      onToast?.(result.state === "pending" ? "Skill 已提交，等待组织审核" : "Skill 已发布，可以同步使用");
      await loadWorkspace();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const uploadNewVersion = async (document: OrgDocument) => {
    const extensions = document.sourceType === "image" ? ["png", "jpg", "jpeg"] : [document.sourceType];
    const [path] = await filesystemPickFiles({
      multiple: false,
      title: "选择同类型新版本",
      extensions,
    });
    if (!path) return;
    setBusy(true);
    try {
      await orgNewDocumentVersion(document.id, path);
      onToast?.("新版本已上传；索引完成前旧版本继续生效");
      await loadWorkspace();
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };

  const archiveDocument = async (document: OrgDocument) => {
    setBusy(true);
    try {
      await orgArchiveDocument(document.id);
      onToast?.("文档已归档并从检索中移除");
      await loadWorkspace();
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };

  const publishDocument = async (document: OrgDocument) => {
    if (!publishScope) return;
    setBusy(true);
    try {
      const result = await orgPublishDocument(document.id, publishScope);
      onToast?.(result.state === "pending" ? "已生成不可变副本并提交审核" : "文档副本已发布");
      await loadWorkspace();
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };

  const toggleSkill = async (skill: OrgSkill) => {
    setBusy(true);
    try {
      await orgSetSkillPreference(skill.skillId, !skill.enabled);
      onToast?.(skill.enabled
        ? "Skill 已从用户全局技能目录卸载"
        : "Skill 已安装到用户全局技能目录");
      await loadWorkspace();
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };

  const publishSkill = async (skill: OrgSkill) => {
    if (!publishScope) return;
    setBusy(true);
    try {
      const result = await orgPublishSkill(skill.skillId, publishScope);
      onToast?.(result.state === "pending" ? "Skill 副本已提交目标范围审核" : "Skill 副本已发布");
      await loadWorkspace();
    } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };

  const sendFeedback = async (feedback: "helpful" | "not_helpful" | "wrong") => {
    if (!answer?.qaEventId) return;
    try {
      await orgQaFeedback(answer.qaEventId, feedback);
      setFeedbackSent(true);
      onToast?.("感谢反馈");
    } catch (reason) { setError(String(reason)); }
  };

  const syncSkills = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await orgSyncSkills();
      onToast?.(`已同步 ${result.installed.length} 个已安装 Skills`);
      await loadWorkspace();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return <div className="org-memory org-memory--center"><Loader2 className="org-memory__spin" />正在连接组织服务…</div>;
  }

  if (!session?.loggedIn) {
    return (
      <div className="org-memory org-memory--login">
        <div className="org-login-card">
          <div className="org-login-card__mark"><Building2 size={28} /></div>
          <h1>连接组织</h1>
          <p>登录企业服务器后，可在授权范围内共享文档、Skills，并基于组织知识进行可追溯问答。</p>
          <form onSubmit={handleLogin}>
            <label>服务器地址<input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="https://memory.company.com" required /></label>
            <label>账号<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required /></label>
            <label>密码<input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required /></label>
            {error && <div className="org-memory__error"><XCircle size={15} />{error}</div>}
            <button className="org-memory__primary" disabled={busy}>{busy && <Loader2 className="org-memory__spin" size={15} />}安全登录</button>
          </form>
          <div className="org-login-card__security"><LockKeyhole size={14} />生产服务器强制 HTTPS；访问令牌只保存在 Rust 内存中。</div>
        </div>
      </div>
    );
  }

  return (
    <div className="org-memory">
      <header className="org-memory__header">
        <div>
          <div className="org-memory__eyebrow">ENTERPRISE MEMORY</div>
          <h1>组织</h1>
          <p>{session.user?.displayName ?? session.user?.username} · {session.serverUrl}</p>
        </div>
        <div className="org-memory__header-actions">
          <button onClick={() => void refreshWorkspace()} disabled={busy}><RefreshCw size={15} />刷新</button>
          <button onClick={() => void handleLogout()} disabled={busy}><LogOut size={15} />退出组织</button>
        </div>
      </header>

      <div className="org-memory__scopebar">
        <span>当前知识范围</span>
        <select value={selectedScope} onChange={(event) => setSelectedScope(event.target.value)}>
          <option value="">我有权限的全部范围</option>
          {scopes.map((scope) => <option key={scope.id} value={scope.id}>{scopeLabel(scope.kind)} · {scope.name}</option>)}
        </select>
        {uploadScope && <span className={`org-scope-badge org-scope-badge--${uploadScope.kind}`}><ScopeIcon kind={uploadScope.kind} />{scopeLabel(uploadScope.kind)}</span>}
      </div>

      <nav className="org-memory__tabs">
        <button className={tab === "ask" ? "active" : ""} onClick={() => setTab("ask")}><WandSparkles size={16} />组织问答</button>
        <button className={tab === "documents" ? "active" : ""} onClick={() => setTab("documents")}><FileText size={16} />文档 <span>{visibleDocuments.length}</span></button>
        <button className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}><CheckCircle2 size={16} />Skills <span>{visibleSkills.length}</span></button>
      </nav>

      {error && <div className="org-memory__error"><XCircle size={15} />{error}<button onClick={() => setError(null)}>关闭</button></div>}

      {tab === "ask" && (
        <section className="org-ask">
          <div className="org-ask__intro">
            <h2>向组织知识提问</h2>
            <p>答案只使用你有权限查看的当前版本文档；每个结论都带原文引用。个人空间内容不会被同事检索。</p>
          </div>
          <form className="org-ask__composer" onSubmit={handleAsk}>
            <textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：公司的差旅住宿标准是什么？" rows={4} />
            <div>
              <select value={mode} onChange={(event) => setMode(event.target.value)}>
                <option value="auto">自动判断</option><option value="fast">快速检索</option><option value="deep">深度综合</option>
              </select>
              {asking ? <button type="button" onClick={() => void cancelAsk()}><XCircle size={15} />停止</button> : <button className="org-memory__primary" disabled={!question.trim()}><Send size={15} />提问</button>}
            </div>
          </form>
          {askStatus && <div className="org-ask__status"><Loader2 className="org-memory__spin" size={15} />{askStatus}</div>}
          {asking && (streamingAnswer || streamingCitations.length > 0) && (
            <article className="org-answer">
              <div className="org-answer__meta"><span>正在生成</span></div>
              {streamingAnswer && <Markdown>{streamingAnswer}</Markdown>}
              {streamingCitations.length > 0 && <CitationList citations={streamingCitations} />}
            </article>
          )}
          {answer && (
            <article className="org-answer">
              <div className="org-answer__meta"><span>{answer.mode === "deep" ? "深度综合" : "快速检索"}</span><span>置信度 {Math.round(answer.confidence * 100)}%</span><span>{answer.verification}</span></div>
              {answer.insufficient ? <div className="org-answer__empty">授权范围内没有足够证据回答这个问题。</div> : <Markdown>{answer.answer}</Markdown>}
              {answer.citations.length > 0 && <CitationList citations={answer.citations} />}
              {answer.qaEventId && <div className="org-library__actions">{feedbackSent ? <span>已记录反馈</span> : <><button onClick={() => void sendFeedback("helpful")}><ThumbsUp size={13} />有帮助</button><button onClick={() => void sendFeedback("not_helpful")}><ThumbsDown size={13} />没帮助</button><button onClick={() => void sendFeedback("wrong")}>引用有误</button></>}</div>}
            </article>
          )}
        </section>
      )}

      {tab === "documents" && (
        <section className="org-library">
          <div className="org-library__toolbar">
            <div><h2>共享文档</h2><p>个人范围自动发布；团队/组织范围由成员提交、知识管理员审核后才进入检索。</p></div>
            <div className="org-library__actions">{uploadScope?.kind === "personal" && <select value={publishScope} onChange={(event) => setPublishScope(event.target.value)}><option value="">选择副本发布目标</option>{scopes.filter((scope) => scope.kind !== "personal").map((scope) => <option key={scope.id} value={scope.id}>{scopeLabel(scope.kind)} · {scope.name}</option>)}</select>}<button className="org-memory__primary" onClick={() => void pickAndUploadDocument()} disabled={busy || !uploadScope || !allowDocumentUpload}><Upload size={15} />上传到当前范围</button></div>
          </div>
          <div className="org-library__list">
            {visibleDocuments.length === 0 && <div className="org-library__empty">当前授权范围还没有已发布文档</div>}
            {visibleDocuments.map((document) => {
              const mayManage = document.scopeKind === "personal" || session.user?.role !== "member";
              return <div className="org-library__row" key={document.id}>
                <div className="org-library__icon"><FileText size={18} /></div>
                <div className="org-library__main"><strong>{document.title}</strong><span>{document.scopeName} · {document.sourceType.toUpperCase()} · {readableBytes(document.byteSize)} · {document.chunkCount} 个知识片段</span>{document.failReason && <em>{document.failReason}</em>}</div>
                <div className="org-library__actions">{document.scopeKind === "personal" && <button onClick={() => void publishDocument(document)} disabled={busy || !publishScope}>发布副本</button>}{mayManage && <><button onClick={() => void uploadNewVersion(document)} disabled={busy}><History size={13} />新版本</button><button onClick={() => void archiveDocument(document)} disabled={busy}><Archive size={13} />归档</button></>}<span className={`org-state org-state--${document.status}`}>{stateLabel(document.status)}</span></div>
              </div>
            })}
          </div>
          <SubmissionList title="我的文档提交" submissions={visibleDocumentSubmissions} />
        </section>
      )}

      {tab === "skills" && (
        <section className="org-library">
          <div className="org-library__toolbar">
            <div><h2>组织 Skills</h2><p>点击安装后下载到用户全局 <code>~/.echo-agent/skills/organization</code>，专家技能页直接读取并使用。</p></div>
            <div className="org-library__actions"><button onClick={() => void syncSkills()} disabled={busy}><RefreshCw size={15} />安全同步</button><button className="org-memory__primary" onClick={() => void pickAndUploadSkill()} disabled={busy || !uploadScope || !allowSkillSubmission}><Upload size={15} />上传 ZIP</button></div>
          </div>
          <div className="org-skill-grid">
            {visibleSkills.length === 0 && <div className="org-library__empty">当前授权范围还没有已发布 Skills</div>}
            {visibleSkills.map((skill) => (
              <article className="org-skill-card" key={skill.skillId}>
                <div><strong>{skill.name}</strong><span>v{skill.version}</span></div>
                <p>{skill.description}</p>
                <footer><span className={`org-scope-badge org-scope-badge--${skill.scopeKind}`}><ScopeIcon kind={skill.scopeKind} />{skill.scopeName}</span>{skill.scopeKind === "personal" && <button onClick={() => void publishSkill(skill)} disabled={busy || !publishScope}>发布副本</button>}{skill.mandatory ? <span className="org-state org-state--ready">组织强制 · 已安装</span> : <button onClick={() => void toggleSkill(skill)} disabled={busy}>{skill.enabled ? "卸载" : "安装"}</button>}</footer>
              </article>
            ))}
          </div>
          <SubmissionList title="我的 Skill 提交" submissions={visibleSkillSubmissions} />
        </section>
      )}
    </div>
  );
}

export function parseEchoDocumentUrl(value: string): { docId: string; page?: number } {
  const url = new URL(value);
  if (url.protocol !== "echo:" || url.hostname !== "doc") throw new Error("引用链接协议无效");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const docId = parts[0];
  if (!docId) throw new Error("引用缺少文档 ID");
  const pageFromPath = parts[1] === "page" ? Number(parts[2]) : undefined;
  const pageFromQuery = url.searchParams.has("page") ? Number(url.searchParams.get("page")) : undefined;
  const page = pageFromPath ?? pageFromQuery;
  if (page !== undefined && (!Number.isInteger(page) || page < 1)) throw new Error("引用页码无效");
  return { docId, ...(page !== undefined ? { page } : {}) };
}

function CitationList({ citations }: { citations: AskCitation[] }) {
  const [preview, setPreview] = useState<{ id: string; text: string } | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openCitation = async (citation: AskCitation) => {
    if (preview?.id === citation.id) { setPreview(null); return; }
    setLoadingId(citation.id);
    setError(null);
    try {
      const target = parseEchoDocumentUrl(citation.openUrl);
      if (target.docId !== citation.docId) throw new Error("引用文档 ID 与签名结果不一致");
      const document = await orgFetchDocument(target.docId, target.page ?? citation.page ?? undefined);
      setPreview({ id: citation.id, text: document.text });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoadingId(null);
    }
  };
  return <div className="org-citations"><h3>引用依据</h3>{error && <div className="org-citation__error">{error}</div>}{citations.map((citation) => <div className="org-citation" key={citation.id}><div><span>{citation.id}</span><strong>{citation.title}</strong>{citation.page != null && <em>第 {citation.page} 页</em>}{citation.stale && <em className="org-citation__stale">可能过时</em>}<button onClick={() => void openCitation(citation)} disabled={loadingId === citation.id}>{loadingId === citation.id ? <Loader2 className="org-memory__spin" size={12} /> : <FileText size={12} />}{preview?.id === citation.id ? "收起原文" : "查看原文"}</button></div><blockquote>{citation.quote}</blockquote>{preview?.id === citation.id && <pre className="org-citation__preview">{preview.text}</pre>}</div>)}</div>;
}

function SubmissionList({ title, submissions }: { title: string; submissions: Submission[] }) {
  if (submissions.length === 0) return null;
  return <div className="org-submissions"><h3>{title}</h3>{submissions.slice(0, 8).map((submission) => <div key={submission.id ?? submission.submissionId}><span>{submission.title ?? submission.name} {submission.version ? `v${submission.version}` : ""}</span><small>{submission.scopeName}</small>{submission.scanStatus && <span className={`org-state org-state--${submission.scanStatus}`}>扫描：{stateLabel(submission.scanStatus)}</span>}<span className={`org-state org-state--${submission.state}`}>{stateLabel(submission.state)}</span>{submission.reviewNote && <em>{submission.reviewNote}</em>}{submission.scanReport?.findings.filter((item) => item.severity !== "info").map((item) => <em key={`${item.code}-${item.path ?? ""}`}>{item.code}：{item.message}{item.path ? ` (${item.path})` : ""}</em>)}</div>)}</div>;
}
