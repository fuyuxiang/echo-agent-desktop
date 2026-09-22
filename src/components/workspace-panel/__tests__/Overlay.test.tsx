import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Modal, Popover, Tooltip } from "../Overlay";

describe("Overlay components", () => {
  describe("Popover", () => {
    it("renders nothing when closed", () => {
      render(<Popover open={false} onClose={() => {}}>content</Popover>);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("renders content when open and closes on Escape", () => {
      const onClose = vi.fn();
      render(<Popover open onClose={onClose}>hello</Popover>);
      const dialog = screen.getByRole("dialog");
      expect(dialog.textContent).toContain("hello");
      fireEvent.keyDown(dialog, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closes when clicking outside", () => {
      const onClose = vi.fn();
      render(
        <div>
          <button data-testid="outside">outside</button>
          <Popover open onClose={onClose}>content</Popover>
        </div>,
      );
      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("Tooltip", () => {
    it("shows content on mouse enter and hides on leave", async () => {
      render(
        <Tooltip content="tip-body">
          <button data-testid="trigger">trigger</button>
        </Tooltip>,
      );
      expect(screen.queryByText("tip-body")).toBeNull();
      fireEvent.mouseEnter(screen.getByTestId("trigger"));
      expect(await screen.findByText("tip-body")).not.toBeNull();
      fireEvent.mouseLeave(screen.getByTestId("trigger"));
      expect(screen.queryByText("tip-body")).toBeNull();
    });
  });

  describe("Modal", () => {
    it("renders a scrim and traps focus when open", () => {
      render(
        <Modal open onClose={() => {}} title="t">
          <button>child</button>
        </Modal>,
      );
      expect(screen.getByRole("dialog", { name: "t" })).not.toBeNull();
    });

    it("closes on Escape", () => {
      const onClose = vi.fn();
      render(
        <Modal open onClose={onClose} title="t">
          <button>x</button>
        </Modal>,
      );
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});