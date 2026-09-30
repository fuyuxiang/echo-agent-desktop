import { invoke } from "@tauri-apps/api/core";

export interface WeixinStatus {
  connected: boolean;
  botId?: string;
  activeSession?: string;
  activeSessionTitle?: string;
  allowedWorkspaces: string[];
  defaultWorkspace?: string;
  sharedSessions: Array<{ sessionId: string; title: string; cwd: string }>;
  pendingReplies: number;
  online: boolean;
  lastError?: string;
}

export interface WeixinQrPoll {
  status: string;
  connected: boolean;
}

export const weixinStatus = () => invoke<WeixinStatus>("weixin_status");
export const weixinQrStart = () => invoke<{ qrUrl: string }>("weixin_qr_start");
export const weixinQrPoll = (verifyCode?: string) => invoke<WeixinQrPoll>("weixin_qr_poll", { verifyCode });
export const weixinSetWorkspaces = (workspaces: string[], defaultWorkspace?: string) => invoke<WeixinStatus>("weixin_set_workspaces", { workspaces, defaultWorkspace });
export const weixinRevokeSession = (sessionId: string) => invoke<WeixinStatus>("weixin_revoke_session", { sessionId });
export const weixinHandoff = (sessionId: string) => invoke<string>("weixin_handoff", { sessionId });
export const weixinDisconnect = () => invoke<void>("weixin_disconnect");
