import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AutomationBoundaryNotice } from "./AutomationBoundaryNotice";

describe("AutomationBoundaryNotice", () => {
  it("role=null 且 computerActive=false 不渲染", () => {
    const { container } = render(
      <AutomationBoundaryNotice role={null} computerActive={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("role=always-approve 且 computerActive=false 不渲染", () => {
    const { container } = render(
      <AutomationBoundaryNotice role="always-approve" computerActive={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("role=auto 且 computerActive=true 不渲染（边界条件必须同时满足）", () => {
    const { container } = render(
      <AutomationBoundaryNotice role="auto" computerActive={true} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("role=always-approve 且 computerActive=true 渲染边界提示", () => {
    render(
      <AutomationBoundaryNotice role="always-approve" computerActive={true} />,
    );
    const notice = screen.getByRole("note");
    expect(notice.textContent).toMatch(/操作电脑/);
    expect(notice.textContent).toMatch(/逐次确认/);
  });
});