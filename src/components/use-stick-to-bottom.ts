import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";

/**
 * Keep the transcript pinned while the user is following the latest output.
 * A small tolerance avoids disabling follow mode because of sub-pixel layout
 * and native scroll rounding.
 */
export const STICK_TO_BOTTOM_THRESHOLD = 80;

export function isNearScrollBottom(
  element: HTMLElement,
  threshold = STICK_TO_BOTTOM_THRESHOLD,
): boolean {
  const remaining =
    element.scrollHeight - element.clientHeight - element.scrollTop;
  return remaining <= threshold;
}

interface UseStickToBottomOptions {
  /** A value that changes whenever rendered transcript data changes. */
  contentVersion: unknown;
  /** Starting a new response always returns the view to the latest output. */
  streaming: boolean;
  /** Switching conversations must not inherit the old conversation's position. */
  sessionId: string | null;
  threshold?: number;
}

interface StickToBottomRefs {
  scrollRef: RefObject<HTMLDivElement>;
  contentRef: RefObject<HTMLDivElement>;
}

/**
 * Bottom-following for a streaming transcript.
 *
 * Message state alone is not a sufficient signal: Markdown renderers, images,
 * tool cards and the composer can all change size after React has committed.
 * ResizeObserver covers those late layout changes, while followRef preserves a
 * user's deliberate position when they scroll up to read earlier messages.
 */
export function useStickToBottom({
  contentVersion,
  streaming,
  sessionId,
  threshold = STICK_TO_BOTTOM_THRESHOLD,
}: UseStickToBottomOptions): StickToBottomRefs {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const frameRef = useRef<number | null>(null);
  const previousSessionRef = useRef(sessionId);
  const previousStreamingRef = useRef(streaming);

  const cancelScheduledAlignment = useCallback(() => {
    if (frameRef.current === null) return;
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const alignToBottom = useCallback(
    (force = false) => {
      if (force) followRef.current = true;
      if (!followRef.current) return;

      const element = scrollRef.current;
      if (!element) return;

      // Align during the current layout pass, then once more on the next frame
      // for renderers that finish measuring just after React's commit.
      element.scrollTop = Math.max(
        0,
        element.scrollHeight - element.clientHeight,
      );
      cancelScheduledAlignment();
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        if (!followRef.current || scrollRef.current !== element) return;
        element.scrollTop = Math.max(
          0,
          element.scrollHeight - element.clientHeight,
        );
      });
    },
    [cancelScheduledAlignment],
  );

  // Run before paint so each streamed state update does not visibly flash at
  // the old position. A new session/turn explicitly resumes bottom following.
  useLayoutEffect(() => {
    const sessionChanged = previousSessionRef.current !== sessionId;
    const streamingStarted = !previousStreamingRef.current && streaming;
    previousSessionRef.current = sessionId;
    previousStreamingRef.current = streaming;

    alignToBottom(sessionChanged || streamingStarted);
  }, [alignToBottom, contentVersion, sessionId, streaming]);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    const contentElement = contentRef.current;
    if (!scrollElement || !contentElement) return;

    const handleScroll = () => {
      followRef.current = isNearScrollBottom(scrollElement, threshold);
    };
    const handleLateLayout = () => alignToBottom();

    scrollElement.addEventListener("scroll", handleScroll, { passive: true });

    // The content observer catches asynchronously expanding Markdown, images,
    // and tool cards. Observing the viewport catches footer/composer resizing.
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(handleLateLayout);
    resizeObserver?.observe(scrollElement);
    resizeObserver?.observe(contentElement);

    // Also cover image load in older WebViews where ResizeObserver is absent.
    contentElement.addEventListener("load", handleLateLayout, true);

    return () => {
      scrollElement.removeEventListener("scroll", handleScroll);
      contentElement.removeEventListener("load", handleLateLayout, true);
      resizeObserver?.disconnect();
    };
  }, [alignToBottom, sessionId, threshold]);

  useEffect(() => cancelScheduledAlignment, [cancelScheduledAlignment]);

  return { scrollRef, contentRef };
}
