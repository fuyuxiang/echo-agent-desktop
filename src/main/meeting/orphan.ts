/** 返回处于 recording 状态(上次未正常结束)的会议 id */
export function reapOrphans(meetings: { id: string; status: string }[]): string[] {
  return meetings.filter((m) => m.status === 'recording').map((m) => m.id)
}
