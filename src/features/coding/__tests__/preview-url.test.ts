import { describe, expect, it } from "vitest";

import type { ChatMessage } from "@/stores/session-store";

import { localPreviewUrls } from "../lib/preview-url";

const assistant = (text: string): ChatMessage => ({
  id: text,
  role: "assistant",
  parts: [{ kind: "text", text }],
  complete: true,
});

describe("localPreviewUrls", () => {
  it("finds local development URLs without including their path or binding host", () => {
    expect(localPreviewUrls([assistant("Local: http://localhost:5173/demo  Network: http://0.0.0.0:3000/")]))
      .toEqual(["http://localhost:5173/", "http://127.0.0.1:3000/"]);
  });

  it("ignores remote addresses and invalid ports", () => {
    expect(localPreviewUrls([assistant("https://example.com:443 http://localhost:99999")])).toEqual([]);
  });
});
