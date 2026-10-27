/** Runtime's boolean completion also includes empty/duplicate extraction.
 * Never promise newly saved content without an actual write receipt. */
export function memoryFlushMessage(completed: boolean): string {
  return completed
    ? "记忆提取已完成，可在记忆页面查看结果；没有新增内容时不会重复保存"
    : "本次提取未完成，请查看记忆处理状态后重试";
}

/** False can mean either no changes or a skipped consolidation (e.g. busy). */
export function memoryDreamMessage(changed: boolean): string {
  return changed
    ? "长期记忆已更新"
    : "本次未更新长期记忆，可在记忆页面查看处理状态";
}
