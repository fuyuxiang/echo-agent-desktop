/**
 * agent-client — typed wrappers over the EchoAgent Tauri commands and events.
 *
 * The Rust backend (src-tauri/src/commands.rs) exposes a command table that
 * drives the in-process EchoAgent agent over ACP. Streamed updates arrive as the
 * `agent://update`, `agent://permission`, `agent://complete` events, whose
 * payloads are the types in ./types.ts.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AgentDefaults,
  AgentEntry,
  Automation,
  ExpertCatalog,
  AutomationSnapshot,
  AutomationStatus,
  ConnectorCatalog,
  ConnectorCliAuthDoneEvent,
  ConnectorCliAuthLogEvent,
  ConnectorCliAuthResult,
  ConnectorCliAuthUrlEvent,
  ConnectorCliStatus,
  InspirationStarted,
  McpAuthStatusEntry,
  McpAuthTriggerResult,
  McpConfigFile,
  McpConfigSaveResult,
  McpMutationResult,
  McpServerEntry,
  McpUpsertRequest,
  MemoryEntry,
  PermissionRequest,
  PermissionRule,
  PromptComplete,
  RewindPoint,
  RunningTask,
  SearchHit,
  SessionInfoResponse,
  SessionSummary,
  SessionSummaryEvent,
  SessionUpdate,
  SessionUsage,
  SkillCatalog,
  SkillInfo,
  SkillInstallResult,
  SkillPackageInspection,
  SlashCommand,
  SubagentLiveEvent,
  TurnErrorEvent,
} from "./types";

import type { QuestionRequest } from "@/stores/question-store";

// ---------- commands ----------

export interface AuthStatus {
  ready: boolean;
  /** True if ~/.echo-agent/auth.json exists. */
  hasAuthFile: boolean;
  /** Human-readable reason when not ready. */
  reason?: string;
  /** Model ids configured in ~/.echo-agent/config.toml (BYOK providers). */
  providers: string[];
}

export interface InitResult {
  /** Whether the agent initialized and authenticated successfully. */
  ok: boolean;
  auth: AuthStatus;
  /** The cwd the agent bound to (echoes the input). */
  cwd: string;
  agentVersion?: string;
  /** Default model id the agent will use. */
  defaultModelId?: string;
}

/**
 * Initialize the in-process EchoAgent agent. If `cwd` is omitted the backend
 * defaults to the user's home directory.
 */
export async function agentInit(cwd?: string): Promise<InitResult> {
  return invoke<InitResult>("agent_init", { cwd: cwd ?? null });
}

export async function agentAuthStatus(): Promise<AuthStatus> {
  return invoke<AuthStatus>("agent_auth_status");
}

// NOTE: the backend `agent_new_session` command returns the session id as a
// bare `String` (see commands.rs agent_new_session). We type it as `string`
// here — do NOT wrap it in `{ sessionId }`, or callers destructuring
// `const { sessionId } = ...` will silently get undefined.
//
// `modelId` is passed as `_meta.modelId` to EchoAgent so the session binds to
// that model from the start (avoids the default `grok-build` model whose
// sampling config has no key in a BYOK-only setup).
export async function agentNewSession(cwd: string, modelId?: string): Promise<string> {
  return invoke<string>("agent_new_session", { cwd, modelId: modelId ?? null });
}

// `agent_load_session` triggers a history replay on the agent side: EchoAgent
// re-emits the persisted transcript as a stream of SessionUpdate messages,
// which our existing `agent://update` listener already funnels into the
// session store. So this command returns nothing — callers just need to
// clear the local transcript first, then await this to confirm the agent
// accepted the load.
export async function agentLoadSession(sessionId: string, cwd: string): Promise<void> {
  await invoke<void>("agent_load_session", { sessionId, cwd });
}

export async function agentListSessions(cwd: string): Promise<SessionSummary[]> {
  return invoke<SessionSummary[]>("agent_list_sessions", { cwd });
}

/** A discovered working directory (EchoAgent has run sessions in it). */
export interface WorkspaceInfo {
  /** Absolute path of the working directory. */
  cwd: string;
  /** Number of sessions recorded under this cwd. */
  sessionCount: number;
  /** Title of the most recent session under this cwd (optional, for display). */
  lastTitle?: string;
}

/**
 * List every working directory EchoAgent has ever seen (deduplicated), with a
 * session count per cwd. Used to populate the Composer's workspace picker.
 */
export async function agentListWorkspaces(): Promise<WorkspaceInfo[]> {
  return invoke<WorkspaceInfo[]>("agent_list_workspaces");
}

/**
 * Switch the model used by an existing session (EchoAgent's `session/set_model`).
 * May reject with `MODEL_SWITCH_INCOMPATIBLE_AGENT` if the session has turns
 * and the new model requires a different agent harness — surface that error
 * to the user (suggest starting a new session).
 */
export async function agentSetModel(sessionId: string, modelId: string): Promise<void> {
  await invoke<void>("agent_set_model", { sessionId, modelId });
}

/** Send a user prompt; streamed updates arrive via the events below. */
export async function agentSend(sessionId: string, text: string, attachments: string[] = []): Promise<void> {
  await invoke<void>("agent_send", { sessionId, text, attachments });
}

export async function agentCancel(sessionId: string): Promise<void> {
  await invoke<void>("agent_cancel", { sessionId });
}

/** Cleanly shut down the agent so `agentInit` can be called again to restart. */
export async function agentShutdown(): Promise<void> {
  await invoke<void>("agent_shutdown");
}

/**
 * Rename a session via EchoAgent's `x.ai/session/rename` extension method. EchoAgent
 * writes `generated_title` + `title_is_manual=true` to summary.json and
 * broadcasts `SessionSummaryGenerated`, which we also pick up via the
 * `agent://summary` event — so callers don't strictly need to optimistically
 * update the title, but doing so avoids a flicker while the event round-trips.
 *
 * `cwd` is optional but narrows EchoAgent's on-disk session lookup.
 */
export async function agentRenameSession(
  sessionId: string,
  title: string,
  cwd?: string,
): Promise<void> {
  await invoke<void>("agent_rename_session", { sessionId, title, cwd: cwd ?? null });
}

/**
 * Delete a session's persisted history via EchoAgent's `x.ai/session/delete`.
 * Removes the on-disk session directory; the caller should drop the sidebar
 * entry on success.
 */
export async function agentDeleteSession(sessionId: string, cwd?: string): Promise<void> {
  await invoke<void>("agent_delete_session", { sessionId, cwd: cwd ?? null });
}

/**
 * Pin/unpin a session. EchoAgent's Summary has no pinned field, so this is
 * EchoAgent-only state stored in `~/.echo-agent/echoagent-state.json`. Returns the
 * new pinned value.
 */
export async function agentSetSessionPinned(
  sessionId: string,
  pinned: boolean,
): Promise<boolean> {
  return invoke<boolean>("agent_set_session_pinned", { sessionId, pinned });
}

/**
 * Archive/unarchive a session. EchoAgent's Summary has no archived field, so this
 * is EchoAgent-only state stored in `~/.echo-agent/echoagent-state.json`. Archived
 * sessions are hidden from the sidebar list. Returns the new archived value.
 */
export async function agentSetSessionArchived(
  sessionId: string,
  archived: boolean,
): Promise<boolean> {
  return invoke<boolean>("agent_set_session_archived", { sessionId, archived });
}

// ---------- context usage (x.ai/session/info + x.ai/session/usage) ----------

/**
 * Fetch the session's context-window snapshot (`x.ai/session/info`) for the
 * composer's context-usage pill/popover. Rejects when the session isn't live
 * in the agent (e.g. an old session never loaded this launch) — callers
 * should treat that as "no data" and hide the pill.
 */
export async function agentSessionInfo(sessionId: string): Promise<SessionInfoResponse> {
  return invoke<SessionInfoResponse>("agent_session_info", { sessionId });
}

/**
 * Fetch the session's cumulative token usage (`x.ai/session/usage`) — the
 * response wraps `PromptUsage` totals; we return the inner `usage` object.
 * Used by the context-usage popover for the average cache hit rate.
 */
export async function agentSessionUsage(sessionId: string): Promise<SessionUsage> {
  const resp = await invoke<{ usage: SessionUsage }>("agent_session_usage", { sessionId });
  return resp.usage;
}

export async function agentResolvePermission(
  requestId: string,
  outcome: { optionId?: string; cancelled?: boolean }
): Promise<void> {
  await invoke<void>("agent_resolve_permission", {
    requestId,
    optionId: outcome.optionId ?? null,
    cancelled: outcome.cancelled ?? false,
  });
}

export async function agentResolveQuestion(
  requestId: string,
  outcome: {
    /** Keyed by question text. Values are option labels (or string arrays for multi-select). */
    answers?: Record<string, string | string[]>;
    /** Per-question notes/preview, keyed by question text. Freeform uses notes. */
    annotations?: Record<string, { preview?: string; notes?: string }>;
    cancelled?: boolean;
  }
): Promise<void> {
  await invoke<void>("agent_resolve_question", {
    requestId,
    answers: outcome.answers ?? null,
    annotations: outcome.annotations ?? null,
    cancelled: outcome.cancelled ?? false,
  });
}

// ---------- provider config (BYOK) ----------

export type ProviderKind =
  | "anthropic"
  | "openai"
  | "grok"
  | "deepseek"
  | "qwen"
  | "custom"
  | "custom_anthropic";

/** API wire protocol. Mirrors EchoAgent's ApiBackend enum (snake_case). */
export type ApiBackend = "chat_completions" | "responses" | "messages";

/** HTTP auth header style. Mirrors EchoAgent's AuthScheme enum (snake_case). */
export type AuthScheme = "bearer" | "x_api_key";

/**
 * One connection/auth profile — written to `[model_providers.<id>]`. A single
 * provider holds one api_key / base_url shared by every model that references
 * it via `providerId`.
 */
export interface ModelProviderEntry {
  /** Stable id derived from providerKind (e.g. "openai", "custom-2"). */
  id: string;
  providerKind: ProviderKind;
  label?: string;
  /** Masked "••••" when read back; the real secret when saving. */
  apiKey?: string;
  baseUrl?: string;
  apiBackend?: ApiBackend;
  authScheme?: AuthScheme;
  /** Max context window in tokens, shared by all referencing models. */
  contextWindow?: number;
}

/**
 * One model catalog entry — written to `[model.<modelId>]` with a
 * `model_provider = "<providerId>"` reference. Carries only model-specific
 * fields; connection config lives on the provider.
 */
export interface ModelEntry {
  /** The `[model.<id>]` key AND the model slug sent in requests. */
  modelId: string;
  /** References a ModelProviderEntry.id. */
  providerId: string;
  /** Human-readable display name (EchoAgent's `name` field). */
  name?: string;
  /** Per-model context-window override (wins over the provider's value). */
  contextWindow?: number;
}

/** Result of providers_list: every provider + every model, joined by providerId. */
export interface ProviderListModel {
  providers: ModelProviderEntry[];
  models: ModelEntry[];
}

/**
 * Convenience: flatten the joined list back into per-model option rows for
 * pickers that only need { id, label }. Each model is joined with its
 * provider so consumers keep using a flat array.
 */
export interface ModelOptionRow {
  id: string;
  label: string;
  providerKind: ProviderKind;
  providerId: string;
}

/** Flatten a ProviderListModel into per-model rows (id + label + provider). */
export function flattenModels(list: ProviderListModel): ModelOptionRow[] {
  return list.models.map((m) => {
    const provider = list.providers.find((p) => p.id === m.providerId);
    return {
      id: m.modelId,
      label: m.name || m.modelId,
      providerKind: (provider?.providerKind ?? "custom") as ProviderKind,
      providerId: m.providerId,
    };
  });
}

export async function providersList(): Promise<ProviderListModel> {
  return invoke<ProviderListModel>("providers_list");
}

export async function providersSaveProvider(provider: ModelProviderEntry): Promise<void> {
  await invoke<void>("providers_save_provider", { provider });
}

export async function providersSaveModel(model: ModelEntry): Promise<void> {
  await invoke<void>("providers_save_model", { model });
}

export async function providersDeleteProvider(id: string): Promise<void> {
  await invoke<void>("providers_delete_provider", { id });
}

export async function providersDeleteModel(modelId: string): Promise<void> {
  await invoke<void>("providers_delete_model", { modelId });
}

/** One model entry returned by a provider's GET /models endpoint. */
export interface FetchedModel {
  id: string;
  ownedBy?: string;
}

/**
 * Fetch the list of available models from a provider's `/models` endpoint.
 * Works for any OpenAI-compatible endpoint and for Anthropic. The `apiKey` is
 * used only for this request — it is never persisted. Pass `baseUrl` to
 * override the provider's preset (required for `custom`).
 */
export async function providersFetchModels(
  providerKind: ProviderKind,
  apiKey: string,
  baseUrl?: string,
): Promise<FetchedModel[]> {
  return invoke<FetchedModel[]>("providers_fetch_models", {
    providerKind,
    apiKey,
    baseUrl: baseUrl ?? null,
  });
}

// ---------- skills (x.ai/skills/*) ----------

/** List all skills EchoAgent has discovered (user / project / bundled scopes). */
export async function skillsList(cwd?: string): Promise<SkillInfo[]> {
  return invoke<SkillInfo[]>("skills_list", { cwd: cwd ?? null });
}

/** Add a skill path (directory or file) to `[skills].paths` and rescan. */
export async function skillsAdd(path: string, cwd?: string): Promise<void> {
  await invoke<void>("skills_add", { path, cwd: cwd ?? null });
}

/** Remove a skill path from `[skills].paths`. */
export async function skillsRemove(path: string, cwd?: string): Promise<void> {
  await invoke<void>("skills_remove", { path, cwd: cwd ?? null });
}

/** Enable or disable a skill by name (writes `[skills] disabled`). */
export async function skillsToggle(name: string, enabled: boolean): Promise<void> {
  await invoke<void>("skills_toggle", { name, enabled });
}

/** Validate a folder, Markdown file, or ZIP without installing it. */
export async function skillsInspectPackage(path: string): Promise<SkillPackageInspection> {
  return invoke<SkillPackageInspection>("skills_inspect_package", { path });
}

/** Safely copy and atomically install/update a package under ~/.echo-agent/skills. */
export async function skillsInstallPackage(
  path: string,
  approveHighRisk = false,
): Promise<SkillInstallResult> {
  return invoke<SkillInstallResult>("skills_install_package", { path, approveHighRisk });
}

/** Remove an EchoAgent-managed package. External/project skills are never deleted. */
export async function skillsUninstallPackage(path: string): Promise<void> {
  await invoke<void>("skills_uninstall_package", { path });
}

// ---------- connectors / MCP (x.ai/mcp/*) ----------

/** List configured MCP servers. Pass the live sessionId to enrich entries
 *  with session state (EchoAgent's list accepts it optionally). */
export async function mcpList(sessionId?: string, refresh = false): Promise<McpServerEntry[]> {
  return invoke<McpServerEntry[]>("mcp_list", { sessionId: sessionId ?? null, refresh });
}

/** Add or update an MCP server. Without a session it is persisted for the next
 *  session; with one it is also hot-applied. */
export async function mcpUpsert(
  sessionId: string | undefined,
  server: McpUpsertRequest,
): Promise<McpMutationResult> {
  return invoke<McpMutationResult>("mcp_upsert", { sessionId: sessionId ?? null, server });
}

/** Delete an MCP server by name. */
export async function mcpDelete(sessionId: string | undefined, name: string): Promise<McpMutationResult> {
  return invoke<McpMutationResult>("mcp_delete", { sessionId: sessionId ?? null, name });
}

/** Enable or disable an MCP server at runtime. */
export async function mcpToggle(
  sessionId: string | undefined,
  name: string,
  enabled: boolean,
): Promise<McpMutationResult> {
  return invoke<McpMutationResult>("mcp_toggle", { sessionId: sessionId ?? null, name, enabled });
}

/** Complete a Runtime-provided connector setup schema in a live session. */
export async function mcpSetup(
  sessionId: string,
  name: string,
  values: Record<string, string>,
): Promise<void> {
  await invoke<void>("mcp_setup", { sessionId, name, values });
}

/** Enable or disable one MCP tool in the active session. */
export async function mcpToggleTool(
  sessionId: string,
  serverName: string,
  toolName: string,
  enabled: boolean,
): Promise<void> {
  await invoke<void>("mcp_toggle_tool", { sessionId, serverName, toolName, enabled });
}

/** Resolved absolute path of the standalone mcp.json (for the editor header). */
export async function mcpConfigPath(): Promise<string> {
  return invoke<string>("mcp_config_path");
}

/** Read the standalone mcp.json (returns an empty template if missing). */
export async function mcpConfigRead(): Promise<McpConfigFile> {
  return invoke<McpConfigFile>("mcp_config_read");
}

/** Validate + write the standalone mcp.json. When a sessionId is given each
 *  server is also synced live into EchoAgent (its upsert is session-scoped). */
export async function mcpConfigSave(content: string, sessionId?: string): Promise<McpConfigSaveResult> {
  return invoke<McpConfigSaveResult>("mcp_config_save", { content, sessionId: sessionId ?? null });
}

// ---------- MCP OAuth authorization (x.ai/mcp/auth_*) ----------

/** Kick off EchoAgent's browser OAuth flow for one MCP server. EchoAgent opens the
 *  system browser itself and the call resolves when the flow completes
 *  (status "authenticated" | "failed" | "setup_required"). */
export async function mcpAuthTrigger(
  sessionId: string,
  serverName: string,
): Promise<McpAuthTriggerResult> {
  return invoke<McpAuthTriggerResult>("mcp_auth_trigger", { sessionId, serverName });
}

/** List servers EchoAgent has flagged `needs_auth` for this session. */
export async function mcpAuthStatus(sessionId: string): Promise<McpAuthStatusEntry[]> {
  return invoke<McpAuthStatusEntry[]>("mcp_auth_status", { sessionId });
}

/** Subscribe to Runtime MCP handshake/health changes. */
export function onMcpStatusEvent(cb: (payload: unknown) => void): Promise<UnlistenFn> {
  return listen<unknown>("agent://mcp-status", (event) => cb(event.payload));
}

// ---------- CLI-type connector authorization (cli.json driven) ----------

/** Probe a CLI connector: has cli.json / CLI installed / currently authed. */
export async function connectorsCliStatus(
  root: string,
  source: string,
): Promise<ConnectorCliStatus> {
  return invoke<ConnectorCliStatus>("connectors_cli_status", { root, source });
}

/** Run the full CLI authorization flow (install → auth steps → verify).
 *  Long-running; auth URLs arrive via `onConnectorCliAuthUrl`. */
export async function connectorsCliAuth(
  root: string,
  source: string,
): Promise<ConnectorCliAuthResult> {
  return invoke<ConnectorCliAuthResult>("connectors_cli_auth", { root, source });
}

/** Cancel an in-flight CLI authorization (kills the child process tree). */
export async function connectorsCliAuthCancel(source: string): Promise<void> {
  await invoke<void>("connectors_cli_auth_cancel", { source });
}

/** Run the connector's unAuth command (logout / credential wipe). */
export async function connectorsCliUnauth(root: string, source: string): Promise<void> {
  await invoke<void>("connectors_cli_unauth", { root, source });
}

/** Absolute path of the connector's bundled skills/ dir (null if none). */
export async function connectorsCliSkillsDir(
  root: string,
  source: string,
): Promise<string | null> {
  return invoke<string | null>("connectors_cli_skills_dir", { root, source });
}

/** Subscribe to CLI auth URL events (show QR / open browser). */
export function onConnectorCliAuthUrl(
  cb: (e: ConnectorCliAuthUrlEvent) => void,
): Promise<UnlistenFn> {
  return listen<ConnectorCliAuthUrlEvent>("connector://cli-auth-url", (ev) => cb(ev.payload));
}

/** Subscribe to CLI auth log lines (progress display in the QR modal). */
export function onConnectorCliAuthLog(
  cb: (e: ConnectorCliAuthLogEvent) => void,
): Promise<UnlistenFn> {
  return listen<ConnectorCliAuthLogEvent>("connector://cli-auth-log", (ev) => cb(ev.payload));
}

/** Subscribe to CLI auth completion events. */
export function onConnectorCliAuthDone(
  cb: (e: ConnectorCliAuthDoneEvent) => void,
): Promise<UnlistenFn> {
  return listen<ConnectorCliAuthDoneEvent>("connector://cli-auth-done", (ev) => cb(ev.payload));
}

// ---------- connector marketplace (live local data dir) ----------

/** First existing candidate marketplace root ("" if none found). */
export async function connectorsDefaultRoot(): Promise<string> {
  return invoke<string>("connectors_default_root");
}

/** Marketplace roots under `root` that contain the connectors manifest. */
export async function connectorsListRoots(root: string): Promise<string[]> {
  return invoke<string[]>("connectors_list_roots", { root });
}

/** Load categories + connectors from the marketplace manifest. */
export async function connectorsLoad(root?: string): Promise<ConnectorCatalog> {
  return invoke<ConnectorCatalog>("connectors_load", { root: root ?? null });
}

/** Read a local icon file as a `data:` URL (svg/png). */
export async function connectorsIcon(path: string): Promise<string> {
  return invoke<string>("connectors_icon", { path });
}

/** Read `<root>/connectors/<source>/mcp.json` raw text ("" if missing). */
export async function connectorsReadMcpConfig(root: string, source: string): Promise<string> {
  return invoke<string>("connectors_read_mcp_config", { root, source });
}

/** Open a URL in the system browser (scheme-whitelisted backend command). */
export async function openUrl(url: string): Promise<void> {
  await invoke<void>("open_url", { url });
}

// ---------- skill catalog (runtime scan of agents + builtin dirs) ----------

/** First existing candidate agents data root ("" if none found). */
export async function skillsCatalogDefaultRoot(): Promise<string> {
  return invoke<string>("skills_catalog_default_root");
}

/** Agents roots under `root` that look scannable. */
export async function skillsCatalogListRoots(root: string): Promise<string[]> {
  return invoke<string[]>("skills_catalog_list_roots", { root });
}

/** Scan both sources and return the merged, deduped skill catalog. */
export async function skillsCatalogLoad(
  root?: string,
  builtinRoot?: string,
): Promise<SkillCatalog> {
  return invoke<SkillCatalog>("skills_catalog_load", {
    root: root ?? null,
    builtinRoot: builtinRoot ?? null,
  });
}

/** Read the full SKILL.md text for a directory. */
export async function skillsCatalogReadSkill(dir: string): Promise<string> {
  return invoke<string>("skills_catalog_read_skill", { dir });
}

// ---------- expert marketplace (live local data dir) ----------

/** First existing candidate data root ("" if none found). */
export async function expertsDefaultRoot(): Promise<string> {
  return invoke<string>("experts_default_root");
}

/** Data roots under `root` that contain the marketplace manifest. */
export async function expertsListRoots(root: string): Promise<string[]> {
  return invoke<string[]>("experts_list_roots", { root });
}

/** Load categories + experts by merging the manifest with each plugin.json. */
export async function expertsLoad(root?: string): Promise<ExpertCatalog> {
  return invoke<ExpertCatalog>("experts_load", { root: root ?? null });
}

/** Small base64 JPEG thumbnail for a local avatar path (cached server-side). */
export async function expertsThumbnail(path: string): Promise<string> {
  return invoke<string>("experts_thumbnail", { path });
}

/** Full-size local image as a `data:` URL (used for 精选场景 banners). */
export async function expertsImageBytes(path: string): Promise<string> {
  return invoke<string>("experts_image_bytes", { path });
}

/** Read the full agent prompt markdown from an expert's package directory. */
export async function expertsReadAgentPrompt(
  root: string,
  plugin: string,
  agentName: string,
): Promise<string> {
  return invoke<string>("experts_read_agent_prompt", { root, plugin, agentName });
}

/** Link a team expert's agents/*.md into ~/.echo-agent/agents/ for EchoAgent sub-agent discovery. */
export async function expertsLinkAgents(root: string, plugin: string): Promise<number> {
  return invoke<number>("experts_link_agents", { root, plugin });
}

/** Bind an expert to a session (EchoAgent-only state). */
export async function agentSetSessionExpert(
  sessionId: string,
  expertId: string,
  expertName: string,
  source: string,
  avatarLocal?: string,
): Promise<boolean> {
  return invoke<boolean>("agent_set_session_expert", { sessionId, expertId, expertName, source, avatarLocal: avatarLocal ?? null });
}

/** Remove the expert binding from a session. */
export async function agentClearSessionExpert(sessionId: string): Promise<boolean> {
  return invoke<boolean>("agent_clear_session_expert", { sessionId });
}

// ---------- experts / assistants (~/.echo-agent/agents/*.md) ----------

/** List all agent definitions visible to EchoAgent. */
export async function agentsList(cwd?: string): Promise<AgentEntry[]> {
  return invoke<AgentEntry[]>("agents_list", { cwd: cwd ?? null });
}

/** Fetch a single agent file's full contents. */
export async function agentsGet(path: string): Promise<string> {
  return invoke<string>("agents_get", { path });
}

/** Save an agent file (create or overwrite) to ~/.echo-agent/agents/<name>.md. */
export async function agentsSave(name: string, raw: string): Promise<AgentEntry> {
  return invoke<AgentEntry>("agents_save", { name, raw });
}

/** Delete an agent file by path. */
export async function agentsDelete(path: string): Promise<void> {
  await invoke<void>("agents_delete", { path });
}

/** Render a starter agent markdown body from name/description/system prompt.
 *  Optional avatar (1-20) and modelTags are written to frontmatter. */
export async function agentsTemplate(
  name: string,
  description: string,
  systemPrompt: string,
  avatar?: number,
  modelTags?: string[],
): Promise<string> {
  return invoke<string>("agents_template", {
    name,
    description,
    systemPrompt,
    avatar: avatar ?? null,
    modelTags: modelTags ?? null,
  });
}

// ---------- permission rules (~/.echo-agent/config.toml [permission]) ----------

/** List the current permission rules (allow/deny/ask) from config.toml. */
export async function permissionList(): Promise<PermissionRule[]> {
  return invoke<PermissionRule[]>("permission_list");
}

/** Replace all permission rules. Writes to config.toml atomically.
 *  NOTE: requires a EchoAgent restart to take effect. */
export async function permissionSave(rules: PermissionRule[]): Promise<void> {
  await invoke<void>("permission_save", { rules });
}

// ---------- permission mode (~/.echo-agent/config.toml [ui].permission_mode) ----------

/** EchoAgent 的权限模式:审批(ask)/自动(auto)/始终允许(always-approve)。 */
export type PermissionMode = "ask" | "auto" | "always-approve";

/** Read the configured permission mode (default "ask"). */
export async function permissionModeGet(): Promise<PermissionMode> {
  return invoke<PermissionMode>("permission_mode_get");
}

/** Set the permission mode: persists to config.toml and live-notifies the
 *  running agent via EchoAgent's `x.ai/yolo_mode_changed` extension notification. */
export async function permissionModeSet(mode: PermissionMode): Promise<void> {
  await invoke<void>("permission_mode_set", { mode });
}

// ---------- memory (资料库 — ~/.echo-agent/memory/) ----------

/** List memory notes from global + workspace scope. */
export async function memoryList(cwd?: string): Promise<MemoryEntry[]> {
  return invoke<MemoryEntry[]>("memory_list", { cwd: cwd ?? null });
}

/** Read a single memory file. */
export async function memoryGet(scope: string, path: string, cwd?: string): Promise<string> {
  return invoke<string>("memory_get", { scope, path, cwd: cwd ?? null });
}

/** Create or overwrite a memory note. */
export async function memorySave(
  scope: string,
  path: string,
  content: string,
  cwd?: string,
): Promise<MemoryEntry> {
  return invoke<MemoryEntry>("memory_save", { scope, path, content, cwd: cwd ?? null });
}

/** Delete a memory note. */
export async function memoryDelete(scope: string, path: string, cwd?: string): Promise<void> {
  await invoke<void>("memory_delete", { scope, path, cwd: cwd ?? null });
}

/** Trigger EchoAgent to rewrite memories via an LLM pass (`x.ai/memory/rewrite`). */
export async function memoryRewrite(): Promise<void> {
  await invoke<void>("memory_rewrite");
}

/** Flush in-flight memory writes to disk (`x.ai/memory/flush`). */
export async function memoryFlush(): Promise<void> {
  await invoke<void>("memory_flush");
}

// ---------- session search (FTS5) ----------

/** Full-text search across all sessions. */
export async function sessionSearch(
  query: string,
  cwd?: string,
  limit?: number,
): Promise<SearchHit[]> {
  return invoke<SearchHit[]>("session_search", { query, cwd: cwd ?? null, limit: limit ?? null });
}

// ---------- rewind ----------

/** List prompts a session can rewind to. */
export async function rewindPoints(sessionId: string): Promise<RewindPoint[]> {
  return invoke<RewindPoint[]>("rewind_points", { sessionId });
}

/** Rewind a session to a specific prompt index. */
export async function rewindExecute(
  sessionId: string,
  targetPromptIndex: number,
  mode?: string,
  force?: boolean,
): Promise<void> {
  await invoke<void>("rewind_execute", {
    sessionId,
    targetPromptIndex,
    mode: mode ?? null,
    force: force ?? null,
  });
}

// ---------- session fork ----------

/** Fork a session: copy history to a new session id. Returns the new id. */
export async function sessionFork(sessionId: string, cwd?: string): Promise<string> {
  return invoke<string>("session_fork", { sessionId, cwd: cwd ?? null });
}

// ---------- slash commands + prompt history ----------

/** List slash commands (builtin + skills + plugins). Powers "/" autocomplete. */
export async function commandsList(): Promise<SlashCommand[]> {
  return invoke<SlashCommand[]>("commands_list");
}

/** Cross-session prompt history. */
export async function promptHistory(limit?: number): Promise<string[]> {
  return invoke<string[]>("prompt_history", { limit: limit ?? null });
}

// ---------- tasks / subagents ----------

/** List running background tasks / subagents. */
export async function tasksList(): Promise<RunningTask[]> {
  return invoke<RunningTask[]>("tasks_list");
}

/** Kill a running task or subagent. */
export async function taskKill(taskId: string): Promise<void> {
  await invoke<void>("task_kill", { taskId });
}

// ---------- folder trust ----------

/** Respond to a folder-trust request from the embedded runtime. */
export async function folderTrustRespond(cwd: string, trusted: boolean): Promise<void> {
  await invoke<void>("folder_trust_respond", { cwd, trusted });
}

// ---------- plan mode ----------

/** Toggle plan mode for a session (client → EchoAgent notification). */
export async function togglePlanMode(sessionId: string, enabled: boolean): Promise<void> {
  await invoke<void>("toggle_plan_mode", { sessionId, enabled });
}

// ---------- internal reload ----------

/** Hot-reload EchoAgent's view of config/skills/mcp/models. `kind` ∈
 *  "mcp_all" | "mcp_project" | "skills" | "models". */
export async function internalReload(kind: "mcp_all" | "mcp_project" | "skills" | "models"): Promise<void> {
  await invoke<void>("internal_reload", { kind });
}

// ---------- authoritative local policy ----------

export async function policyGet<T>(): Promise<T> {
  return invoke<T>("policy_get");
}

export async function policySave<T>(policy: T): Promise<T> {
  return invoke<T>("policy_save", { policy });
}

// ---------- automations (local scheduler, EchoAgent 1:1) ----------

/** Full snapshot: automations (next runs recomputed) + run records. */
export async function automationsSnapshot(): Promise<AutomationSnapshot> {
  return invoke<AutomationSnapshot>("automations_snapshot");
}

/** Create or update an automation. */
export async function automationsSave(automation: Automation): Promise<Automation> {
  return invoke<Automation>("automations_save", { automation });
}

/** Delete an automation by id. */
export async function automationsDelete(id: string): Promise<void> {
  await invoke<void>("automations_delete", { id });
}

/** Set an automation's status ("ACTIVE" | "PAUSED"). */
export async function automationsSetStatus(id: string, status: AutomationStatus): Promise<void> {
  await invoke<void>("automations_set_status", { id, status });
}

/** Manually fire an automation now (test run). Opens a new EchoAgent session. */
export async function automationsRun(id: string): Promise<void> {
  await invoke<void>("automations_run", { id });
}

/** Archive / unarchive a run record. */
export async function automationRecordsArchive(id: string, archived: boolean): Promise<void> {
  await invoke<void>("automation_records_archive", { id, archived });
}

/** Delete a run record. */
export async function automationRecordsDelete(id: string): Promise<void> {
  await invoke<void>("automation_records_delete", { id });
}

// ---------- inspiration (灵感面板) ----------

/** Prepare an inspiration session. The caller must register event listeners
 *  before sending the returned prompt with `agentSend`, otherwise a fast
 *  response could complete before the listeners are active. */
export async function inspirationGenerate(
  category: string,
  cwd?: string,
  count?: number,
): Promise<InspirationStarted> {
  return invoke<InspirationStarted>("inspiration_generate", {
    request: { category, cwd: cwd ?? null, count: count ?? null },
  });
}

// ---------- xAI API Key 管理 (x.ai/getApiKey / x.ai/setApiKey) ----------
// EchoAgent OAuth 账户命令（accountInfo/accountCheckSubscription/accountLogout/
// accountGetAuthUrl/accountCancelAuth）已随 OAuth 功能移除。EchoAgent 仅保留
// xAI API Key（BYOK）认证路径。

/** Return a masked marker when an xAI API key is configured. */
export async function accountGetApiKey(): Promise<string | null> {
  return invoke<string | null>("account_get_api_key");
}

/** Set or clear the xAI API key. Empty/null clears it. */
export async function accountSetApiKey(key: string | null): Promise<void> {
  await invoke<void>("account_set_api_key", { key });
}

// ---------- agent / assistant defaults (~/.echo-agent/config.toml) ----------

/** Read the new-session defaults (model + permission + remember-tool-approvals). */
export async function agentsDefaultsGet(): Promise<AgentDefaults> {
  return invoke<AgentDefaults>("agents_defaults_get");
}

/** Save the new-session defaults. Atomic write to config.toml. */
export async function agentsDefaultsSave(defaults: AgentDefaults): Promise<void> {
  await invoke<void>("agents_defaults_save", { defaults });
}

// ---------- subagents config (~/.echo-agent/config.toml [subagents]) ----------

/** `[subagents]` config — currently exposes `max_depth` (nesting depth). */
export interface SubagentsConfig {
  /** Maximum subagent nesting depth (≥1). EchoAgent default = 1. */
  maxDepth: number;
}

/** Read `[subagents].max_depth`. Returns 1 when unset. */
export async function subagentsConfigGet(): Promise<SubagentsConfig> {
  return invoke<SubagentsConfig>("subagents_config_get");
}

/** Write `[subagents].max_depth` (clamped ≥1). Requires agent restart. */
export async function subagentsConfigSave(maxDepth: number): Promise<number> {
  return invoke<number>("subagents_config_save", { maxDepth });
}

// ---------- web search config (~/.echo-agent/config.toml [models].web_search) ----------

/** `[models].web_search` config — derived enabled flag + model id. */
export interface WebSearchConfig {
  /** true when a web_search model is set. */
  enabled: boolean;
  /** Configured web_search model id (empty = none). */
  model: string;
}

/** Read the web_search model. `enabled` is derived from whether a model is set. */
export async function webSearchConfigGet(): Promise<WebSearchConfig> {
  return invoke<WebSearchConfig>("web_search_config_get");
}

/** Enable/disable web search by setting/clearing `[models].web_search`.
 *  When enabling, `model` must be a non-empty model id. Requires agent restart. */
export async function webSearchConfigSave(
  enable: boolean,
  model?: string,
): Promise<boolean> {
  return invoke<boolean>("web_search_config_save", { enable, model });
}

// ---------- plugins + marketplace (x.ai/plugins/*, x.ai/marketplace/*) ----------

import type {
  MarketplaceListResponse,
  PluginsListResponse,
} from "./types";

/** List installed plugins via `x.ai/plugins/list`. */
export async function pluginsList(sessionId?: string): Promise<PluginsListResponse> {
  return invoke<PluginsListResponse>("plugins_list", { sessionId: sessionId ?? null });
}

/** Execute a plugin action (enable/disable/install/etc). */
export async function pluginsAction(
  sessionId: string,
  action: unknown,
): Promise<unknown> {
  return invoke("plugins_action", { sessionId, action });
}

/** List marketplace sources + plugins via `x.ai/marketplace/list`. */
export async function marketplaceList(sessionId?: string): Promise<MarketplaceListResponse> {
  return invoke<MarketplaceListResponse>("marketplace_list", { sessionId: sessionId ?? null });
}

/** Execute a marketplace action (install/uninstall/refresh/add_source/remove_source). */
export async function marketplaceAction(
  sessionId: string,
  action: unknown,
): Promise<unknown> {
  return invoke("marketplace_action", { sessionId, action });
}

// ---------- notification log (智能体邮箱) ----------

import type { NotificationEntry, NotificationKind } from "./types";

/** Append a notification to the log (called when a EchoAgent event is received). */
export async function notificationAppend(
  kind: NotificationKind | string,
  title: string,
  body?: string,
  sessionId?: string,
  severity?: "info" | "warn" | "error",
): Promise<void> {
  await invoke<void>("notification_append", {
    kind,
    title,
    body: body ?? null,
    sessionId: sessionId ?? null,
    severity: severity ?? null,
  });
}

/** List notifications (newest first). */
export async function notificationList(): Promise<NotificationEntry[]> {
  return invoke<NotificationEntry[]>("notification_list");
}

/** Mark a notification as read. */
export async function notificationMarkRead(id: number): Promise<void> {
  await invoke<void>("notification_mark_read", { id });
}

/** Mark all as read. */
export async function notificationMarkAllRead(): Promise<void> {
  await invoke<void>("notification_mark_all_read");
}

/** Clear all notifications. */
export async function notificationClear(): Promise<void> {
  await invoke<void>("notification_clear");
}

// ---------- export ----------

/** Export text content to an absolute path chosen by the user via the save
 *  dialog (e.g. "导出会话为 Markdown"). Unlike write_text_file, this is NOT
 *  restricted to the workspace — the path comes from explicit user consent
 *  in the native save dialog. */
export async function exportTextFile(path: string, content: string): Promise<string> {
  return invoke<string>("export_text_file", { path, content });
}

// ---------- filesystem: directory listing (file-tree sidebar) ----------

/** A single directory entry returned by `list_dir`. */
export interface DirEntry {
  /** File/dir basename. */
  name: string;
  /** Absolute path of the entry. */
  path: string;
  /** "directory" | "file" | "other". */
  kind: string;
  /** File size in bytes (directories report 0). */
  size: number;
  /** Last modified time in Unix milliseconds (0 when unavailable). */
  modifiedAt: number;
}

/**
 * List the immediate children of a directory (non-recursive).
 * Hidden entries and noisy build/VCS directories (.git/node_modules/…) are
 * skipped server-side. Capped at `maxEntries` (default 2000).
 */
export async function listDir(
  path: string,
  cwd?: string,
  maxEntries?: number,
): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("list_dir", {
    path,
    cwd: cwd ?? null,
    maxEntries: maxEntries ?? null,
  });
}

// ---------- projects (durable backend state) ----------

/** Load the canonical project collection from EchoAgent's private data dir. */
export async function projectsLoad<T>(): Promise<T[]> {
  return invoke<T[]>("projects_load");
}

/** Atomically replace the canonical project collection. */
export async function projectsSave(projects: unknown[]): Promise<void> {
  await invoke<void>("projects_save", { projects });
}

export interface ImportedProjectAsset {
  name: string;
  path: string;
  kind: "file" | "folder";
  ext?: string;
  sizeBytes: number;
  updatedAt: string;
}

export async function projectAssetsImport(
  projectId: string,
  sources: string[],
): Promise<ImportedProjectAsset[]> {
  return invoke<ImportedProjectAsset[]>("project_assets_import", { projectId, sources });
}

export async function projectAssetMakeDir(
  projectId: string,
  name: string,
): Promise<ImportedProjectAsset> {
  return invoke<ImportedProjectAsset>("project_asset_make_dir", { projectId, name });
}

export async function projectAssetRemove(projectId: string, path: string): Promise<void> {
  await invoke<void>("project_asset_remove", { projectId, path });
}

export async function projectAssetsRemoveAll(projectId: string): Promise<void> {
  await invoke<void>("project_assets_remove_all", { projectId });
}

export async function openLocalPath(path: string, cwd?: string): Promise<void> {
  await invoke<void>("open_path", { path, cwd: cwd ?? null });
}

export async function openExternalUrl(url: string): Promise<void> {
  await invoke<void>("open_url", { url });
}

export async function echoAgentDataDir(): Promise<string> {
  return invoke<string>("echo_agent_data_dir");
}

export async function openEchoAgentDataDir(): Promise<void> {
  await invoke<void>("open_echo_agent_data_dir");
}

// ---------- event subscription ----------

export interface AgentEventListeners {
  unlisten: UnlistenFn;
}

/** Subscribe to all EchoAgent events, dispatching into the provided callbacks. */
export async function subscribeAgentEvents(handlers: {
  onUpdate?: (u: SessionUpdate & { __sessionId?: string }) => void;
  onPermission?: (p: PermissionRequest) => void;
  onComplete?: (p: PromptComplete) => void;
  /** Fired when EchoAgent generates or renames a session title
   *  (`x.ai/session_notification` → `SessionSummaryGenerated`). */
  onSummary?: (s: SessionSummaryEvent) => void;
  /** Fired on MCP connector status / init-progress notifications. */
  onMcpStatus?: (p: unknown) => void;
  /** Fired when EchoAgent asks us to trust a folder (`x.ai/folder_trust/request`). */
  onFolderTrust?: (p: unknown) => void;
  /** Fired when plan mode is toggled (`x.ai/toggle_plan_mode`). */
  onPlanMode?: (p: unknown) => void;
  /** Fired when the permission mode (auto/yolo) changes. */
  onPermissionMode?: (p: unknown) => void;
  /** Fired when the current repository HEAD changes. */
  onGitHead?: (p: unknown) => void;
  /** Fired when the model list updates. */
  onModelsUpdate?: (p: unknown) => void;
  /** Fired on background task lifecycle (`task_backgrounded`/`task_completed`). */
  onTaskUpdate?: (p: unknown) => void;
  /** Fired when the agent asks a question (`x.ai/question`). */
  onQuestion?: (q: QuestionRequest) => void;
  /** Fired when the agent thread dies unexpectedly (panic/crash). */
  onAgentDied?: (p: { reason: string }) => void;
  /** Fired on subagent lifecycle (spawned/progress/finished). */
  onSubagent?: (e: SubagentLiveEvent) => void;
  /** Fired when a turn ends abnormally (`stopReason: "rate_limit" | "error"`).
   *  EchoAgent reports mid-stream failures via `prompt_complete` with these stop
   *  reasons rather than as a thrown error, so this event lets the UI show a
   *  friendly message instead of silently marking the turn complete. */
  onTurnError?: (e: TurnErrorEvent) => void;
}): Promise<UnlistenFn> {
  const unlisteners: UnlistenFn[] = [];
  const wire = async <T>(event: string, cb: ((p: T) => void) | undefined) => {
    if (!cb) return;
    unlisteners.push(await listen<T>(event, (e) => cb(e.payload)));
  };

  if (handlers.onUpdate) {
    unlisteners.push(
      await listen<SessionUpdate & { sessionId?: string }>("agent://update", (e) => {
        // Backend now tags each update with its sessionId. We forward it via
        // a side field so the store can filter (ignore updates for sessions
        // other than the current one — e.g. inspiration generation).
        const { sessionId, ...update } = e.payload;
        (update as SessionUpdate & { __sessionId?: string }).__sessionId = sessionId;
        handlers.onUpdate!(update as SessionUpdate & { __sessionId?: string });
      }),
    );
  }
  await wire<PermissionRequest>("agent://permission", handlers.onPermission);
  await wire<PromptComplete>("agent://complete", handlers.onComplete);
  await wire<SessionSummaryEvent>("agent://summary", handlers.onSummary);
  await wire("agent://mcp-status", handlers.onMcpStatus);
  await wire("agent://folder-trust", handlers.onFolderTrust);
  await wire("agent://plan-mode", handlers.onPlanMode);
  await wire("agent://permission-mode", handlers.onPermissionMode);
  await wire("agent://git-head", handlers.onGitHead);
  await wire("agent://models-update", handlers.onModelsUpdate);
  await wire("agent://task-update", handlers.onTaskUpdate);
  await wire<QuestionRequest>("agent://question", handlers.onQuestion);
  await wire<{ reason: string }>("agent://agent-died", handlers.onAgentDied);
  await wire<SubagentLiveEvent>("agent://subagent", handlers.onSubagent);
  await wire<TurnErrorEvent>("agent://turn-error", handlers.onTurnError);

  return () => unlisteners.forEach((u) => u());
}
