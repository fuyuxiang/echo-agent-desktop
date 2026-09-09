import type { SessionStatus } from "@/lib/types";

export type SessionControlAction = "pause" | "stop";
export type SessionControlPhase = "pausing" | "paused" | "stopping" | "stopped";

export interface SessionControl {
  action: SessionControlAction;
  phase: SessionControlPhase;
  promptId?: string;
  requestedAt: number;
}

const STORAGE_KEY = "echoagent.session-controls.v1";

function stableControl(value: unknown): SessionControl | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<SessionControl>;
  if (raw.action !== "pause" && raw.action !== "stop") return undefined;
  const expectedPhase = raw.action === "pause" ? "paused" : "stopped";
  if (raw.phase !== expectedPhase) return undefined;
  return {
    action: raw.action,
    phase: expectedPhase,
    ...(typeof raw.promptId === "string" ? { promptId: raw.promptId } : {}),
    requestedAt: typeof raw.requestedAt === "number" ? raw.requestedAt : 0,
  };
}

/** Stable controls survive renderer reloads; transient "pausing" never does. */
export function readPersistedSessionControls(): Record<string, SessionControl> {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    const controls: Record<string, SessionControl> = {};
    for (const [sessionId, value] of Object.entries(parsed)) {
      const control = stableControl(value);
      if (control) controls[sessionId] = control;
    }
    return controls;
  } catch {
    return {};
  }
}

export function readPersistedSessionControl(sessionId: string): SessionControl | undefined {
  return readPersistedSessionControls()[sessionId];
}

export function persistSessionControl(sessionId: string, control?: SessionControl): void {
  if (typeof localStorage === "undefined") return;
  try {
    const controls = readPersistedSessionControls();
    if (control && (control.phase === "paused" || control.phase === "stopped")) {
      controls[sessionId] = control;
    } else {
      delete controls[sessionId];
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(controls));
  } catch {
    // Storage is an enhancement. The in-memory session state remains authoritative.
  }
}

export function sessionControlStatus(control: SessionControl): SessionStatus {
  return control.phase;
}

/** Exact, attachment-free commands are local task controls and never reach the model. */
export function parseSessionControlIntent(text: string): SessionControlAction | null {
  const normalized = text.trim().toLowerCase();
  if (["暂停", "暂停任务", "/pause"].includes(normalized)) return "pause";
  if (["停止", "中止", "停止任务", "中止任务", "/stop"].includes(normalized)) return "stop";
  return null;
}

export function isControlledSessionStatus(status: SessionStatus | undefined): boolean {
  return status === "pausing"
    || status === "paused"
    || status === "stopping"
    || status === "stopped";
}
