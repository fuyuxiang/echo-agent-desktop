import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  BookOpenCheck,
  BrainCircuit,
  Building2,
  CheckCircle2,
  FileText,
  Loader2,
  LockKeyhole,
  LogOut,
  RefreshCw,
  History,
  LayoutDashboard,
  MessageSquareText,
  Plus,
  Upload,
  UserRound,
  UsersRound,
  XCircle,
} from "lucide-react";
import {
  orgDocumentSubmissionsMine,
  orgArchiveDocument,
  orgListDocuments,
  orgListMemories,
  orgListScopes,
  orgListSkills,
  orgLogin,
  orgLogout,
  orgMemoryPromotionsMine,
  orgSession,
  orgSkillSubmissionsMine,
  orgSubmitDocument,
  orgSubmitMemoryCandidate,
  orgNewDocumentVersion,
  orgPublishDocument,
  orgPublishSkill,
  orgSetSkillPreference,
  orgSubmitSkill,
  orgSyncSkills,
  type OrgDocument,
  type OrgMemory,
  type OrgMemoryKind,
  type OrgScope,
  type OrgSession,
  type OrgSkill,
  type MemoryPromotion,
  type Submission,
} from "@/lib/org-client";
import { useOrgSessionStore } from "@/stores/org-session-store";
import { filesystemPickFiles } from "@/lib/agent-client";

type Tab = "overview" | "memories" | "documents" | "skills";

const memoryKindLabel: Record<OrgMemoryKind, string> = {
  fact: "事实",
  decision: "决策",
  convention: "规范",
  pitfall: "踩坑",
  howto: "操作手册",
};

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

async function settleWithConcurrency<T>(
  items: string[],
  limit: number,
  task: (item: string) => Promise<T>,
  onProgress: (completed: number) => void,
): Promise<PromiseSettledResult<T>[]> {
  const results = new Array<PromiseSettledResult<T>>(items.length);
  let cursor = 0;
  let completed = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await task(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      } finally {
        completed += 1;
        onProgress(completed);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

function ScopeIcon({ kind }: { kind: OrgScope["kind"] }) {
  if (kind === "personal") return <UserRound size={14} />;
  if (kind === "team") return <UsersRound size={14} />;
  return <Building2 size={14} />;
}

export function OrganizationMemoryPanel({
  onToast,
  cwd,
  onStartConversation,
}: {
  onToast?: (message: string) => void;
  cwd?: string;
  onStartConversation?: () => void;
}) {
  const [session, setSession] = useState<OrgSession | null>(null);
  const mirroredSession = useOrgSessionStore((state) => state.session);
  const mirrorOrgSession = useOrgSessionStore((state) => state.setSession);
  const clearMirroredOrgSession = useOrgSessionStore((state) => state.clearSession);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    label: string;
    completed: number;
    total: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState("https://");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [scopes, setScopes] = useState<OrgScope[]>([]);
  const [selectedScope, setSelectedScope] = useState("");
  const [writeScope, setWriteScope] = useState("");
  const [publishScope, setPublishScope] = useState("");
  const [documents, setDocuments] = useState<OrgDocument[]>([]);
  const [memories, setMemories] = useState<OrgMemory[]>([]);
  const [memoryPromotions, setMemoryPromotions] = useState<MemoryPromotion[]>([]);
  const [documentSubmissions, setDocumentSubmissions] = useState<Submission[]>([]);
  const [skills, setSkills] = useState<OrgSkill[]>([]);
  const [skillSubmissions, setSkillSubmissions] = useState<Submission[]>([]);
  const [showMemoryForm, setShowMemoryForm] = useState(false);
  const [memoryKind, setMemoryKind] = useState<OrgMemoryKind>("howto");
  const [memoryContent, setMemoryContent] = useState("");
  const [memoryRationale, setMemoryRationale] = useState("");
  const [memoryOutcome, setMemoryOutcome] = useState("");
  const [memoryWorkspace, setMemoryWorkspace] = useState("");
  const [memoryValidUntil, setMemoryValidUntil] = useState("");

  useEffect(() => {
    if (mirroredSession) setSession(mirroredSession);
  }, [mirroredSession]);

  const loadWorkspace = useCallback(async () => {
    const [nextScopes, docs, nextSkills, docSubs, skillSubs, nextMemories, promotions] = await Promise.all([
      orgListScopes(),
      orgListDocuments(),
      orgListSkills(),
      orgDocumentSubmissionsMine(),
      orgSkillSubmissionsMine(),
      orgListMemories(),
      orgMemoryPromotionsMine(),
    ]);
    setScopes(nextScopes);
    setDocuments(docs.items);
    setSkills(nextSkills);
    setDocumentSubmissions(docSubs);
    setSkillSubmissions(skillSubs);
    setMemories(nextMemories);
    setMemoryPromotions(promotions.filter((item) => item.payloadType === "memory"));
    setSelectedScope((current) => nextScopes.some((scope) => scope.id === current)
      ? current
      : "");
    setWriteScope((current) => nextScopes.some((scope) => scope.id === current)
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

  const uploadScope = useMemo(
    () => scopes.find((scope) => scope.id === writeScope),
    [scopes, writeScope],
  );
  const allowSkillSubmission = session?.bootstrap?.policy.allowSkillSubmission !== false;
  const allowDocumentUpload = uploadScope?.kind !== "personal"
    || session?.bootstrap?.policy.allowPersonalCloud !== false;
  const visibleDocuments = useMemo(
    () => selectedScope ? documents.filter((document) => document.scopeId === selectedScope) : documents,
    [documents, selectedScope],
  );
  const visibleMemories = useMemo(
    () => selectedScope ? memories.filter((memory) => memory.scopeId === selectedScope) : memories,
    [memories, selectedScope],
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
      const nextSession = await orgSession();
      setSession(nextSession);
      mirrorOrgSession(nextSession);
      if (!nextSession.loggedIn) {
        resetWorkspace();
        return;
      }
      await loadWorkspace();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const resetWorkspace = () => {
    setSession({ loggedIn: false });
    clearMirroredOrgSession();
    setScopes([]);
    setSelectedScope("");
    setWriteScope("");
    setPublishScope("");
    setDocuments([]);
    setMemories([]);
    setMemoryPromotions([]);
    setDocumentSubmissions([]);
    setSkills([]);
    setSkillSubmissions([]);
    setTab("overview");
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

  const pickAndUploadDocument = async () => {
    if (!uploadScope) return;
    setError(null);
    try {
      const paths = await filesystemPickFiles({
        multiple: true,
        maxFiles: 50,
        title: "选择要提交的可检索文档（可多选）",
        extensions: ["md", "txt", "pdf", "docx", "xlsx", "pptx", "png", "jpg", "jpeg"],
      });
      if (!paths || paths.length === 0) return;
      await uploadDocumentsInBatch(paths, uploadScope.id);
    } catch (reason) {
      setError(`选择文档失败：${String(reason).replace(/^Error:\s*/, "")}`);
    }
  };

  const uploadDocumentsInBatch = async (paths: string[], scopeId: string) => {
    setBusy(true);
    setError(null);
    setUploadProgress({ label: "正在上传文档", completed: 0, total: paths.length });
    let batchError: string | null = null;
    try {
      const settled = await settleWithConcurrency(
        paths,
        3,
        (path) => orgSubmitDocument(path, scopeId),
        (completed) => setUploadProgress({
          label: "正在上传文档",
          completed,
          total: paths.length,
        }),
      );
      const failures: string[] = [];
      let done = 0;
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") done += 1;
        else failures.push(`${paths[index]}: ${String(result.reason).replace(/^Error:\s*/, "")}`);
      });
      batchError = failures.length > 0 ? failures.slice(0, 3).join("\n") : null;
      setError(batchError);
      if (done > 0) {
        onToast?.(
          failures.length > 0
            ? `已上传 ${done} 个文档，失败 ${failures.length} 个`
            : `已上传 ${done} 个文档，正在建立索引`,
        );
      } else {
        onToast?.(`上传失败：${failures[0] ?? "未知原因"}`);
      }
      setUploadProgress({ label: "正在刷新列表", completed: paths.length, total: paths.length });
      await loadWorkspace();
    } catch (reason) {
      const refreshError = `刷新列表失败：${String(reason).replace(/^Error:\s*/, "")}`;
      setError(batchError ? `${batchError}\n${refreshError}` : refreshError);
    } finally {
      setUploadProgress(null);
      setBusy(false);
    }
  };

  const submitMemoryCandidate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!writeScope || !memoryContent.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await orgSubmitMemoryCandidate({
        targetScopeId: writeScope,
        kind: memoryKind,
        content: memoryContent.trim(),
        rationale: memoryRationale.trim(),
        outcome: memoryOutcome.trim(),
        workspaceRef: memoryWorkspace.trim(),
        validUntil: memoryValidUntil
          ? new Date(`${memoryValidUntil}T23:59:59`).getTime()
          : undefined,
      });
      setMemoryContent("");
      setMemoryRationale("");
      setMemoryOutcome("");
      setMemoryWorkspace("");
      setMemoryValidUntil("");
      setShowMemoryForm(false);
      onToast?.("经验候选已提交，审核通过后会进入 Agent 工作上下文");
      await loadWorkspace();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const pickAndUploadSkill = async () => {
    if (!uploadScope) return;
    setError(null);
    let paths: string[];
    try {
      paths = await filesystemPickFiles({
        multiple: true,
        maxFiles: 50,
        title: "选择要提交的 Skill ZIP（可多选）",
        extensions: ["zip"],
      });
    } catch (reason) {
      setError(`选择 Skill ZIP 失败：${String(reason).replace(/^Error:\s*/, "")}`);
      return;
    }
    if (!paths || paths.length === 0) return;
    setBusy(true);
    setUploadProgress({ label: "正在上传 Skill", completed: 0, total: paths.length });
    let batchError: string | null = null;
    try {
      const settled = await settleWithConcurrency(
        paths,
        3,
        (path) => orgSubmitSkill(path, uploadScope.id),
        (completed) => setUploadProgress({
          label: "正在上传 Skill",
          completed,
          total: paths.length,
        }),
      );
      const failures: string[] = [];
      let done = 0;
      settled.forEach((result, index) => {
        if (result.status === "fulfilled") done += 1;
        else failures.push(`${paths[index]}: ${String(result.reason).replace(/^Error:\s*/, "")}`);
      });
      batchError = failures.length > 0 ? failures.slice(0, 3).join("\n") : null;
      setError(batchError);
      if (done > 0) {
        onToast?.(
          failures.length > 0
            ? `已上传 ${done} 个 Skill，失败 ${failures.length} 个`
            : "Skill 已提交，等待组织审核",
        );
      } else {
        onToast?.(`Skill 上传失败：${failures[0] ?? "未知原因"}`);
      }
      setUploadProgress({ label: "正在刷新列表", completed: paths.length, total: paths.length });
      await loadWorkspace();
    } catch (reason) {
      const refreshError = `刷新列表失败：${String(reason).replace(/^Error:\s*/, "")}`;
      setError(batchError ? `${batchError}\n${refreshError}` : refreshError);
    } finally {
      setUploadProgress(null);
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
          <p>登录企业服务器后，可在授权范围内共享文档、Skills 和经验；Agent 会在执行前自动召回规则、手册与踩坑记录。</p>
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

  const pendingCount = documentSubmissions.filter((item) => item.state === "pending" || item.scanStatus === "queued" || item.scanStatus === "scanning").length
    + skillSubmissions.filter((item) => item.state === "pending" || item.scanStatus === "queued" || item.scanStatus === "scanning").length
    + memoryPromotions.filter((item) => item.state === "pending").length
    + documents.filter((item) => ["pending", "parsing", "chunking", "embedding"].includes(item.status)).length;
  const pageTitle = tab === "overview" ? "组织知识"
    : tab === "memories" ? "经验"
      : tab === "documents" ? "文档" : "组织 Skills";
  const pageDescription = tab === "overview" ? "管理可供 Agent 使用的组织经验、文档与 Skills。"
    : tab === "memories" ? "沉淀决策、规范、操作手册和踩坑记录，供 Agent 在任务前召回。"
      : tab === "documents" ? "管理组织知识来源、版本状态和检索可用性。"
        : "查看组织分发的能力包，并管理当前设备上的安装状态。";

  return (
    <div className="org-memory">
      <header className="org-memory__header">
        <div>
          <div className="org-memory__eyebrow">组织工作台</div>
          <h1>{session.bootstrap?.scopes.find((scope) => scope.kind === "org")?.name ?? "组织知识管理中心"}</h1>
          <p>{session.user?.displayName ?? session.user?.username} · {session.serverUrl}</p>
          <span className={`org-memory__capability ${session.organizationMemoryEnabled ? "is-active" : ""}`}>
            <i />{session.organizationMemoryEnabled
              ? "Agent 组织上下文已启用"
              : session.bootstrap?.scopes?.some((scope) => scope.kind === "team" || scope.kind === "org")
                ? "Agent 组织上下文暂不可用"
                : "未加入共享组织范围"}
          </span>
        </div>
        <div className="org-memory__header-actions">
          <button onClick={() => void refreshWorkspace()} disabled={busy}><RefreshCw size={15} />刷新</button>
          <button onClick={() => void handleLogout()} disabled={busy}><LogOut size={15} />退出组织</button>
        </div>
      </header>

      <div className="org-memory__workspace">
        <nav className="org-memory__nav" aria-label="组织功能">
          <div className="org-memory__nav-label">工作台</div>
          <button className={tab === "overview" ? "active" : ""} aria-current={tab === "overview" ? "page" : undefined} onClick={() => setTab("overview")}><LayoutDashboard size={16} /><span>概览</span></button>
          <div className="org-memory__nav-label">知识资产</div>
          <button className={tab === "memories" ? "active" : ""} aria-current={tab === "memories" ? "page" : undefined} onClick={() => setTab("memories")}><BrainCircuit size={16} /><span>经验</span><em>{memories.length}</em></button>
          <button className={tab === "documents" ? "active" : ""} aria-current={tab === "documents" ? "page" : undefined} onClick={() => setTab("documents")}><FileText size={16} /><span>文档</span><em>{documents.length}</em></button>
          <div className="org-memory__nav-label">能力分发</div>
          <button className={tab === "skills" ? "active" : ""} aria-current={tab === "skills" ? "page" : undefined} onClick={() => setTab("skills")}><CheckCircle2 size={16} /><span>Skills</span><em>{skills.length}</em></button>
        </nav>

        <main className="org-memory__content">
          <div className="org-memory__page-header">
            <div><h2>{pageTitle}</h2><p>{pageDescription}</p></div>
            {tab !== "overview" && <label className="org-memory__filter"><span>查看范围</span><select value={selectedScope} onChange={(event) => setSelectedScope(event.target.value)}><option value="">全部授权范围</option>{scopes.map((scope) => <option key={scope.id} value={scope.id}>{scopeLabel(scope.kind)} · {scope.name}</option>)}</select></label>}
          </div>

          {error && <div className="org-memory__error"><XCircle size={15} />{error}<button onClick={() => setError(null)}>关闭</button></div>}
          {uploadProgress && <div className="org-memory__upload-progress" role="status" aria-live="polite"><Loader2 className="org-memory__spin" size={15} /><span>{uploadProgress.label}</span><strong>{uploadProgress.completed}/{uploadProgress.total}</strong></div>}

          {tab === "overview" && <section className="org-overview">
            <div className="org-overview__hero">
              <div className="org-overview__hero-icon"><MessageSquareText size={22} /></div>
              <div><h3>在对话中使用组织知识</h3><p>发起任务时自动选择组织知识，可连续追问，也可以让 Agent 结合组织规则直接执行。</p></div>
              <button className="org-memory__primary" onClick={onStartConversation} disabled={!session.organizationMemoryEnabled || !onStartConversation}>发起对话</button>
            </div>
            <div className="org-overview__metrics" aria-label="组织知识概况">
              <button type="button" onClick={() => setTab("memories")}><span>已发布经验</span><strong>{memories.length}</strong><small>{memoryPromotions.filter((item) => item.state === "pending").length} 条待审核</small></button>
              <button type="button" onClick={() => setTab("documents")}><span>可检索文档</span><strong>{documents.filter((item) => item.status === "ready").length}</strong><small>{documents.filter((item) => item.status !== "ready" && item.status !== "archived").length} 条处理中</small></button>
              <button type="button" onClick={() => setTab("skills")}><span>已安装 Skills</span><strong>{skills.filter((item) => item.enabled).length}/{skills.length}</strong><small>{skills.filter((item) => item.mandatory).length} 个组织强制</small></button>
            </div>
            <div className="org-overview__attention">
              <div><h3>需要关注</h3><p>聚合当前账号需要处理的提交、同步与索引状态。</p></div>
              {pendingCount === 0 ? <div className="org-library__empty">当前没有待处理事项</div> : <div className="org-overview__attention-row"><AlertTriangle size={17} /><span>共有 {pendingCount} 项内容正在审核、扫描或建立索引</span><button type="button" onClick={() => setTab(documents.some((item) => item.status !== "ready" && item.status !== "archived") ? "documents" : "skills")}>查看详情</button></div>}
            </div>
          </section>}

      {tab === "memories" && (
        <section className="org-library">
          <div className="org-library__toolbar">
            <div><h2>组织经验</h2><p>决策、规范、操作手册和踩坑记录会在 Agent 执行相关任务前自动召回；每条都保留来源、时效和审核状态。</p></div>
            <button className="org-memory__primary" onClick={() => {
              setMemoryWorkspace((value) => value || cwd || "");
              setShowMemoryForm((value) => !value);
            }} disabled={!writeScope}><Plus size={15} />提交经验</button>
          </div>
          {showMemoryForm && (
            <form className="org-memory-form" onSubmit={submitMemoryCandidate}>
              <label>发布范围<select value={writeScope} onChange={(event) => setWriteScope(event.target.value)} required><option value="">选择范围</option>{scopes.map((scope) => <option key={scope.id} value={scope.id}>{scopeLabel(scope.kind)} · {scope.name}</option>)}</select></label>
              <label>类型<select value={memoryKind} onChange={(event) => setMemoryKind(event.target.value as OrgMemoryKind)}>{Object.entries(memoryKindLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label className="org-memory-form__wide">经验内容<textarea required maxLength={2000} rows={4} value={memoryContent} onChange={(event) => setMemoryContent(event.target.value)} placeholder="写成可直接指导下一次任务的明确结论或步骤" /></label>
              <label className="org-memory-form__wide">为什么有效<textarea maxLength={2000} rows={2} value={memoryRationale} onChange={(event) => setMemoryRationale(event.target.value)} placeholder="背景、适用条件或决策依据（建议填写）" /></label>
              <label>结果<input maxLength={2000} value={memoryOutcome} onChange={(event) => setMemoryOutcome(event.target.value)} placeholder="例如：构建时间下降 30%" /></label>
              <label>项目/工作空间<input maxLength={1000} value={memoryWorkspace} onChange={(event) => setMemoryWorkspace(event.target.value)} placeholder="可选，用于项目定向召回" /></label>
              <label>有效期<input type="date" value={memoryValidUntil} onChange={(event) => setMemoryValidUntil(event.target.value)} /></label>
              <div className="org-memory-form__actions"><button type="button" onClick={() => setShowMemoryForm(false)}>取消</button><button className="org-memory__primary" disabled={busy || !memoryContent.trim()}>{busy && <Loader2 className="org-memory__spin" size={14} />}提交审核</button></div>
            </form>
          )}
          <div className="org-library__list">
            {visibleMemories.length === 0 && <div className="org-library__empty">当前范围还没有可用于任务的组织经验</div>}
            {visibleMemories.map((memory) => <div className="org-library__row org-memory-row" key={memory.id}>
              <div className="org-library__icon">{memory.kind === "pitfall" ? <AlertTriangle size={18} /> : memory.kind === "howto" ? <BookOpenCheck size={18} /> : <BrainCircuit size={18} />}</div>
              <div className="org-library__main"><strong>{memory.content}</strong><span>{memory.scopeName} · {memoryKindLabel[memory.kind]} · 置信度 {Math.round(memory.confidence * 100)}% · {memory.trust === "verified" ? "已验证" : "已审核"}{memory.workspaceRef ? ` · ${memory.workspaceRef}` : ""}</span>{memory.rationale && <p>{memory.rationale}</p>}{memory.outcome && <em className="org-memory-row__outcome">结果：{memory.outcome}</em>}</div>
              <div className="org-library__actions">{memory.stale ? <span className="org-state org-state--failed">已过期，仅供参考</span> : <span className="org-state org-state--ready">可召回</span>}</div>
            </div>)}
          </div>
          <MemoryPromotionList promotions={memoryPromotions} />
        </section>
      )}

      {tab === "documents" && (
        <section className="org-library">
          <div className="org-library__toolbar">
            <div><h2>共享文档</h2><p>个人范围自动发布；团队/组织范围由成员提交、知识管理员审核后才进入检索。</p></div>
            <div className="org-library__actions">
              <label className="org-library__scope-field"><span>上传到</span><select aria-label="文档上传范围" value={writeScope} onChange={(event) => setWriteScope(event.target.value)}><option value="">选择上传范围</option>{scopes.map((scope) => <option key={scope.id} value={scope.id}>{scopeLabel(scope.kind)} · {scope.name}</option>)}</select></label>
              {documents.some((document) => document.scopeKind === "personal") && scopes.some((scope) => scope.kind !== "personal") && <label className="org-library__scope-field"><span>副本发布到</span><select aria-label="文档副本发布目标" value={publishScope} onChange={(event) => setPublishScope(event.target.value)}><option value="">选择副本发布目标</option>{scopes.filter((scope) => scope.kind !== "personal").map((scope) => <option key={scope.id} value={scope.id}>{scopeLabel(scope.kind)} · {scope.name}</option>)}</select></label>}
              <button className="org-memory__primary" onClick={() => void pickAndUploadDocument()} disabled={busy || !uploadScope || !allowDocumentUpload}><Upload size={15} />上传文档</button>
            </div>
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
            <div className="org-library__actions">
              <label className="org-library__scope-field"><span>提交到</span><select aria-label="Skill 提交范围" value={writeScope} onChange={(event) => setWriteScope(event.target.value)}><option value="">选择提交范围</option>{scopes.map((scope) => <option key={scope.id} value={scope.id}>{scopeLabel(scope.kind)} · {scope.name}</option>)}</select></label>
              {skills.some((skill) => skill.scopeKind === "personal") && scopes.some((scope) => scope.kind !== "personal") && <label className="org-library__scope-field"><span>副本发布到</span><select aria-label="Skill 副本发布目标" value={publishScope} onChange={(event) => setPublishScope(event.target.value)}><option value="">选择副本发布目标</option>{scopes.filter((scope) => scope.kind !== "personal").map((scope) => <option key={scope.id} value={scope.id}>{scopeLabel(scope.kind)} · {scope.name}</option>)}</select></label>}
              <button onClick={() => void syncSkills()} disabled={busy}><RefreshCw size={15} />安全同步</button><button className="org-memory__primary" onClick={() => void pickAndUploadSkill()} disabled={busy || !uploadScope || !allowSkillSubmission}><Upload size={15} />提交 Skill</button>
            </div>
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
        </main>
      </div>
    </div>
  );
}

function SubmissionList({ title, submissions }: { title: string; submissions: Submission[] }) {
  if (submissions.length === 0) return null;
  return <div className="org-submissions"><h3>{title}</h3>{submissions.slice(0, 8).map((submission) => <div key={submission.id ?? submission.submissionId}><span>{submission.title ?? submission.name} {submission.version ? `v${submission.version}` : ""}</span><small>{submission.scopeName}</small>{submission.scanStatus && <span className={`org-state org-state--${submission.scanStatus}`}>扫描：{stateLabel(submission.scanStatus)}</span>}<span className={`org-state org-state--${submission.state}`}>{stateLabel(submission.state)}</span>{submission.reviewNote && <em>{submission.reviewNote}</em>}{submission.scanReport?.findings.filter((item) => item.severity !== "info").map((item) => <em key={`${item.code}-${item.path ?? ""}`}>{item.code}：{item.message}{item.path ? ` (${item.path})` : ""}</em>)}</div>)}</div>;
}

function MemoryPromotionList({ promotions }: { promotions: MemoryPromotion[] }) {
  if (promotions.length === 0) return null;
  return <div className="org-submissions"><h3>我的经验提交</h3>{promotions.slice(0, 8).map((item) => <div key={item.id}><span>{item.payload.content ?? "经验候选"}</span><small>{item.scopeName} · {item.payload.kind ? memoryKindLabel[item.payload.kind] : "经验"}</small><span className={`org-state org-state--${item.state}`}>{stateLabel(item.state)}</span>{item.reviewNote && <em>{item.reviewNote}</em>}</div>)}</div>;
}
