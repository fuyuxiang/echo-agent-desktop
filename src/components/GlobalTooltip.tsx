import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredFloating } from "@/lib/use-anchored-floating";
import { useModalPresence } from "@/lib/use-modal-focus";
import { PointerSideHint } from "./PointerSideHint";

const POINTER_SHOW_DELAY_MS = 350;
const NATIVE_TITLE_MARKER = "data-global-tooltip-native";
const TOOLTIP_SELECTOR = `[data-tip], [title]:not(iframe), [${NATIVE_TITLE_MARKER}]`;

interface SuppressedNativeTitle {
  text: string;
  addedAriaLabel: boolean;
}

interface ActiveTooltip {
  element: HTMLElement;
  text: string;
  pointerY: number | null;
  /** Remount the positioned bubble when the anchor changes. */
  key: number;
}

function normalizedAccessibleText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function tooltipText(
  element: HTMLElement,
  suppressedTitles: Map<HTMLElement, SuppressedNativeTitle>,
  focused = false,
): string {
  return (focused ? element.dataset.tipFocus?.trim() : "")
    || element.dataset.tip?.trim()
    || element.getAttribute("title")?.trim()
    || suppressedTitles.get(element)?.text.trim()
    || "";
}

function tooltipTarget(
  value: EventTarget | null,
  suppressedTitles: Map<HTMLElement, SuppressedNativeTitle>,
): HTMLElement | null {
  if (!(value instanceof Element)) return null;
  const target = value.closest(TOOLTIP_SELECTOR);
  if (!(target instanceof HTMLElement)) return null;
  return tooltipText(target, suppressedTitles) ? target : null;
}

/**
 * One application-level tooltip layer for explicit `data-tip` controls and
 * existing native `title` hints.
 *
 * CSS pseudo-element tooltips are trapped by ancestors that create stacking
 * contexts (for example `backdrop-filter`) or clip overflow. Rendering the
 * bubble in `document.body` keeps hints readable across topbars, scroll areas,
 * drawers, and dialogs. Native titles are temporarily suppressed while their
 * custom hint is active, avoiding duplicate browser and application bubbles.
 */
export function GlobalTooltip() {
  const [active, setActive] = useState<ActiveTooltip | null>(null);
  const modalOpen = useModalPresence();
  const hoveredRef = useRef<HTMLElement | null>(null);
  const focusedRef = useRef<HTMLElement | null>(null);
  const pointerTimerRef = useRef<number | null>(null);
  const pointerYRef = useRef<number | null>(null);
  const hoverReadyRef = useRef(false);
  const pointerDownRef = useRef(false);
  const hiddenFocusedRef = useRef<HTMLElement | null>(null);
  const hiddenHoveredRef = useRef<HTMLElement | null>(null);
  const suppressedTitlesRef = useRef(new Map<HTMLElement, SuppressedNativeTitle>());
  const nextKeyRef = useRef(1);

  const cancelPointerTimer = useCallback(() => {
    if (pointerTimerRef.current === null) return;
    window.clearTimeout(pointerTimerRef.current);
    pointerTimerRef.current = null;
  }, []);

  const suppressNativeTitle = useCallback((element: HTMLElement) => {
    const title = element.getAttribute("title")?.trim();
    if (!title) return;

    const previous = suppressedTitlesRef.current.get(element);
    const hasAccessibleName = Boolean(
      element.getAttribute("aria-label")?.trim()
      || element.getAttribute("aria-labelledby")?.trim()
      || element.textContent?.trim(),
    );
    const addedAriaLabel = previous?.addedAriaLabel ?? !hasAccessibleName;
    if (previous?.addedAriaLabel && element.getAttribute("aria-label") === previous.text) {
      element.setAttribute("aria-label", title);
    } else if (addedAriaLabel && !element.hasAttribute("aria-label")) {
      // `title` is sometimes the only accessible name on legacy icon buttons.
      // Preserve that name while the native attribute is suppressed.
      element.setAttribute("aria-label", title);
    }
    suppressedTitlesRef.current.set(element, { text: title, addedAriaLabel });
    element.removeAttribute("title");
    element.setAttribute(NATIVE_TITLE_MARKER, "");
  }, []);

  const restoreNativeTitle = useCallback((element: HTMLElement) => {
    const saved = suppressedTitlesRef.current.get(element);
    if (!saved) return;
    suppressedTitlesRef.current.delete(element);
    element.removeAttribute(NATIVE_TITLE_MARKER);
    if (element.isConnected && !element.hasAttribute("title")) {
      element.setAttribute("title", saved.text);
    }
    if (saved.addedAriaLabel && element.getAttribute("aria-label") === saved.text) {
      element.removeAttribute("aria-label");
    }
  }, []);

  const restoreInactiveTitle = useCallback((element: HTMLElement) => {
    if (hoveredRef.current === element || focusedRef.current === element) return;
    restoreNativeTitle(element);
  }, [restoreNativeTitle]);

  const restoreAllNativeTitles = useCallback(() => {
    for (const element of [...suppressedTitlesRef.current.keys()]) {
      restoreNativeTitle(element);
    }
  }, [restoreNativeTitle]);

  const showCurrent = useCallback(() => {
    if (pointerDownRef.current) {
      setActive(null);
      return;
    }
    const focused = focusedRef.current !== null && focusedRef.current !== hiddenFocusedRef.current;
    const element = focused ? focusedRef.current
      : hoverReadyRef.current && hoveredRef.current !== hiddenHoveredRef.current ? hoveredRef.current : null;
    const text = element
      ? tooltipText(element, suppressedTitlesRef.current, focused)
      : "";
    if (
      !element || !text || !element.isConnected || element.hasAttribute("data-tip-disabled")
      || (element.hasAttribute("aria-haspopup") && element.getAttribute("aria-expanded") === "true")
    ) {
      setActive(null);
      return;
    }
    const pointerY = !focused && element.dataset.tipPlacement === "pointer-side" ? pointerYRef.current : null;
    setActive((current) => {
      if (current?.element === element && current.text === text && current.pointerY === pointerY) return current;
      // Pointer movement updates position without replaying the entrance animation.
      if (current?.element === element) return { ...current, text, pointerY };
      const next = { element, text, pointerY, key: nextKeyRef.current };
      nextKeyRef.current += 1;
      return next;
    });
  }, []);

  const hideCurrent = useCallback(() => {
    cancelPointerTimer();
    // Dismissing one control must not let a later hover resurrect its old
    // keyboard hint. Each input source resumes on a fresh enter/focus event.
    hiddenFocusedRef.current = focusedRef.current;
    hiddenHoveredRef.current = hoveredRef.current;
    setActive(null);
  }, [cancelPointerTimer]);

  const dismiss = useCallback(() => {
    cancelPointerTimer();
    hoveredRef.current = null;
    focusedRef.current = null;
    hoverReadyRef.current = false;
    pointerYRef.current = null;
    pointerDownRef.current = false;
    hiddenFocusedRef.current = null;
    hiddenHoveredRef.current = null;
    restoreAllNativeTitles();
    setActive(null);
  }, [cancelPointerTimer, restoreAllNativeTitles]);

  // A dialog can appear programmatically (for example an automatic update),
  // without a pointer or keyboard activation that would normally dismiss the
  // hint. Never let a stale page tooltip float above a newly opened scrim.
  useEffect(() => {
    if (modalOpen) dismiss();
  }, [dismiss, modalOpen]);

  useEffect(() => {
    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const target = tooltipTarget(event.target, suppressedTitlesRef.current);
      if (!target || target === hoveredRef.current) return;
      suppressNativeTitle(target);
      hoveredRef.current = target;
      pointerYRef.current = event.clientY;
      hoverReadyRef.current = false;
      hiddenHoveredRef.current = pointerDownRef.current ? target : null;
      cancelPointerTimer();
      // A short dwell prevents hints from flashing while the pointer merely
      // crosses a toolbar. Keyboard focus remains immediate below.
      pointerTimerRef.current = window.setTimeout(() => {
        pointerTimerRef.current = null;
        hoverReadyRef.current = true;
        showCurrent();
      }, POINTER_SHOW_DELAY_MS);
    };
    const onPointerOut = (event: PointerEvent) => {
      const target = hoveredRef.current;
      if (!target || !(event.target instanceof Node) || !target.contains(event.target)) return;
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
      hoveredRef.current = null;
      hoverReadyRef.current = false;
      pointerYRef.current = null;
      cancelPointerTimer();
      restoreInactiveTitle(target);
      showCurrent();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch" || !(event.target instanceof Node) || !hoveredRef.current?.contains(event.target)) return;
      pointerYRef.current = event.clientY;
      if (hoveredRef.current.dataset.tipPlacement === "pointer-side" && hoverReadyRef.current) showCurrent();
    };
    const onPointerDown = () => {
      // A pointer gesture can focus its trigger before React starts a drag.
      // Suppress that focus hint as well as any previous control's tooltip.
      pointerDownRef.current = true;
      hideCurrent();
    };
    const onPointerEnd = () => { pointerDownRef.current = false; };
    const onFocusIn = (event: FocusEvent) => {
      const target = tooltipTarget(event.target, suppressedTitlesRef.current);
      if (!target) return;
      // Some menus move focus to an option as they open. Let those menus opt
      // out of focus hints without disabling their delayed hover hints.
      if (target.closest("[data-global-tooltip-skip-focus]")) return;
      suppressNativeTitle(target);
      focusedRef.current = target;
      hiddenFocusedRef.current = pointerDownRef.current ? target : null;
      showCurrent();
    };
    const onFocusOut = (event: FocusEvent) => {
      const target = focusedRef.current;
      if (!target || !(event.target instanceof Node) || !target.contains(event.target)) return;
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
      focusedRef.current = null;
      restoreInactiveTitle(target);
      showCurrent();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Keyboard activation can open a menu without producing a click (for
      // example ArrowDown on a menu button). Clear the hint before the newly
      // opened surface is painted so the higher tooltip layer cannot cover it.
      if (["Escape", "Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
        hideCurrent();
      }
    };

    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    // Opening an action or popover should dismiss its hint immediately.
    document.addEventListener("click", hideCurrent, true);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("click", hideCurrent, true);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", dismiss);
      cancelPointerTimer();
      hoveredRef.current = null;
      focusedRef.current = null;
      hoverReadyRef.current = false;
      pointerYRef.current = null;
      pointerDownRef.current = false;
      hiddenFocusedRef.current = null;
      hiddenHoveredRef.current = null;
      restoreAllNativeTitles();
    };
  }, [
    cancelPointerTimer,
    dismiss,
    hideCurrent,
    restoreAllNativeTitles,
    restoreInactiveTitle,
    showCurrent,
    suppressNativeTitle,
  ]);

  // React can update a dynamic title/data-tip while the pointer stays still,
  // and programmatic navigation can remove a trigger without pointerout.
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver((records) => {
      const candidates = [focusedRef.current, hoveredRef.current].filter(
        (element): element is HTMLElement => Boolean(element),
      );
      if (candidates.some((element) => !element.isConnected)) {
        dismiss();
        return;
      }
      const candidateSet = new Set(candidates);
      const tooltipTextChanged = records.some((record) => {
        if (record.type !== "attributes" || !(record.target instanceof HTMLElement)) return false;
        if (!candidateSet.has(record.target)) return false;
        if (record.attributeName === "data-tip" || record.attributeName === "data-tip-focus") return true;
        // A present title was added or changed by React. An absent title with
        // our marker is merely the mutation caused by suppressNativeTitle.
        return record.attributeName === "title" && record.target.hasAttribute("title");
      });
      for (const element of candidates) suppressNativeTitle(element);
      if (records.some((record) => (
        record.type === "attributes"
        && record.target instanceof HTMLElement
        && candidateSet.has(record.target)
        && ((record.attributeName === "aria-expanded" && record.target.getAttribute("aria-expanded") === "true")
          || (record.attributeName === "data-tip-disabled" && record.target.hasAttribute("data-tip-disabled")))
      ))) {
        hideCurrent();
        return;
      }
      // Suppressing a native title mutates the DOM. Do not let that observer
      // notification bypass the pointer dwell timer.
      if (tooltipTextChanged && (focusedRef.current || pointerTimerRef.current === null)) showCurrent();
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-tip", "data-tip-focus", "title", "aria-expanded", "data-tip-disabled"],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [dismiss, hideCurrent, showCurrent, suppressNativeTitle]);

  return active ? (
    <TooltipBubble key={active.key} anchor={active.element} text={active.text} pointerY={active.pointerY} />
  ) : null;
}

function TooltipBubble({ anchor, text, pointerY }: { anchor: HTMLElement; text: string; pointerY: number | null }) {
  const tooltipId = useId();
  const anchorRef = useRef<HTMLElement>(anchor);

  useEffect(() => {
    const labelledByText = (anchor.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .trim();
    const accessibleName = anchor.getAttribute("aria-label")?.trim()
      || labelledByText
      || anchor.textContent?.trim()
      || "";
    // Repeating an icon button's accessible name as its description makes
    // screen readers announce phrases such as "新建任务，新建任务".
    if (normalizedAccessibleText(accessibleName) === normalizedAccessibleText(text)) return;

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
  }, [anchor, text, tooltipId]);

  return anchor.dataset.tipPlacement === "pointer-side"
    ? <PointerSideHint anchorRef={anchorRef} pointerY={pointerY} text={text} id={tooltipId} />
    : <AnchoredTooltip anchorRef={anchorRef} text={text} id={tooltipId} />;
}

function AnchoredTooltip({ anchorRef, text, id }: { anchorRef: React.RefObject<HTMLElement>; text: string; id: string }) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const { style, placement } = useAnchoredFloating(anchorRef, tooltipRef, true, {
    preferredPlacement: "bottom", align: "center", width: "content", estimatedHeight: 30,
    offset: 6, zIndex: "var(--echo-layer-tooltip)",
  });
  return createPortal(
    <div
      ref={tooltipRef}
      id={id}
      className={`global-tooltip${anchorRef.current?.closest('[aria-modal="true"]') ? " global-tooltip--dialog" : ""}`}
      role="tooltip"
      data-placement={placement ?? undefined}
      style={style}
    >
      {text}
    </div>,
    document.body,
  );
}
