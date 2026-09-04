import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

// Dialogs can be nested (for example Settings -> model editor, or project
// editor -> reference picker). Only the top-most mounted dialog may consume
// keyboard input; otherwise one Escape could close multiple layers and the
// outer trap could move focus behind the active inner dialog.
const modalStack: HTMLElement[] = [];

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Keeps keyboard focus inside an open modal and restores it to the invoking
 * control when the modal closes. `onEscape` is intentionally supplied by the
 * caller because security prompts may need Escape to mean an explicit deny.
 */
export function useModalFocus<T extends HTMLElement>(
  open: boolean,
  onEscape: () => void,
): RefObject<T> {
  const containerRef = useRef<T>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!open) return;

    const container = containerRef.current;
    if (!container) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    modalStack.push(container);
    const initialItems = focusableElements(container);
    const preferred = container.querySelector<HTMLElement>("[data-modal-initial-focus]");
    const initialTarget = preferred && initialItems.includes(preferred)
      ? preferred
      : initialItems[0] ?? container;
    initialTarget.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (modalStack[modalStack.length - 1] !== container) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const items = focusableElements(container);
      if (items.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === firstItem || !container.contains(active))) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && (active === lastItem || !container.contains(active))) {
        event.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const stackIndex = modalStack.lastIndexOf(container);
      if (stackIndex >= 0) modalStack.splice(stackIndex, 1);
      const returnTarget = returnFocusRef.current;
      if (returnTarget?.isConnected) returnTarget.focus();
    };
  }, [open]);

  return containerRef;
}
