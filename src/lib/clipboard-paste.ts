/**
 * 把 `ClipboardEvent.clipboardData.items` 过滤成「图片文件」列表,
 * 供 Composer 的 onPaste 处理器调用。纯函数,便于单测。
 *
 * 为什么不直接用 DOM 事件类型:`DataTransferItemList` 在 jsdom 里没有类型
 * 描述,且 `getAsFile()` 返回的 `File` 与 `Blob` 之间在跨平台差异比较大,
 * 这里使用 duck-typing:只要求 `kind`、`type` 和 `getAsFile()` 三个成员。
 */

export interface PastedImageItem {
  /** The underlying `Blob` (image bytes). */
  blob: Blob;
  /** The mime string reported by the DataTransferItem (e.g. `image/png`). */
  mime: string;
  /** Best-effort filename for the saved blob (falls back to `image`). */
  suggestedName: string;
}

export interface DataTransferItemLike {
  kind: string;
  type: string;
  getAsFile(): File | Blob | null;
}

/** 判定 MIME 是否为图片(忽略 `image/svg+xml`,它无法被多模态管线消费)。 */
const SUPPORTED_IMAGE_MIME_PREFIXES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
];

export function isLikelyImageMime(mime: string): boolean {
  if (!mime) return false;
  const lower = mime.toLowerCase();
  return SUPPORTED_IMAGE_MIME_PREFIXES.includes(lower);
}

/**
 * 从一次剪贴板 items 列表中过滤出图片文件。保持原始顺序,不去重
 * (用户可能真的复制粘贴了两张一模一样的截图)。
 */
export function extractImageFilesFromClipboard(
  items: ArrayLike<DataTransferItemLike> | null | undefined,
): PastedImageItem[] {
  if (!items || items.length === 0) return [];
  const out: PastedImageItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    if (item.kind !== "file") continue;
    const mime = item.type || "";
    if (!isLikelyImageMime(mime)) continue;
    const blob = item.getAsFile();
    if (!blob) continue;
    const rawName = (blob as File).name ?? "";
    const suggestedName = rawName && rawName.trim().length > 0 ? rawName : "image";
    out.push({ blob, mime, suggestedName });
  }
  return out;
}

/** 把 Blob 转成可直接通过 Tauri 命令发送的 `Uint8Array`。 */
export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}
