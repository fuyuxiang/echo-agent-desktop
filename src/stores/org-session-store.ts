import { create } from "zustand";
import { orgSession, type OrgSession } from "@/lib/org-client";

interface OrgSessionState {
  session: OrgSession | null;
  hydrated: boolean;
  hydrate: () => Promise<OrgSession | null>;
  setSession: (session: OrgSession) => void;
  clearSession: () => void;
}

let hydrationInFlight: Promise<OrgSession | null> | null = null;

export interface OrganizationKnowledgeAvailability {
  available: boolean;
  reason: string;
  /** Account/server identity used to partition renderer-side Runtime acks. */
  identity: string;
}

export function organizationKnowledgeAvailability(
  state: Pick<OrgSessionState, "session" | "hydrated"> = useOrgSessionStore.getState(),
): OrganizationKnowledgeAvailability {
  const { session, hydrated } = state;
  const hasSharedScope = Boolean(session?.bootstrap?.scopes.some(
    (scope) => scope.kind === "team" || scope.kind === "org",
  ));
  const identity = session?.loggedIn && session.serverUrl && session.user?.id
    ? JSON.stringify([session.serverUrl, session.user.id])
    : "signed-out";

  if (!hydrated) {
    return { available: false, reason: "正在检查组织连接状态", identity };
  }
  if (!session?.loggedIn) {
    return { available: false, reason: "登录组织后可用", identity };
  }
  if (!hasSharedScope) {
    return { available: false, reason: "当前账号暂无团队或组织知识权限", identity };
  }
  if (session.organizationMemoryEnabled !== true) {
    return { available: false, reason: "组织服务不可连接或登录已过期", identity };
  }
  return {
    available: true,
    reason: "使用组织账号中你有权限的知识",
    identity,
  };
}

/**
 * Application-wide organization identity.
 *
 * Native code remains authoritative for credentials and access tokens. This
 * store only mirrors the safe session view returned by `org_session`, so the
 * shell (not just the organization page) can render the signed-in identity.
 */
export const useOrgSessionStore = create<OrgSessionState>((set, get) => ({
  session: null,
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return get().session;
    if (hydrationInFlight) return hydrationInFlight;

    hydrationInFlight = (async () => {
      try {
        const session = await orgSession();
        set({ session, hydrated: true });
        return session;
      } catch {
        // Organization connectivity must never block the local desktop shell.
        // The organization page retries and surfaces the detailed error.
        set({ session: null, hydrated: true });
        return null;
      } finally {
        hydrationInFlight = null;
      }
    })();
    return hydrationInFlight;
  },

  setSession: (session) => set({ session, hydrated: true }),
  clearSession: () => set((state) => ({
    session: {
      loggedIn: false,
      serverUrl: state.session?.serverUrl,
      username: state.session?.username ?? state.session?.user?.username,
      requiresReauthentication: false,
    },
    hydrated: true,
  })),
}));

/** Test/support reset; does not touch native credentials. */
export function resetOrgSessionMirror(): void {
  hydrationInFlight = null;
  useOrgSessionStore.setState({ session: null, hydrated: false });
}
