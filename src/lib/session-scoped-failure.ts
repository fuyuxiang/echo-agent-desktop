/**
 * Applies an asynchronous session failure to the session that initiated the
 * work. The global error banner belongs only to the currently focused session.
 */
export function applySessionScopedFailure({
  failedSessionId,
  currentSessionId,
  message,
  setStatus,
  setCurrentError,
}: {
  failedSessionId: string;
  currentSessionId?: string | null;
  message: string;
  setStatus: (sessionId: string, status: "failed") => void;
  setCurrentError: (message: string) => void;
}): void {
  setStatus(failedSessionId, "failed");
  if (currentSessionId === failedSessionId) setCurrentError(message);
}
