import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
} from "react";

/**
 * Keep the transcript pinned while the user is following the latest output.
 * This tolerance is only for native scroll rounding when the user returns to
 * the bottom. User intent is detected from scroll direction / input events,
 * never from this distance.
 */
export const STICK_TO_BOTTOM_THRESHOLD = 2;

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
  /** Whether the focused conversation currently has an active response. */
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
  const lastScrollTopRef = useRef(0);
  const touchYRef = useRef<number | null>(null);
  const previousSessionRef = useRef(sessionId);

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
      lastScrollTopRef.current = element.scrollTop;
      cancelScheduledAlignment();
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        if (!followRef.current || scrollRef.current !== element) return;
        element.scrollTop = Math.max(
          0,
          element.scrollHeight - element.clientHeight,
        );
        lastScrollTopRef.current = element.scrollTop;
      });
    },
    [cancelScheduledAlignment],
  );

  // Run before paint so each streamed state update does not visibly flash at
  // the old position. Only switching conversations forces the view to the
  // bottom: an automatically queued turn must not steal a reader's position.
  useLayoutEffect(() => {
    const sessionChanged = previousSessionRef.current !== sessionId;
    previousSessionRef.current = sessionId;

    alignToBottom(sessionChanged);
  }, [alignToBottom, contentVersion, sessionId, streaming]);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    const contentElement = contentRef.current;
    if (!scrollElement || !contentElement) return;

    lastScrollTopRef.current = scrollElement.scrollTop;

    const pauseFollowing = () => {
      followRef.current = false;
      cancelScheduledAlignment();
    };
    const handleScroll = () => {
      const nextScrollTop = scrollElement.scrollTop;
      // A decrease is an unambiguous attempt to inspect earlier content. Stop
      // following immediately, including for tiny scrollbar/trackpad moves.
      if (nextScrollTop < lastScrollTopRef.current - 0.5) {
        pauseFollowing();
      } else if (isNearScrollBottom(scrollElement, threshold)) {
        // Following resumes naturally only after the user reaches the bottom.
        followRef.current = true;
      }
      lastScrollTopRef.current = nextScrollTop;
    };
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && scrollElement.scrollTop > 0) pauseFollowing();
    };
    const handleTouchStart = (event: TouchEvent) => {
      touchYRef.current = event.touches[0]?.clientY ?? null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      const previousY = touchYRef.current;
      // Moving the finger down scrolls the transcript towards older content.
      if (
        nextY !== undefined
        && previousY !== null
        && nextY > previousY
        && scrollElement.scrollTop > 0
      ) {
        pauseFollowing();
      }
      touchYRef.current = nextY ?? null;
    };
    const handleTouchEnd = () => {
      touchYRef.current = null;
    };
    const handleLateLayout = () => alignToBottom();

    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    scrollElement.addEventListener("wheel", handleWheel, { passive: true });
    scrollElement.addEventListener("touchstart", handleTouchStart, {
      passive: true,
    });
    scrollElement.addEventListener("touchmove", handleTouchMove, { passive: true });
    scrollElement.addEventListener("touchend", handleTouchEnd, { passive: true });
    scrollElement.addEventListener("touchcancel", handleTouchEnd, { passive: true });

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
      scrollElement.removeEventListener("wheel", handleWheel);
      scrollElement.removeEventListener("touchstart", handleTouchStart);
      scrollElement.removeEventListener("touchmove", handleTouchMove);
      scrollElement.removeEventListener("touchend", handleTouchEnd);
      scrollElement.removeEventListener("touchcancel", handleTouchEnd);
      contentElement.removeEventListener("load", handleLateLayout, true);
      resizeObserver?.disconnect();
    };
  }, [alignToBottom, cancelScheduledAlignment, sessionId, threshold]);

  useEffect(() => cancelScheduledAlignment, [cancelScheduledAlignment]);

  return { scrollRef, contentRef };
}
