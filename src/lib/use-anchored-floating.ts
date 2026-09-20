import {
  useCallback,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

export type FloatingPlacement = "top" | "bottom";
export type FloatingAlignment = "start" | "center" | "end";
export type FloatingWidth = number | "anchor" | "content";

interface FloatingLayout {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: FloatingPlacement;
}

interface AnchoredFloatingOptions {
  preferredPlacement?: FloatingPlacement;
  align?: FloatingAlignment;
  width?: FloatingWidth;
  estimatedHeight?: number;
  offset?: number;
  viewportMargin?: number;
  zIndex?: number;
}

const hiddenStyle = (zIndex: number): CSSProperties => ({
  position: "fixed",
  right: "auto",
  bottom: "auto",
  visibility: "hidden",
  pointerEvents: "none",
  zIndex,
});

/**
 * Position a body-portalled popover next to an anchor without allowing any
 * scroll container or rounded-card overflow rule to clip it.
 */
export function useAnchoredFloating(
  anchorRef: RefObject<HTMLElement | null>,
  floatingRef: RefObject<HTMLElement | null>,
  open: boolean,
  options: AnchoredFloatingOptions = {},
): { style: CSSProperties; placement: FloatingPlacement | null } {
  const {
    preferredPlacement = "top",
    align = "start",
    width = "content",
    estimatedHeight = 240,
    offset = 8,
    viewportMargin = 8,
    zIndex = 1200,
  } = options;
  const [layout, setLayout] = useState<FloatingLayout | null>(null);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const floating = floatingRef.current;
    if (!anchor || !floating) return;

    const rect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    // A zero-sized rect is also what non-layout environments such as JSDOM
    // return for visible controls. Only apply the off-screen guard when the
    // browser supplied a measurable anchor box.
    const hasMeasurableArea = rect.width > 0 || rect.height > 0;
    if (hasMeasurableArea && (
      rect.bottom <= 0
      || rect.top >= viewportHeight
      || rect.right <= 0
      || rect.left >= viewportWidth
    )) {
      setLayout(null);
      return;
    }

    const maxViewportWidth = Math.max(0, viewportWidth - viewportMargin * 2);
    const measuredWidth = width === "anchor"
      ? rect.width
      : width === "content"
        ? floating.offsetWidth
        : width;
    const floatingWidth = Math.min(
      Math.max(0, measuredWidth || rect.width),
      maxViewportWidth,
    );
    const measuredHeight = floating.scrollHeight || floating.offsetHeight || estimatedHeight;
    const spaceAbove = Math.max(0, rect.top - offset - viewportMargin);
    const spaceBelow = Math.max(0, viewportHeight - rect.bottom - offset - viewportMargin);
    const preferredSpace = preferredPlacement === "top" ? spaceAbove : spaceBelow;
    const alternateSpace = preferredPlacement === "top" ? spaceBelow : spaceAbove;
    const placement: FloatingPlacement = preferredSpace >= measuredHeight
      || preferredSpace >= alternateSpace
      ? preferredPlacement
      : preferredPlacement === "top" ? "bottom" : "top";
    const availableHeight = placement === "top" ? spaceAbove : spaceBelow;
    const renderedHeight = Math.min(measuredHeight, availableHeight);

    const desiredLeft = align === "end"
      ? rect.right - floatingWidth
      : align === "center"
        ? rect.left + (rect.width - floatingWidth) / 2
        : rect.left;
    const maxLeft = Math.max(viewportMargin, viewportWidth - floatingWidth - viewportMargin);
    const left = Math.min(Math.max(viewportMargin, desiredLeft), maxLeft);
    const desiredTop = placement === "top"
      ? rect.top - offset - renderedHeight
      : rect.bottom + offset;
    const maxTop = Math.max(viewportMargin, viewportHeight - renderedHeight - viewportMargin);
    const top = Math.min(Math.max(viewportMargin, desiredTop), maxTop);

    setLayout((previous) => {
      const next = { left, top, width: floatingWidth, maxHeight: availableHeight, placement };
      return previous
        && previous.left === next.left
        && previous.top === next.top
        && previous.width === next.width
        && previous.maxHeight === next.maxHeight
        && previous.placement === next.placement
        ? previous
        : next;
    });
  }, [
    align,
    anchorRef,
    estimatedHeight,
    floatingRef,
    offset,
    preferredPlacement,
    viewportMargin,
    width,
  ]);

  useLayoutEffect(() => {
    if (!open) {
      setLayout(null);
      return;
    }

    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updatePosition);
    if (anchorRef.current) observer?.observe(anchorRef.current);
    if (floatingRef.current) observer?.observe(floatingRef.current);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      observer?.disconnect();
    };
  }, [anchorRef, floatingRef, open, updatePosition]);

  return {
    placement: layout?.placement ?? null,
    style: layout
      ? {
          position: "fixed",
          right: "auto",
          bottom: "auto",
          left: layout.left,
          top: layout.top,
          width: layout.width,
          maxWidth: `calc(100vw - ${viewportMargin * 2}px)`,
          maxHeight: layout.maxHeight,
          overflowY: "auto",
          overscrollBehavior: "contain",
          zIndex,
        }
      : hiddenStyle(zIndex),
  };
}
