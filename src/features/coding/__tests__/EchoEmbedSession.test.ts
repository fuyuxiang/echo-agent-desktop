import { beforeEach, describe, expect, it, vi } from "vitest";

describe("Theia iframe bootstrap credentials", () => {
  beforeEach(() => window.sessionStorage.removeItem("echo-embed-session-v1"));
  it("reads the frame name and clears it before other extensions run", async () => {
    const previousName = window.name;
    window.name = `echo-embed:${JSON.stringify({
      embedToken: "backend-secret", bridgeToken: "frame-secret", parentOrigin: "tauri://localhost",
    })}`;
    vi.resetModules();
    try {
      const { echoEmbedSession } = await import("../../../../vendor/theia-platform/packages/core/src/browser/echo-embed-session");
      expect(echoEmbedSession.embedToken).toBe("backend-secret");
      expect(echoEmbedSession.bridgeToken).toBe("frame-secret");
      expect(window.name).toBe("");
      expect(window.location.search).toBe("");
      vi.resetModules();
      const reloaded = await import("../../../../vendor/theia-platform/packages/core/src/browser/echo-embed-session");
      expect(reloaded.echoEmbedSession).toEqual(echoEmbedSession);
    } finally {
      window.name = previousName;
    }
  });
  it("keeps connection values in memory and removes them from the page URL", async () => {
    const initial = window.location.href;
    const url = new URL(initial);
    url.searchParams.set("echoEmbedToken", "backend-secret");
    url.searchParams.set("echoBridgeToken", "frame-secret");
    url.searchParams.set("echoParentOrigin", "tauri://localhost");
    url.hash = "/project";
    window.history.replaceState(null, "", url);
    vi.resetModules();
    try {
      const { echoEmbedSession } = await import("../../../../vendor/theia-platform/packages/core/src/browser/echo-embed-session");
      expect(echoEmbedSession).toEqual({
        embedToken: "backend-secret",
        bridgeToken: "frame-secret",
        parentOrigin: "tauri://localhost",
      });
      expect(window.location.search).toBe("");
      expect(window.location.hash).toBe("#/project");
    } finally {
      window.history.replaceState(null, "", initial);
    }
  });
});
