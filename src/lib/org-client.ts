import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type OrgScopeKind = "personal" | "team" | "org";

export interface OrgScope {
  id: string;
  kind: OrgScopeKind;
  name: string;
  groupId?: string | null;
  ownerUserId?: string | null;
}

export interface OrgUser {
  id: string;
  username: string;
  displayName: string;
  role: "member" | "curator" | "admin";
  clearance: number;
}

export interface OrgBootstrap {
  apiVersion: number;
  user: OrgUser;
  scopes: OrgScope[];
  policy: Record<string, unknown>;
  serverTime: number;
}

export interface OrgSession {
  loggedIn: boolean;
  serverUrl?: string;
  user?: OrgUser;
  bootstrap?: OrgBootstrap;
}

export interface OrgDocument {
  id: string;
  title: string;
  sourceType: string;
  status: "pending" | "parsing" | "chunking" | "embedding" | "ready" | "failed" | "archived";
  failReason?: string | null;
  byteSize: number;
  scopeId: string;
  scopeKind: OrgScopeKind;
  scopeName: string;
  ownerName?: string | null;
  chunkCount: number;
  tags: string[];
  updatedAt: number;
}

export interface DocumentPage {
  items: OrgDocument[];
  total: number;
  page: number;
  size: number;
}

export interface Submission {
  id?: string;
  submissionId?: string;
  title?: string;
  name?: string;
  version?: string;
  state: "pending" | "approved" | "rejected" | "withdrawn";
  scopeId: string;
  scopeName: string;
  scopeKind: OrgScopeKind;
  reviewNote?: string | null;
  scanStatus?: "queued" | "scanning" | "passed" | "failed";
  scanReport?: {
    status: "passed" | "failed";
    findings: Array<{ code: string; severity: string; message: string; path?: string }>;
  } | null;
  resultDocumentId?: string | null;
  createdAt: number;
}

export interface OrgSkill {
  skillId: string;
  versionId: string;
  name: string;
  description: string;
  version: string;
  scopeId: string;
  scopeKind: OrgScopeKind;
  scopeName: string;
  mandatory: boolean;
  allowPersonalOverride: boolean;
  enabled: boolean;
  updatedAt: number;
}

export interface SkillSyncResult {
  cursor: string;
  leaseUntil: number;
  installed: Array<{
    skillId: string;
    versionId: string;
    name: string;
    path: string;
    mandatory: boolean;
    allowPersonalOverride: boolean;
  }>;
}

export interface AskCitation {
  id: string;
  docId: string;
  chunkId: string;
  title: string;
  scopeKind: OrgScopeKind;
  page?: number | null;
  heading?: string | null;
  quote: string;
  openUrl: string;
  stale: boolean;
}

export interface AskFinal {
  answer: string;
  citations: AskCitation[];
  confidence: number;
  insufficient: boolean;
  traceId: string;
  qaEventId?: string;
  mode: "fast" | "deep";
  verification: string;
}

export interface OrgAskEvent {
  requestId: string;
  event: "meta" | "status" | "citation" | "delta" | "verification" | "final" | "error";
  data: unknown;
}

export const orgSession = () => invoke<OrgSession>("org_session");
export const orgLogin = (serverUrl: string, username: string, password: string) =>
  invoke<OrgSession>("org_login", { serverUrl, username, password });
export const orgLogout = () => invoke<void>("org_logout");
export const orgListScopes = () => invoke<OrgScope[]>("org_list_scopes");
export const orgListDocuments = (scopeId?: string, query?: string) =>
  invoke<DocumentPage>("org_list_documents", { scopeId: scopeId ?? null, query: query ?? null });
export const orgSubmitDocument = (filePath: string, scopeId: string, title?: string, tags?: string[]) =>
  invoke<{ submissionId?: string | null; docId?: string | null; state: string; documentStatus?: string }>(
    "org_submit_document",
    { filePath, scopeId, title: title ?? null, tags: tags ?? null },
  );
export const orgDocumentSubmissionsMine = () =>
  invoke<Submission[]>("org_document_submissions_mine");
export const orgFetchDocument = (docId: string, page?: number | null) =>
  invoke<{ docId: string; text: string; chunks: Array<{ seq: number; text: string; heading?: string; locPage?: number }> }>(
    "org_fetch_document",
    { docId, page: page ?? null },
  );
export const orgArchiveDocument = (docId: string) =>
  invoke<{ archived: boolean }>("org_archive_document", { docId });
export const orgNewDocumentVersion = (docId: string, filePath: string) =>
  invoke<{ docId: string; version: number; status: string }>("org_new_document_version", { docId, filePath });
export const orgPublishDocument = (docId: string, targetScopeId: string) =>
  invoke<{ submissionId?: string | null; docId?: string | null; state: string }>("org_publish_document", { docId, targetScopeId });
export const orgListSkills = () => invoke<OrgSkill[]>("org_list_skills");
export const orgSkillDetail = (skillId: string) => invoke<Record<string, unknown>>("org_skill_detail", { skillId });
export const orgSetSkillPreference = (skillId: string, enabled: boolean) =>
  invoke<{ skillId: string; enabled: boolean }>("org_set_skill_preference", { skillId, enabled });
export const orgPublishSkill = (skillId: string, targetScopeId: string) =>
  invoke<{ submissionId: string; skillId: string; version: string; state: string }>("org_publish_skill", { skillId, targetScopeId });
export const orgSubmitSkill = (filePath: string, scopeId: string, version?: string) =>
  invoke<{ submissionId: string; skillId: string; version: string; state: string }>(
    "org_submit_skill",
    { filePath, scopeId, version: version ?? null },
  );
export const orgSkillSubmissionsMine = () => invoke<Submission[]>("org_skill_submissions_mine");
export const orgSyncSkills = () => invoke<SkillSyncResult>("org_sync_skills");
export const orgAskStart = (question: string, mode: string, scopeIds?: string[]) =>
  invoke<string>("org_ask_start", {
    question,
    mode,
    scopeKinds: null,
    scopeIds: scopeIds ?? null,
  });
export const orgAskCancel = (requestId: string) =>
  invoke<boolean>("org_ask_cancel", { requestId });
export const orgQaFeedback = (qaEventId: string, feedback: "helpful" | "not_helpful" | "wrong") =>
  invoke<unknown>("org_qa_feedback", { qaEventId, feedback });
export const listenOrgAsk = (handler: (event: OrgAskEvent) => void): Promise<UnlistenFn> =>
  listen<OrgAskEvent>("org://ask-event", ({ payload }) => handler(payload));

/** Fired after native organization Skill activation/deactivation is persisted. */
export const listenOrgSkillsChanged = (handler: () => void): Promise<UnlistenFn> =>
  listen("org://skills-changed", handler);
