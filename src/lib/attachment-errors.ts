/**
 * 把后端抛出的"打开附件"原始错误翻译成简短中文 toast。
 *
 * 为什么单独写一份而不是复用 `friendlyError`:
 *  - 后端 `is_authorized` / `open_path` 系列错误都是 "拒绝访问未授权的
 *    路径：C:\Users\...\image.png-..." 这种冗长、带完整绝对路径的中文
 *    文案。直接 toast 给用户既不可操作、又会泄露内部目录布局。
 *  - 附件操作的用户感知只有两类: 文件不存在 / 权限受限 / 其它 IO 问题。
 *    没必要把后端的字符串一比一回显到 UI。
 */

import { attachmentBasename } from "./user-message";

/** 后端错误里"文件不存在"分支的关键词。 */
const MISSING_KEYWORDS = [
  "路径不存在",
  "不是文件",
  "No such file",
  "os error 2",
  "系统找不到",
];

/** 后端错误里"权限/授权"分支的关键词。 */
const UNAUTHORIZED_KEYWORDS = [
  "未授权",
  "符号链接",
  "不在当前会话工作区",
  "沙箱",
  "拒绝读取",
  "拒绝访问",
];

function classify(message: string): "missing" | "unauthorized" | "unknown" {
  const lower = message.toLowerCase();
  if (MISSING_KEYWORDS.some((keyword) => message.includes(keyword))) {
    return "missing";
  }
  if (UNAUTHORIZED_KEYWORDS.some((keyword) => message.includes(keyword))
    || lower.includes("permission")
    || lower.includes("eacces")
    || lower.includes("access is denied")) {
    return "unauthorized";
  }
  return "unknown";
}

/**
 * 把后端错误翻译成简短中文提示。始终展示附件的文件名（不暴露完整
 * 绝对路径），让用户能确认是哪一条附件出错。
 *
 *  - 文件不存在: "附件《xxx》已不存在，可能被移动或清理"
 *  - 权限受限:   "附件《xxx》预览受限，请重新发送或重新选择该附件"
 *  - 其它 IO:    "附件《xxx》打开失败：<简短原因>"
 */
export function friendlyAttachmentError(rawError: unknown, path: string): string {
  const raw = String(rawError ?? "").replace(/^Error:\s*/, "").trim();
  const name = attachmentBasename(path || "").trim();

  const kind = raw ? classify(raw) : "unknown";
  const label = name || "附件";

  if (kind === "missing") {
    return `附件《${label}》已不存在，可能被移动或清理`;
  }
  if (kind === "unauthorized") {
    return `附件《${label}》预览受限，请重新发送或在会话中重新添加该附件`;
  }

  // 未知错误: 不暴露原始绝对路径，但保留一句简短原因让用户能区分 IO / 其它。
  // 先把字符串中夹杂的任意绝对路径段压缩成 "…/<basename>"，再剥前缀。
  const trimmedReason = raw
    // Windows: `C:\Users\test\secret.png` → `…\secret.png`
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\\/]+){2,}[\\/]([^\\/]+)/g, "…\\$1")
    // POSIX: `/var/folders/abc/secret.png` → `…/secret.png`
    .replace(/\/(?:[^/]+\/){2,}([^/]+)/g, "…/$1")
    .replace(/^Error:\s*/, "")
    .trim();
  const reason = trimmedReason.length > 80
    ? `${trimmedReason.slice(0, 80)}…`
    : trimmedReason;
  if (!reason) {
    return `附件《${label}》打开失败`;
  }
  return `附件《${label}》打开失败：${reason}`;
}