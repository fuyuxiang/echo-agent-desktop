/** Keep the persisted key stable so existing task drafts survive the Theia migration. */
export function codingTaskDraftKey(root: string): string {
  return `echo-coding-hot-exit-v1:task-draft:${encodeURIComponent(root)}`;
}
