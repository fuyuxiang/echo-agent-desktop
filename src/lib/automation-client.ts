import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type AutomationMode = "default" | "browser_use" | "computer_use";

export interface BrowserCapability {
  available: boolean;
  browserName?: string | null;
  executable?: string | null;
  reason?: string | null;
}

export interface ComputerCapability {
  available: boolean;
  platform: string;
  screenCapture: boolean;
  inputControl: boolean;
  reason?: string | null;
}

export interface AutomationStatus {
  sessionId: string;
  mode: AutomationMode;
  paused: boolean;
  allowPrivateNetwork: boolean;
  browser: BrowserCapability;
  computer: ComputerCapability;
  browserRunning: boolean;
  browserUrl?: string | null;
  browserTitle?: string | null;
}

export interface AutomationApproval {
  requestId: string;
  sessionId: string;
  tool: string;
  title: string;
  description: string;
  details: unknown;
}

export interface AutomationApprovalClosedEvent {
  requestId: string;
  sessionId: string;
}

export const automationStatus = (sessionId: string) =>
  invoke<AutomationStatus>("automation_status", { sessionId });

export const automationPause = (sessionId: string) =>
  invoke<AutomationStatus>("automation_pause", { sessionId });

export const automationResume = (sessionId: string) =>
  invoke<AutomationStatus>("automation_resume", { sessionId });

export const automationStop = (sessionId: string) =>
  invoke<AutomationStatus>("automation_stop", { sessionId });

export const automationSetPrivateNetwork = (sessionId: string, allowed: boolean) =>
  invoke<AutomationStatus>("automation_set_private_network", { sessionId, allowed });

export const automationRequestComputerPermissions = () =>
  invoke<ComputerCapability>("automation_request_computer_permissions");

export const automationPendingApprovals = (sessionId?: string) =>
  invoke<AutomationApproval[]>("automation_pending_approvals", {
    sessionId: sessionId ?? null,
  });

export const automationResolveApproval = (requestId: string, approved: boolean) =>
  invoke<boolean>("automation_resolve_approval", { requestId, approved });

export const onAutomationStatus = (
  callback: (status: AutomationStatus) => void,
): Promise<UnlistenFn> => listen<AutomationStatus>("automation://status", (event) => callback(event.payload));

export const onAutomationApproval = (
  callback: (approval: AutomationApproval) => void,
): Promise<UnlistenFn> => listen<AutomationApproval>("automation://approval", (event) => callback(event.payload));

export const onAutomationApprovalClosed = (
  callback: (event: AutomationApprovalClosedEvent) => void,
): Promise<UnlistenFn> => listen<AutomationApprovalClosedEvent>(
  "automation://approval-closed",
  (event) => callback(event.payload),
);
