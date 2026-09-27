// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../InputAddMenu", () => ({
  InputAddMenu: ({ meetingMinutesAvailable }: { meetingMinutesAvailable: boolean }) => (
    <span data-testid="meeting-menu-availability">{meetingMinutesAvailable ? "visible" : "hidden"}</span>
  ),
}));

import { Composer } from "../Composer";

const base = {
  streaming: false,
  apiReady: true,
  onSend: vi.fn(),
  onCancel: vi.fn(),
  onOpenMeetingMinutes: vi.fn(),
};
const models = [
  { id: "organization/MiniMax-M3", remoteModelId: "MiniMax-M3", providerId: "echoagent-organization", source: "organization" as const, providerKind: "custom" },
  { id: "personal/other", remoteModelId: "other-chat", providerId: "personal", source: "personal" as const, providerKind: "custom" },
  { id: "echoagent-ojlab/MiniMax-M3", remoteModelId: "MiniMax-M3", providerId: "echoagent-ojlab", source: "builtin" as const, providerKind: "custom" },
];

describe("Composer meeting entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.invoke.mockResolvedValue(undefined);
  });

  it("appears after a MiniMax speech check and hides when switching models", async () => {
    const { rerender } = render(<Composer {...base} modelId={models[0].id} models={models} />);
    expect(screen.getByTestId("meeting-menu-availability")).toHaveTextContent("hidden");
    await waitFor(() => expect(screen.getByTestId("meeting-menu-availability")).toHaveTextContent("visible"));
    expect(mocks.invoke).toHaveBeenCalledWith("meeting_check_connection", {
      modelId: models[0].id,
      providerId: models[0].providerId,
    });

    rerender(<Composer {...base} modelId={models[1].id} models={models} />);
    expect(screen.getByTestId("meeting-menu-availability")).toHaveTextContent("hidden");

    rerender(<Composer {...base} modelId={models[2].id} models={models} />);
    expect(screen.getByTestId("meeting-menu-availability")).toHaveTextContent("hidden");
  });
});
