import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ImgHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "@/lib/use-modal-focus";

type ImageSize = { width: number; height: number };

type PreviewableImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> & {
  src: string;
  alt?: string;
  previewTitle?: string;
  previewLabel?: string;
  intrinsicSize?: ImageSize;
  onPreview?: () => void;
  previewOpen?: boolean;
  onPreviewOpenChange?: (open: boolean) => void;
};

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 4;

function ImagePreviewDialog({
  src,
  title,
  intrinsicSize,
  onClose,
}: {
  src: string;
  title: string;
  intrinsicSize?: ImageSize;
  onClose: () => void;
}) {
  const dialogRef = useModalFocus<HTMLDivElement>(true, onClose);
  const stageRef = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState<ImageSize>({ width: 0, height: 0 });
  const [loadedSize, setLoadedSize] = useState<ImageSize | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      observer.observe(stage);
      return () => observer.disconnect();
    }
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const imageSize = intrinsicSize ?? loadedSize;
  const fitScale = imageSize && stageSize.width > 0 && stageSize.height > 0
    ? Math.min(
      1,
      Math.max(1, stageSize.width - 48) / imageSize.width,
      Math.max(1, stageSize.height - 48) / imageSize.height,
    )
    : null;
  const scale = zoom ?? fitScale;
  const imageStyle: CSSProperties = imageSize && scale !== null
    ? { width: imageSize.width * scale, height: imageSize.height * scale }
    : { maxWidth: "100%", maxHeight: "100%" };

  const changeZoom = (factor: number) => {
    setZoom((current) => {
      const next = (current ?? fitScale ?? 1) * factor;
      return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(next * 1000) / 1000));
    });
  };

  return createPortal(
    <div
      className="md-image-preview__overlay"
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="md-image-preview__dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="md-image-preview__toolbar">
          <span className="md-image-preview__title" title={title}>{title}</span>
          <div className="md-image-preview__actions">
            <button type="button" onClick={() => changeZoom(0.8)} disabled={scale !== null && scale <= MIN_ZOOM} aria-label="缩小图片">−</button>
            <span className="md-image-preview__scale" aria-live="polite">{scale === null ? "适应窗口" : `${Math.round(scale * 100)}%`}</span>
            <button type="button" onClick={() => changeZoom(1.25)} disabled={scale !== null && scale >= MAX_ZOOM} aria-label="放大图片">+</button>
            <button type="button" onClick={() => setZoom(null)} aria-pressed={zoom === null}>适应窗口</button>
            <button type="button" onClick={() => setZoom(1)} aria-pressed={zoom === 1}>原始大小</button>
            <button type="button" className="md-image-preview__close" onClick={onClose} aria-label="关闭图片预览">✕</button>
          </div>
        </div>
        <div ref={stageRef} className="md-image-preview__stage">
          <div className="md-image-preview__canvas">
            {loadError ? (
              <div className="md-image-preview__error" role="alert">图片无法加载，资源可能已失效。</div>
            ) : (
              <img
                src={src}
                alt={title}
                style={imageStyle}
                onError={() => setLoadError(true)}
                onLoad={(event) => {
                  if (intrinsicSize) return;
                  const image = event.currentTarget;
                  if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                    setLoadedSize({ width: image.naturalWidth, height: image.naturalHeight });
                  }
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function MarkdownPreviewImage({
  src,
  alt,
  previewTitle,
  previewLabel,
  intrinsicSize,
  onPreview,
  previewOpen,
  onPreviewOpenChange,
  className,
  onClick,
  onKeyDown,
  ...imgProps
}: PreviewableImageProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = previewOpen ?? internalOpen;
  const setOpen = (next: boolean) => {
    if (previewOpen === undefined) setInternalOpen(next);
    onPreviewOpenChange?.(next);
  };
  const title = previewTitle ?? (alt?.trim() ? `图片预览：${alt.trim()}` : "图片预览");
  const label = previewLabel ?? (alt?.trim() ? `放大预览：${alt.trim()}` : "放大预览图片");
  const openPreview = () => {
    if (onPreview) onPreview();
    else setOpen(true);
  };
  const handleClick = (event: MouseEvent<HTMLImageElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    onClick?.(event);
    openPreview();
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLImageElement>) => {
    onKeyDown?.(event);
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    openPreview();
  };

  return (
    <>
      <img
        {...imgProps}
        src={src}
        alt={alt}
        className={`md-previewable-image${className ? ` ${className}` : ""}`}
        role="button"
        tabIndex={0}
        aria-haspopup="dialog"
        aria-label={label}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
      />
      {open && <ImagePreviewDialog src={src} title={title} intrinsicSize={intrinsicSize} onClose={() => setOpen(false)} />}
    </>
  );
}
