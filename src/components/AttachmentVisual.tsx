import { useEffect, useRef, useState } from "react";
import { FileText, Image as ImageIcon } from "lucide-react";
import { attachmentThumbnail } from "@/lib/agent-client";
import { isImageAttachment } from "@/lib/user-message";

const MAX_MEMORY_THUMBNAILS = 128;
/** Shared across message remounts/session switches so history replay does not
 * repeat native decoding. Concurrent rows for one file share the same invoke. */
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function remember(path: string, url: string): void {
  cache.delete(path);
  cache.set(path, url);
  while (cache.size > MAX_MEMORY_THUMBNAILS) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function load(path: string): Promise<string> {
  const cached = cache.get(path);
  if (cached) {
    // Refresh insertion order to approximate a small LRU.
    remember(path, cached);
    return Promise.resolve(cached);
  }
  let pending = inflight.get(path);
  if (!pending) {
    pending = attachmentThumbnail(path)
      .then((base64) => {
        const url = base64 ? `data:image/jpeg;base64,${base64}` : "";
        if (url) remember(path, url);
        return url;
      })
      .catch(() => "")
      .finally(() => inflight.delete(path));
    inflight.set(path, pending);
  }
  return pending;
}

/** Lazy thumbnail for supported chat images, with an icon fallback for missing
 * or unreadable local files. Non-image attachments retain the document icon. */
export function AttachmentVisual({ path }: { path: string }) {
  const image = isImageAttachment(path);
  const [src, setSrc] = useState(() => image ? cache.get(path) : undefined);
  const wrapperRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!image) {
      setSrc(undefined);
      return;
    }
    const cached = cache.get(path);
    if (cached) {
      remember(path, cached);
      setSrc(cached);
      return;
    }
    setSrc(undefined);
    let active = true;
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      void load(path).then((url) => {
        if (active && url) setSrc(url);
      });
    };
    const element = wrapperRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      start();
      return () => {
        active = false;
      };
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        start();
        observer.disconnect();
      }
    }, { rootMargin: "240px 0px" });
    observer.observe(element);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [image, path]);

  if (!image) {
    return (
      <span className="msg__attachment-icon" aria-hidden="true">
        <FileText size={20} strokeWidth={1.8} />
      </span>
    );
  }
  return (
    <span
      ref={wrapperRef}
      className="msg__attachment-icon msg__attachment-icon--image"
      aria-hidden="true"
    >
      {src ? (
        <img
          className="msg__attachment-thumbnail"
          src={src}
          alt=""
          draggable={false}
          onError={() => {
            cache.delete(path);
            setSrc(undefined);
          }}
        />
      ) : (
        <ImageIcon size={22} strokeWidth={1.7} />
      )}
    </span>
  );
}
