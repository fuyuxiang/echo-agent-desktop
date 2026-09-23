import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AutomationBoundaryNotice } from "./AutomationBoundaryNotice";

describe("AutomationBoundaryNotice", () => {
  it("role=null 且默认模式不渲染", () => {
    const { container } = render(
      <AutomationBoundaryNotice role={null} automationMode="default" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("role=always-approve 且默认模式不渲染", () => {
    const { container } = render(
      <AutomationBoundaryNotice role="always-approve" automationMode="default" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("role=auto 且电脑模式不渲染（边界条件必须同时满足）", () => {
    const { container } = render(
      <AutomationBoundaryNotice role="auto" automationMode="computer_use" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("role=always-approve 且电脑模式渲染边界提示", () => {
    render(
      <AutomationBoundaryNotice role="always-approve" automationMode="computer_use" />,
    );
    const notice = screen.getByRole("note");
    expect(notice.textContent).toMatch(/操作电脑/);
    expect(notice.textContent).toMatch(/逐次确认/);
  });

  it("role=always-approve 且网页模式也渲染副作用边界", () => {
    render(<AutomationBoundaryNotice role="always-approve" automationMode="browser_use" />);
    expect(screen.getByRole("note")).toHaveTextContent("操作网页");
  });
});
