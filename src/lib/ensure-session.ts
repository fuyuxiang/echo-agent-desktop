/**
 * ensureSession — return the live sessionId, creating a session lazily when
 * none exists yet.
 *
 * Several EchoAgent extension methods (`x.ai/mcp/upsert`, `x.ai/mcp/auth_trigger`,
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

export async function ensureSession(): Promise<string> {
  const existing = useSessionStore.getState().sessionId;
  if (existing) return existing;

  const cwd = useSessionsStore.getState().homeCwd;
  if (!cwd) throw new Error("会话尚未就绪（缺少工作目录），请先发起一个任务");

  const [auth, catalog] = await Promise.all([agentAuthStatus(), providersList()]);
  const modelId = catalog.models[0]?.modelId;
  if (!auth.ready || !modelId) {
    throw new Error("请先在「设置 → 模型」配置可用模型和 API Key");
  }

  const sessionId = await agentNewSession(cwd, modelId);
  useSessionsStore.getState().setCurrent(sessionId);
  useSessionsStore.getState().upsert({
    sessionId,
    title: "新任务",
    cwd,
    status: "completed",
    currentModelId: modelId,
  });
  useSessionStore.getState().setSession(sessionId);
  return sessionId;
}
