import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

/** Tall controls have no room above or below them for an anchored tooltip.
 * Keep their body-portalled hints beside the pointer or keyboard focus. */
export function PointerSideHint({ anchorRef, pointerY, text, id, role = "tooltip" }: {
  anchorRef: RefObject<HTMLElement>;
  pointerY: number | null;
  text: string;
  id: string;
  role?: "tooltip" | "status";
}) {
  const hintRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number; placement: "top" | "bottom" } | null>(null);

  useLayoutEffect(() => {
    const update = () => {
      const anchor = anchorRef.current;
      const hint = hintRef.current;
      if (!anchor || !hint) return;
      const rect = anchor.getBoundingClientRect();
      const bubble = hint.getBoundingClientRect();
      const margin = 8;
      const gap = 14;
      const clamp = (value: number, max: number) => Math.min(Math.max(margin, value), Math.max(margin, max));
      // Keyboard focus stays near the top controls; mouse/drag hints follow Y.
      const y = clamp(Math.max(rect.top, Math.min(pointerY ?? rect.top + 48, rect.bottom)), window.innerHeight - margin);
      const right = rect.right + gap;
      const desiredLeft = right + bubble.width <= window.innerWidth - margin
        ? right : rect.left - gap - bubble.width;
      const placement = y + gap + bubble.height <= window.innerHeight - margin ? "bottom" : "top";
      const next = {
        left: clamp(desiredLeft, window.innerWidth - bubble.width - margin),
        top: clamp(placement === "bottom" ? y + gap : y - gap - bubble.height, window.innerHeight - bubble.height - margin),
        placement,
      } as const;
      setPosition(previous => previous?.left === next.left && previous.top === next.top && previous.placement === next.placement
        ? previous : next);
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (hintRef.current) observer?.observe(hintRef.current);
    if (anchorRef.current) observer?.observe(anchorRef.current);
    // Keyboard resizing moves the divider without changing its dimensions.
    const mutation = typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
    if (anchorRef.current) mutation?.observe(anchorRef.current, { attributes: true, attributeFilter: ["style", "class"] });
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      observer?.disconnect();
      mutation?.disconnect();
    };
  }, [anchorRef, pointerY, text]);

  return createPortal(
    <div ref={hintRef} id={id} className={`global-tooltip pointer-side-hint${anchorRef.current?.closest('[aria-modal="true"]') ? " global-tooltip--dialog" : ""}`}
      role={role} data-placement={position?.placement}
      style={{ position: "fixed", zIndex: "var(--echo-layer-tooltip)",
        left: position?.left, top: position?.top, visibility: position ? undefined : "hidden" }}>
      {text}
    </div>,
    document.body,
  );
}
