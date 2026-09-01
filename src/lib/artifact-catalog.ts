import { collectSessionArtifacts, type SessionArtifact } from "@/lib/session-artifacts";
import type { ChatMessage, SessionTranscript } from "@/stores/session-store";

export interface TaskArtifact extends SessionArtifact {
  sessionId: string;
  sessionTitle: string;
  cwd: string;
  updatedAt: number;
}

const STORAGE_KEY = "echoagent.task-artifacts.v1";
export const ARTIFACT_CATALOG_EVENT = "echoagent:artifact-catalog-changed";

/** Keep output-producing tools and reject obvious read/search-only paths. */
export function isTaskArtifact(artifact: SessionArtifact): boolean {
  if (artifact.status !== "completed") return false;
  const label = `${artifact.kind} ${artifact.title}`.toLowerCase();
  if (/\b(write|edit|create|apply[_ -]?patch|save|export|generate|delete|move|rename|copy)\b/.test(label)) {
    return true;
  }
  if (/\b(read|open|view|list|search|find|grep|glob|stat)\b/.test(label)) {
    return false;
  }
  // Diff-bearing calls are normalized to edit-like kinds by the runtime; for
  // unknown tools, retain the path because it may be a connector-generated file.
  return true;
}

export function taskArtifactsFromMessages(
  sessionId: string,
  sessionTitle: string,
  cwd: string,
  messages: ChatMessage[],
  updatedAt = Date.now(),
): TaskArtifact[] {
  return collectSessionArtifacts(messages)
    .filter(isTaskArtifact)
    .map((artifact) => ({ ...artifact, sessionId, sessionTitle, cwd, updatedAt }));
}

export function loadTaskArtifacts(): TaskArtifact[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is TaskArtifact =>
        !!item && typeof item === "object" && typeof item.path === "string" && typeof item.sessionId === "string")
      : [];
  } catch {
    return [];
  }
}

/** Replace one session's catalog slice so rewinds and retries cannot leave stale duplicates. */
export function indexTaskArtifacts(
  sessionId: string,
  sessionTitle: string,
  cwd: string,
  messages: ChatMessage[],
): TaskArtifact[] {
  const retained = loadTaskArtifacts().filter((item) => item.sessionId !== sessionId);
  const next = mergeTaskArtifacts(
    taskArtifactsFromMessages(sessionId, sessionTitle, cwd, messages),
    retained,
  );
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      window.dispatchEvent(new CustomEvent(ARTIFACT_CATALOG_EVENT));
    } catch {
      // Private mode/storage quota: live transcript results remain available.
    }
  }
  return next;
}

export function artifactsFromTranscripts(
  transcripts: Record<string, SessionTranscript>,
  sessionMeta: Record<string, { title: string; cwd: string; updatedAt?: number }>,
): TaskArtifact[] {
  return Object.entries(transcripts).flatMap(([sessionId, transcript]) => {
    const meta = sessionMeta[sessionId];
    return taskArtifactsFromMessages(
      sessionId,
      meta?.title ?? "未命名任务",
      meta?.cwd ?? "",
      transcript.messages,
      meta?.updatedAt ?? 0,
    );
  });
}

export function mergeTaskArtifacts(...groups: TaskArtifact[][]): TaskArtifact[] {
  const byKey = new Map<string, TaskArtifact>();
  for (const group of groups) {
    for (const item of group) {
      const key = `${item.sessionId}:${item.path.replace(/\\/g, "/").toLowerCase()}`;
      const previous = byKey.get(key);
      if (!previous || item.updatedAt >= previous.updatedAt) byKey.set(key, item);
    }
  }
  return [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
