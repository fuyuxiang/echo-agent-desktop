// Message ids are stable while the renderer is running, including task switches.
// Keep only explicit user choices here; automatic defaults remain in the view.
const choices = new Map<string, boolean>();
const MAX_CHOICES = 1_000;

function keyFor(sessionId?: string, messageId?: string): string | null {
  return sessionId && messageId ? JSON.stringify([sessionId, messageId]) : null;
}

export function getExecutionDisclosureChoice(
  sessionId?: string,
  messageId?: string,
): boolean | undefined {
  const key = keyFor(sessionId, messageId);
  return key ? choices.get(key) : undefined;
}

export function rememberExecutionDisclosureChoice(
  sessionId: string | undefined,
  messageId: string | undefined,
  open: boolean,
): void {
  const key = keyFor(sessionId, messageId);
  if (!key) return;
  choices.delete(key);
  choices.set(key, open);
  if (choices.size > MAX_CHOICES) {
    const oldest = choices.keys().next().value;
    if (oldest !== undefined) choices.delete(oldest);
  }
}

export function forgetExecutionDisclosureChoice(
  sessionId?: string,
  messageId?: string,
): void {
  const key = keyFor(sessionId, messageId);
  if (key) choices.delete(key);
}
