import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button, IconButton } from "../Button";

describe("shared native buttons", () => {
  it("preserves refs, form submission and native disabled behavior", () => {
    const ref = createRef<HTMLButtonElement>();
    const submit = vi.fn((event) => event.preventDefault());
    const { rerender } = render(<form onSubmit={submit}><Button ref={ref} type="submit">保存</Button></form>);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(ref.current).toBe(screen.getByRole("button", { name: "保存" }));
    rerender(<form onSubmit={submit}><Button ref={ref} type="submit" loading>保存</Button></form>);
    const button = screen.getByRole("button", { name: "保存" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    fireEvent.click(button);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("gives icon actions an accessible name and defaults to a non-submit button", () => {
    render(<IconButton label="关闭面板"><span aria-hidden="true">×</span></IconButton>);
    expect(screen.getByRole("button", { name: "关闭面板" })).toHaveAttribute("type", "button");
  });
});
