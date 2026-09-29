import { invoke } from "@tauri-apps/api/core";

export interface WeixinStatus {
  connected: boolean;
  botId?: string;
  activeSession?: string;
  activeSessionTitle?: string;
  allowedWorkspaces: string[];
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
export const weixinSetWorkspaces = (workspaces: string[]) => invoke<WeixinStatus>("weixin_set_workspaces", { workspaces });
export const weixinHandoff = (sessionId: string) => invoke<string>("weixin_handoff", { sessionId });
export const weixinDisconnect = () => invoke<void>("weixin_disconnect");
