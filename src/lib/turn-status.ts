import type { PromptComplete, SessionStatus } from "@/lib/types";

const FAILURE_STOP_REASONS = new Set([
  "error",
  "rate_limit",
  "rate_limited",
  "refusal",
  "content_filter",
  "max_tokens",
  "max_turns",
]);

const FAILURE_CANCELLATION_CATEGORIES = new Set([
  "HookDenied",
  "max_turns_reached",
  "action_stationarity",
]);

/** Translate a terminal protocol outcome into an honest sidebar lifecycle. */
export function terminalSessionStatus(
  outcome: Pick<PromptComplete, "stopReason" | "cancelTrigger" | "cancellationCategory">,
  requestedAction?: "pause" | "stop",
): SessionStatus {
  if (FAILURE_STOP_REASONS.has(outcome.stopReason)) return "failed";
  if (outcome.stopReason === "cancelled") {
    if (outcome.cancelTrigger === "send_now") return "working";
    if (outcome.cancelTrigger === "pause" || requestedAction === "pause") return "paused";
    return FAILURE_CANCELLATION_CATEGORIES.has(outcome.cancellationCategory ?? "")
      ? "failed"
      : "stopped";
  }
  return "completed";
}

export function isWaitingForUser(status: SessionStatus | undefined): boolean {
  return status === "awaiting_permission"
    || status === "awaiting_answer"
    || status === "awaiting_approval";
}

export function isAgentOwnedActiveStatus(status: SessionStatus | undefined): boolean {
  return status === "working"
    || status === "planning"
    || isWaitingForUser(status);
}
