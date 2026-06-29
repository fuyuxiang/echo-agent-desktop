export interface HealthDeps {
  fetchFn: (url: string) => Promise<{ ok: boolean }>
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function waitHealthy(
  baseUrl: string,
  opts: { timeoutMs: number; intervalMs: number; now?: () => number } & HealthDeps
): Promise<boolean> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? defaultSleep
  const start = now()
  const url = `${baseUrl}/api/health`
  while (now() - start < opts.timeoutMs) {
    try {
      const res = await opts.fetchFn(url)
      if (res.ok) return true
    } catch {
      // not ready yet; keep polling
    }
    await sleep(opts.intervalMs)
  }
  return false
}
