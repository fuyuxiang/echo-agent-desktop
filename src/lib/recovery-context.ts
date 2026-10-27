import { readDurable, writeDurable } from "./durable-ui-state";

export const RECOVERY_SESSION_KEY = "echoagent.recovery-session.v1";

/** Identity only: the native catalog remains authoritative for cwd and model. */
export function readRecoverySessionId(): string | null {
  return readDurable(RECOVERY_SESSION_KEY, null, (value): value is string | null =>
    value === null || typeof value === "string" && value.length > 0 && value.length <= 256);
}

export function saveRecoverySessionId(sessionId: string | null): void {
  writeDurable(RECOVERY_SESSION_KEY, sessionId);
}
