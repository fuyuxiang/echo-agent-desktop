import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredFloating } from "@/lib/use-anchored-floating";
import { useModalPresence } from "@/lib/use-modal-focus";

interface ActiveTooltip {
  element: HTMLElement;
  text: string;
  /** Remount the positioned bubble when the anchor changes. */
  key: number;
}

function tooltipTarget(value: EventTarget | null): HTMLElement | null {
  if (!(value instanceof Element)) return null;
  const target = value.closest<HTMLElement>("[data-tip]");
  return target?.dataset.tip?.trim() ? target : null;
}

/**
 * One application-level tooltip layer for every `data-tip` control.
 *
 * CSS pseudo-element tooltips are trapped by ancestors that create stacking
 * contexts (for example `backdrop-filter`) or clip overflow. Rendering the
 * bubble in `document.body` keeps hints readable across topbars, scroll areas,
 * drawers, and dialogs while event delegation keeps existing call sites small.
 */
export function GlobalTooltip() {
  const [active, setActive] = useState<ActiveTooltip | null>(null);
  const modalOpen = useModalPresence();
  const hoveredRef = useRef<HTMLElement | null>(null);
  const focusedRef = useRef<HTMLElement | null>(null);
  const nextKeyRef = useRef(1);

  const showCurrent = useCallback(() => {
    const element = focusedRef.current ?? hoveredRef.current;
    const text = element?.dataset.tip?.trim();
    if (!element || !text || !element.isConnected) {
      setActive(null);
      return;
    }
    setActive((current) => {
      if (current?.element === element && current.text === text) return current;
      const next = { element, text, key: nextKeyRef.current };
      nextKeyRef.current += 1;
      return next;
    });
  }, []);

  const dismiss = useCallback(() => {
    hoveredRef.current = null;
    focusedRef.current = null;
    setActive(null);
  }, []);

  // A dialog can appear programmatically (for example an automatic update),
  // without a pointer or keyboard activation that would normally dismiss the
  // hint. Never let a stale page tooltip float above a newly opened scrim.
  useEffect(() => {
    if (modalOpen) dismiss();
  }, [dismiss, modalOpen]);

  useEffect(() => {
    const onPointerOver = (event: PointerEvent) => {
      const target = tooltipTarget(event.target);
      if (!target || target === hoveredRef.current) return;
      hoveredRef.current = target;
      showCurrent();
    };
    const onPointerOut = (event: PointerEvent) => {
      const target = tooltipTarget(event.target);
      if (!target || target !== hoveredRef.current) return;
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
      hoveredRef.current = null;
      showCurrent();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = tooltipTarget(event.target);
      if (!target) return;
      focusedRef.current = target;
      showCurrent();
    };
    const onFocusOut = (event: FocusEvent) => {
      const target = tooltipTarget(event.target);
      if (!target || target !== focusedRef.current) return;
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
      focusedRef.current = null;
      showCurrent();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Keyboard activation can open a menu without producing a click (for
      // example ArrowDown on a menu button). Clear the hint before the newly
      // opened surface is painted so the higher tooltip layer cannot cover it.
      if (["Escape", "Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
        dismiss();
      }
    };

    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    // Opening an action or popover should dismiss its hint immediately.
    document.addEventListener("click", dismiss);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("click", dismiss);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", dismiss);
    };
  }, [dismiss, showCurrent]);

  // Programmatic navigation can remove a hovered control without dispatching
  // pointerout. Do not leave a detached tooltip behind in that case.
  useEffect(() => {
    if (!active || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      if (!active.element.isConnected) dismiss();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [active, dismiss]);

  return active && !modalOpen ? (
    <TooltipBubble key={active.key} anchor={active.element} text={active.text} />
  ) : null;
}

function TooltipBubble({ anchor, text }: { anchor: HTMLElement; text: string }) {
  const tooltipId = useId();
  const anchorRef = useRef<HTMLElement>(anchor);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const { style, placement } = useAnchoredFloating(
    anchorRef,
    tooltipRef,
    true,
    {
      preferredPlacement: "bottom",
      align: "center",
      width: "content",
      estimatedHeight: 30,
      offset: 6,
      zIndex: "var(--echo-layer-tooltip)",
    },
  );

  useEffect(() => {
    const describedBy = anchor.getAttribute("aria-describedby")
      ?.split(/\s+/)
      .filter(Boolean) ?? [];
    if (!describedBy.includes(tooltipId)) {
      anchor.setAttribute("aria-describedby", [...describedBy, tooltipId].join(" "));
    }
    return () => {
      const remaining = (anchor.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .filter((id) => id && id !== tooltipId);
      if (remaining.length > 0) anchor.setAttribute("aria-describedby", remaining.join(" "));
      else anchor.removeAttribute("aria-describedby");
    };
  }, [anchor, tooltipId]);

  return createPortal(
    <div
      ref={tooltipRef}
      id={tooltipId}
      className="global-tooltip"
      role="tooltip"
      data-placement={placement ?? undefined}
      style={style}
    >
      {text}
    </div>,
    document.body,
  );
}
