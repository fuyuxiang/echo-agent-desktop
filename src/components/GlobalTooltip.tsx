import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredFloating } from "@/lib/use-anchored-floating";
import { useModalPresence } from "@/lib/use-modal-focus";

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
  /** Remount the positioned bubble when the anchor changes. */
  key: number;
}

function normalizedAccessibleText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function tooltipText(
  element: HTMLElement,
  suppressedTitles: Map<HTMLElement, SuppressedNativeTitle>,
): string {
  return element.dataset.tip?.trim()
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
  const interactionHiddenRef = useRef(false);
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
    if (interactionHiddenRef.current) {
      setActive(null);
      return;
    }
    const element = focusedRef.current ?? hoveredRef.current;
    const text = element
      ? tooltipText(element, suppressedTitlesRef.current)
      : "";
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

  const hideCurrent = useCallback(() => {
    cancelPointerTimer();
    interactionHiddenRef.current = true;
    setActive(null);
  }, [cancelPointerTimer]);

  const dismiss = useCallback(() => {
    cancelPointerTimer();
    hoveredRef.current = null;
    focusedRef.current = null;
    interactionHiddenRef.current = false;
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
      interactionHiddenRef.current = false;
      cancelPointerTimer();
      // A short dwell prevents hints from flashing while the pointer merely
      // crosses a toolbar. Keyboard focus remains immediate below.
      pointerTimerRef.current = window.setTimeout(() => {
        pointerTimerRef.current = null;
        showCurrent();
      }, POINTER_SHOW_DELAY_MS);
    };
    const onPointerOut = (event: PointerEvent) => {
      const target = tooltipTarget(event.target, suppressedTitlesRef.current);
      if (!target || target !== hoveredRef.current) return;
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
      hoveredRef.current = null;
      cancelPointerTimer();
      restoreInactiveTitle(target);
      showCurrent();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = tooltipTarget(event.target, suppressedTitlesRef.current);
      if (!target) return;
      suppressNativeTitle(target);
      focusedRef.current = target;
      interactionHiddenRef.current = false;
      cancelPointerTimer();
      showCurrent();
    };
    const onFocusOut = (event: FocusEvent) => {
      const target = tooltipTarget(event.target, suppressedTitlesRef.current);
      if (!target || target !== focusedRef.current) return;
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
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    // Opening an action or popover should dismiss its hint immediately.
    document.addEventListener("click", hideCurrent);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", dismiss);
    return () => {
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("click", hideCurrent);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", dismiss);
      cancelPointerTimer();
      hoveredRef.current = null;
      focusedRef.current = null;
      interactionHiddenRef.current = false;
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
        if (record.attributeName === "data-tip") return true;
        // A present title was added or changed by React. An absent title with
        // our marker is merely the mutation caused by suppressNativeTitle.
        return record.attributeName === "title" && record.target.hasAttribute("title");
      });
      for (const element of candidates) suppressNativeTitle(element);
      // Suppressing a native title mutates the DOM. Do not let that observer
      // notification bypass the pointer dwell timer.
      if (tooltipTextChanged && pointerTimerRef.current === null) showCurrent();
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-tip", "title"],
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [dismiss, showCurrent, suppressNativeTitle]);

  return active ? (
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
  }, [anchor, tooltipId]);

  return createPortal(
    <div
      ref={tooltipRef}
      id={tooltipId}
      className={`global-tooltip${anchor.closest('[aria-modal="true"]') ? " global-tooltip--dialog" : ""}`}
      role="tooltip"
      data-placement={placement ?? undefined}
      style={style}
    >
      {text}
    </div>,
    document.body,
  );
}
