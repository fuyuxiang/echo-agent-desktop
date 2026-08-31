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
  clearSession: () => set({ session: { loggedIn: false }, hydrated: true }),
}));

/** Test/support reset; does not touch native credentials. */
export function resetOrgSessionMirror(): void {
  hydrationInFlight = null;
  useOrgSessionStore.setState({ session: null, hydrated: false });
}
