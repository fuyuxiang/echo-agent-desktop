import { create } from "zustand";
import { projectsLoad, projectsSave } from "@/lib/agent-client";

/**
 * 本地「项目」实体存储。Rust 后端私有数据目录是权威副本，
 * localStorage 只作冷启动缓存与旧版数据迁移来源。每次变更都会原子写回后端。
 */

export interface RefItem {
  id: string;
  name: string;
  iconUrl?: string;
}

/** 项目下的真实对话（EchoAgent 会话）。 */
export interface ProjectConversation {
  sessionId: string;
  title: string;
  createdAt: string;
}

export type PlanStatus = "pending" | "in_progress" | "paused" | "completed";

export interface PlanCard {
  id: string;
  title: string;
  status: PlanStatus;
  source?: string;
  /** Agent conversation created to execute this plan item. */
  sessionId?: string;
}

export interface TaskItem {
  id: string;
  title: string;
  scope: "personal" | "shared";
  source: string;
  status: PlanStatus;
  /** Agent conversation created to execute this task. */
  sessionId?: string;
}

export interface AssetItem {
  id: string;
  name: string;
  kind: "folder" | "file";
  ext?: string;
  sizeLabel?: string;
  updater?: string;
  updatedAt?: string;
  /** Canonical file copied into the project's private backend asset dir. */
  path?: string;
  sizeBytes?: number;
}

export interface ProjectMeta {
  id: string;
  name: string;
  cwd?: string;
  templateId?: string;
  instructions?: string;
  createdAt: string;
  // 详情
  connectors: RefItem[];
  experts: RefItem[];
  skills: RefItem[];
  plans: PlanCard[];
  tasks: TaskItem[];
  assets: AssetItem[];
  members: string[];
  /** 项目下的真实对话（EchoAgent 会话列表），按创建时间倒序。 */
  conversations: ProjectConversation[];
}

/** 计划看板列定义（对齐目标截图：待开始/进行中/暂停/完成）。 */
export const PLAN_COLUMNS: { status: PlanStatus; label: string }[] = [
  { status: "pending", label: "待开始" },
  { status: "in_progress", label: "进行中" },
  { status: "paused", label: "暂停" },
  { status: "completed", label: "完成" },
];

const STORAGE_KEY = "echoagent.projects";
const DIRTY_KEY = "echoagent.projects.pending-backend-sync";
let persistChain: Promise<void> = Promise.resolve();
let persistRevision = 0;

/** 旧数据/外部数据补齐缺省详情字段，保证组件可直接读数组。 */
function normalize(x: unknown): ProjectMeta | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Partial<ProjectMeta> & { id?: unknown; name?: unknown };
  if (typeof o.id !== "string" || typeof o.name !== "string") return null;
  return {
    id: o.id,
    name: o.name,
    cwd: o.cwd,
    templateId: o.templateId,
    instructions: o.instructions,
    createdAt: o.createdAt ?? new Date().toISOString(),
    connectors: Array.isArray(o.connectors) ? o.connectors : [],
    experts: Array.isArray(o.experts) ? o.experts : [],
    skills: Array.isArray(o.skills) ? o.skills : [],
    plans: Array.isArray(o.plans)
      ? o.plans.map((item) => ({ ...item, status: item.status ?? "pending" }))
      : [],
    tasks: Array.isArray(o.tasks)
      ? o.tasks.map((item) => ({ ...item, status: item.status ?? "pending" }))
      : [],
    assets: Array.isArray(o.assets) ? o.assets : [],
    members: Array.isArray(o.members) ? o.members : [],
    conversations: Array.isArray(o.conversations) ? o.conversations : [],
  };
}

function load(): ProjectMeta[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(normalize).filter(Boolean) as ProjectMeta[] : [];
  } catch {
    return [];
  }
}

function saveLocal(list: ProjectMeta[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* quota / 隐私模式 — 静默降级为仅内存 */
  }
}

function persist(list: ProjectMeta[]): void {
  saveLocal(list);
  try { window.localStorage.setItem(DIRTY_KEY, "1"); } catch { /* cache unavailable */ }
  const revision = ++persistRevision;
  useProjectsStore.setState({ persisting: true });
  // Serialize snapshots so a slower old write can never overwrite a newer one.
  persistChain = persistChain
    .catch(() => {})
    .then(() => projectsSave(list));
  void persistChain.then(() => {
    if (revision !== persistRevision) return;
    try { window.localStorage.removeItem(DIRTY_KEY); } catch { /* cache unavailable */ }
    useProjectsStore.setState({ persisting: false, persistError: null });
  }).catch((error) => {
    if (revision !== persistRevision) return;
    useProjectsStore.setState({
      persisting: false,
      persistError: String(error).replace(/^Error:\s*/, ""),
    });
  });
}

const uid = (p: string) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

interface ProjectsState {
  projects: ProjectMeta[];
  persisting: boolean;
  persistError: string | null;
  retryPersist: () => void;
  /** Sidebar → ProjectsPanel communication: when set, the panel auto-opens this project. */
  activeProjectId: string | null;
  setActiveProjectId: (id: string | null) => void;
  add: (p: {
    name: string;
    cwd?: string;
    templateId?: string;
    instructions?: string;
    connectors?: RefItem[];
    experts?: RefItem[];
    skills?: RefItem[];
  }) => ProjectMeta;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  updateConfig: (
    id: string,
    patch: Partial<Pick<ProjectMeta, "instructions" | "connectors" | "experts" | "skills">>,
  ) => void;
  addPlan: (id: string, title: string, status?: PlanStatus) => void;
  movePlan: (id: string, cardId: string, status: PlanStatus) => void;
  linkPlanSession: (id: string, cardId: string, sessionId: string) => void;
  removePlan: (id: string, cardId: string) => void;
  addTask: (id: string, title: string) => void;
  moveTask: (id: string, taskId: string, status: PlanStatus) => void;
  linkTaskSession: (id: string, taskId: string, sessionId: string) => void;
  removeTask: (id: string, taskId: string) => void;
  addAsset: (id: string, a: Pick<AssetItem, "name" | "kind"> & Partial<AssetItem>) => void;
  removeAsset: (id: string, assetId: string) => void;
  addMember: (id: string, name: string) => void;
  addConversation: (id: string, conv: ProjectConversation) => void;
  removeConversation: (id: string, sessionId: string) => void;
  updateConversationTitle: (id: string, sessionId: string, title: string) => void;
}

export const useProjectsStore = create<ProjectsState>((set, get) => {
  const patch = (id: string, fn: (p: ProjectMeta) => ProjectMeta) => {
    const next = get().projects.map((p) => (p.id === id ? fn(p) : p));
    set({ projects: next });
    persist(next);
  };
  return {
    projects: load(),
    persisting: false,
    persistError: null,
    retryPersist: () => persist(get().projects),
    activeProjectId: null,
    setActiveProjectId: (id) => set({ activeProjectId: id }),
    add: (p) => {
      const item: ProjectMeta = {
        id: uid("proj"),
        name: p.name,
        cwd: p.cwd || undefined,
        templateId: p.templateId || undefined,
        instructions: p.instructions || undefined,
        createdAt: new Date().toISOString(),
        connectors: p.connectors ?? [],
        experts: p.experts ?? [],
        skills: p.skills ?? [],
        plans: [],
        tasks: [],
        assets: [],
        members: [],
        conversations: [],
      };
      const next = [item, ...get().projects];
      set({ projects: next });
      persist(next);
      return item;
    },
    rename: (id, name) => patch(id, (p) => ({ ...p, name })),
    remove: (id) => {
      const next = get().projects.filter((p) => p.id !== id);
      set({ projects: next });
      persist(next);
    },
    updateConfig: (id, cfg) => patch(id, (p) => ({ ...p, ...cfg })),
    addPlan: (id, title, status = "pending") =>
      patch(id, (p) => ({ ...p, plans: [...p.plans, { id: uid("plan"), title, status }] })),
    movePlan: (id, cardId, status) =>
      patch(id, (p) => ({
        ...p,
        plans: p.plans.map((c) => (c.id === cardId ? { ...c, status } : c)),
      })),
    linkPlanSession: (id, cardId, sessionId) =>
      patch(id, (p) => ({
        ...p,
        plans: p.plans.map((card) => card.id === cardId ? { ...card, sessionId } : card),
      })),
    removePlan: (id, cardId) =>
      patch(id, (p) => ({ ...p, plans: p.plans.filter((c) => c.id !== cardId) })),
    addTask: (id, title) =>
      patch(id, (p) => ({
        ...p,
        tasks: [
          ...p.tasks,
          { id: uid("task"), title, scope: "personal", source: "manual", status: "pending" },
        ],
      })),
    moveTask: (id, taskId, status) =>
      patch(id, (p) => ({
        ...p,
        tasks: p.tasks.map((task) => task.id === taskId ? { ...task, status } : task),
      })),
    linkTaskSession: (id, taskId, sessionId) =>
      patch(id, (p) => ({
        ...p,
        tasks: p.tasks.map((task) => task.id === taskId ? { ...task, sessionId } : task),
      })),
    removeTask: (id, taskId) =>
      patch(id, (p) => ({ ...p, tasks: p.tasks.filter((t) => t.id !== taskId) })),
    addAsset: (id, a) =>
      patch(id, (p) => ({
        ...p,
        assets: [
          ...p.assets,
          {
            id: uid("asset"),
            name: a.name,
            kind: a.kind,
            ext: a.ext,
            sizeLabel: a.sizeLabel,
            updater: a.updater ?? "-",
            updatedAt: a.updatedAt ?? new Date().toISOString(),
            path: a.path,
            sizeBytes: a.sizeBytes,
          },
        ],
      })),
    removeAsset: (id, assetId) =>
      patch(id, (p) => ({ ...p, assets: p.assets.filter((a) => a.id !== assetId) })),
    addMember: (id, name) =>
      patch(id, (p) =>
        p.members.includes(name) ? p : { ...p, members: [...p.members, name] },
      ),
    addConversation: (id, conv) =>
      patch(id, (p) => ({
        ...p,
        conversations: [conv, ...p.conversations],
      })),
    removeConversation: (id, sessionId) =>
      patch(id, (p) => ({
        ...p,
        conversations: p.conversations.filter((c) => c.sessionId !== sessionId),
      })),
    updateConversationTitle: (id, sessionId, title) =>
      patch(id, (p) => ({
        ...p,
        conversations: p.conversations.map((c) =>
          c.sessionId === sessionId ? { ...c, title } : c,
        ),
      })),
  };
});

/**
 * Reconcile renderer cache with the canonical Rust store once Tauri is ready.
 * A missing backend file triggers a one-time migration from localStorage.
 */
export async function hydrateProjectsFromBackend(): Promise<void> {
  const cached = useProjectsStore.getState().projects;
  let hasPendingSync = false;
  try { hasPendingSync = window.localStorage.getItem(DIRTY_KEY) === "1"; } catch { /* cache unavailable */ }
  if (hasPendingSync) {
    await projectsSave(cached);
    try { window.localStorage.removeItem(DIRTY_KEY); } catch { /* cache unavailable */ }
    useProjectsStore.setState({ persisting: false, persistError: null });
    return;
  }
  const backend = await projectsLoad<ProjectMeta>();
  if (backend.length === 0 && cached.length > 0) {
    await projectsSave(cached);
    return;
  }
  const normalized = backend.map(normalize).filter(Boolean) as ProjectMeta[];
  useProjectsStore.setState({ projects: normalized });
  saveLocal(normalized);
}
