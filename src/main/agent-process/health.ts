import http from 'http'

/**
 * 轮询 Agent health check 直到就绪或超时
 */
export function waitForHealth(
  port: number,
  timeoutMs: number,
  intervalMs: number
): Promise<boolean> {
  const start = Date.now()

  return new Promise((resolve) => {
    const check = (): void => {
      if (Date.now() - start > timeoutMs) {
        resolve(false)
        return
      }

      const req = http.get(`http://127.0.0.1:${port}/api/v1/health`, (res) => {
        let body = ''
        res.on('data', (d) => {
          body += d
        })
        res.on('end', () => {
          try {
            const data = JSON.parse(body)
            if (data.status === 'healthy' || data.status === 'degraded') {
              resolve(true)
            } else {
              setTimeout(check, intervalMs)
            }
          } catch {
            setTimeout(check, intervalMs)
          }
        })
      })

      req.on('error', () => {
        setTimeout(check, intervalMs)
      })

      req.setTimeout(3000, () => {
        req.destroy()
        setTimeout(check, intervalMs)
      })
    }

    check()
  })
}

/** 单次 health check（用于检测已有进程） */
export function checkHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/v1/health`, (res) => {
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(2000, () => {
      req.destroy()
      resolve(false)
    })
  })
}
