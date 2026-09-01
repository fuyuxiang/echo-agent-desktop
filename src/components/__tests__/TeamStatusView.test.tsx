import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TeamStatusView } from "../TeamStatusView";
import { teamSnapshot } from "@/lib/agent-client";

vi.mock("@/lib/agent-client", () => ({ teamSnapshot: vi.fn() }));

describe("TeamStatusView", () => {
  beforeEach(() => vi.mocked(teamSnapshot).mockReset());

  it("从持久化运行时快照展示真实团队", async () => {
    vi.mocked(teamSnapshot).mockResolvedValue([{
      teamId: "release-team",
      members: ["planner", "reviewer"],
      createdAt: 10,
    }]);
    render(<TeamStatusView messages={[]} />);
    expect(await screen.findByText("release-team")).toBeInTheDocument();
    expect(screen.getByText("planner")).toBeInTheDocument();
    expect(screen.getByText("1 个 · 2 名成员")).toBeInTheDocument();
  });

  it("无团队时给出明确空状态", async () => {
    vi.mocked(teamSnapshot).mockResolvedValue([]);
    render(<TeamStatusView messages={[]} />);
    expect(await screen.findByText(/当前没有活动团队/)).toBeInTheDocument();
    expect(teamSnapshot).toHaveBeenCalled();
  });

});
