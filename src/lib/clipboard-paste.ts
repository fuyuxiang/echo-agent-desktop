/**
 * 把 `ClipboardEvent.clipboardData.items` 过滤成「可作为附件的文件」列表,
 * 供 Composer 的 onPaste 处理器调用。纯函数,便于单测。
 *
 * 为什么不直接用 DOM 事件类型:`DataTransferItemList` 在 jsdom 里没有类型
 * 描述,且 `getAsFile()` 返回的 `File` 与 `Blob` 之间在跨平台差异比较大,
 * 这里使用 duck-typing:只要求 `kind`、`type` 和 `getAsFile()` 三个成员。
 *
 * 设计变化 (2026-09):从 `extractImageFilesFromClipboard` 扩展为多类型。
 * 之前只接 5 种图片,其它文件被 `filter` 静默丢弃,用户毫无反馈。
 * 现在按 [`classifyAttachment`] 的白名单过滤 —— 图片 + 文档 + 代码 +
 * 文本 + 数据;不在白名单内的项目(可执行二进制、压缩包、音视频等)
 * 返回 `Unsupported` 标记,Composer 据此给用户 toast 提示。
 */

import { AttachmentKind, classifyAttachment } from "./user-message";

export interface PastedFileItem {
  /** The underlying `Blob` (file bytes). */
  blob: Blob;
  /** The mime string reported by the DataTransferItem (e.g. `image/png`). */
  mime: string;
  /** Best-effort filename for the saved blob. */
  suggestedName: string;
  /** 分类结果 —— 不可接受时 Composer 必须 toast。 */
  kind: AttachmentKind;
}

/** @deprecated 保留旧名以避免一次性破坏调用点;语义已扩展到多类型。 */
export type PastedImageItem = PastedFileItem;

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
 * 给定一个文件名(可能带路径)+ MIME,推断最合适的 fallback 名称。
 * DataTransferItem 的 `getAsFile()` 在某些平台返回纯 Blob 没有 `.name`,
 * 此时我们用 mime 的扩展名 + 一个时间戳后缀兜底,避免两个 paste 撞名。
 */
function inferFallbackName(mime: string, takenNames: Set<string>): string {
  const map: Record<string, string> = {
    "image/png": "image.png",
    "image/jpeg": "image.jpg",
    "image/jpg": "image.jpg",
    "image/gif": "image.gif",
    "image/webp": "image.webp",
    "application/pdf": "document.pdf",
    "text/plain": "document.txt",
    "text/markdown": "document.md",
    "text/x-typescript": "code.ts",
    "application/json": "data.json",
    "text/yaml": "data.yaml",
    "text/x-yaml": "data.yaml",
  };
  const base = map[mime.toLowerCase()] || "file";
  if (!takenNames.has(base)) {
    takenNames.add(base);
    return base;
  }
  let i = 2;
  while (takenNames.has(`${i}-${base}`)) i++;
  const unique = `${i}-${base}`;
  takenNames.add(unique);
  return unique;
}

/**
 * 从一次剪贴板 items 列表中过滤出可作为附件的文件。
 *
 * 返回**所有** item + 分类标记,这样调用方既可以拿到接受的(用 blob 落盘),
 * 也可以拿到拒绝的(用于 toast "跳过 N 个")。保持原始顺序,不去重
 * (用户可能真的复制粘贴了两张一模一样的截图)。
 */
export function extractFilesFromClipboard(
  items: ArrayLike<DataTransferItemLike> | null | undefined,
): PastedFileItem[] {
  if (!items || items.length === 0) return [];
  const out: PastedFileItem[] = [];
  const takenNames = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item) continue;
    if (item.kind !== "file") continue;
    const blob = item.getAsFile();
    if (!blob) continue;
    const mime = item.type || "";
    const rawName = (blob as File).name ?? "";
    const suggestedName =
      rawName && rawName.trim().length > 0 ? rawName : inferFallbackName(mime, takenNames);
    const kind = classifyAttachment(suggestedName);
    out.push({ blob, mime, suggestedName, kind });
  }
  return out;
}

/** @deprecated 改名以避免一次性破坏调用点;新代码请用 [`extractFilesFromClipboard`]。 */
export function extractImageFilesFromClipboard(
  items: ArrayLike<DataTransferItemLike> | null | undefined,
): PastedFileItem[] {
  // 历史契约:只过滤图片。新契约改为返回全部 + 分类,调用方按 kind 决定。
  return extractFilesFromClipboard(items).filter((item) => item.kind === AttachmentKind.Image);
}

/** 把 Blob 转成可直接通过 Tauri 命令发送的 `Uint8Array`。 */
export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  const buffer = await blob.arrayBuffer();
  return new Uint8Array(buffer);
}
