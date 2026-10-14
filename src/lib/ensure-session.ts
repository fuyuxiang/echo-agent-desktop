/**
 * ensureSession — return the live sessionId, creating a session lazily when
 * none exists yet.
 *
 * Several EchoAgent extension methods (`echo.agent/mcp/upsert`, `echo.agent/mcp/auth_trigger`,
 * …) are session-scoped, but sessions are normally only created when the
 * user sends their first prompt. Connector authorization needs one earlier,
 * so we create it on demand — same pattern as App.tsx `handleSendNew`.
 */
import {
  agentAuthStatus,
  agentNewSession,
  providersList,
} from "./agent-client";
import { useSessionStore } from "@/stores/session-store";
import { useSessionsStore } from "@/stores/sessions-store";

let sessionCreation: Promise<string> | null = null;

export async function ensureSession(): Promise<string> {
  const existing = useSessionStore.getState().sessionId;
  if (existing) return existing;
  if (sessionCreation) return sessionCreation;

  sessionCreation = createSession().finally(() => { sessionCreation = null; });
  return sessionCreation;
}

async function createSession(): Promise<string> {

  const cwd = useSessionsStore.getState().homeCwd;
  if (!cwd) throw new Error("会话尚未就绪（缺少工作目录），请先发起一个任务");

  const [auth, catalog] = await Promise.all([agentAuthStatus(), providersList()]);
  const models = catalog.models.filter((model) => auth.runtimeModels.includes(model.modelId));
  const modelId = models.find((model) => model.modelId === auth.defaultModelId)?.modelId
    ?? models[0]?.modelId;
  if (!auth.ready || !modelId) {
    throw new Error("请先在「设置 → 模型」配置可用模型和 API Key");
  }

  const active = useSessionStore.getState().sessionId;
  if (active) return active;
  if (useSessionsStore.getState().homeCwd !== cwd) {
    throw new Error("工作目录已改变，请重新授权连接器");
  }

  const sessionId = await agentNewSession(cwd, modelId);
  useSessionsStore.getState().upsert({
    sessionId,
    title: "新任务",
    cwd,
    status: "completed",
    currentModelId: modelId,
    permissionMode: "ask",
  });
  // A task may have been opened while native session creation was pending.
  // Keep the created session in history without stealing the user's task.
  const current = useSessionStore.getState().sessionId;
  if (current) return current;
  useSessionsStore.getState().setCurrent(sessionId);
  useSessionStore.getState().setSession(sessionId);
  return sessionId;
}
