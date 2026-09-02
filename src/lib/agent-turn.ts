import { agentSend } from "@/lib/agent-client";
import { friendlyError } from "@/lib/error-format";
import { useSessionsStore } from "@/stores/sessions-store";
import { useSessionStore } from "@/stores/session-store";

export type AgentTurnSender = (
  sessionId: string,
  promptText: string,
  attachments: string[],
  displayText: string,
) => Promise<void>;

export interface AgentTurnInput {
  sessionId: string;
  promptText: string;
  displayText: string;
  attachments?: string[];
}

/**
 * Admit a user turn locally and observe the long-running ACP request without
 * returning its completion promise to the composer.
 *
 * ACP's PromptRequest resolves after the whole model turn, not when the prompt
 * is merely accepted. Keeping that promise out of the submit path lets the UI
 * clear immediately while the transcript continues streaming normally.
 */
export function beginAgentTurn(
  input: AgentTurnInput,
  send: AgentTurnSender = agentSend,
): boolean {
  const { sessionId, promptText, displayText } = input;
  const attachments = input.attachments ?? [];
  const transcript = useSessionStore.getState();
  if (transcript.sessionId !== sessionId) {
    return false;
  }

  useSessionsStore.getState().upsert({ sessionId, status: "working" });
  transcript.pushUser(displayText, attachments);
  transcript.startStreaming();

  void send(sessionId, promptText, attachments, displayText).catch((error) => {
    const latest = useSessionStore.getState();
    latest.markComplete({
      sessionId,
      promptId: "",
      stopReason: "error",
    });
    // Error banners belong to the focused conversation. A late failure from a
    // background turn must not stop or overwrite whichever session is active.
    if (latest.sessionId === sessionId) {
      latest.setError(friendlyError(error));
    }
    useSessionsStore.getState().upsert({ sessionId, status: "failed" });
  });
  return true;
}
