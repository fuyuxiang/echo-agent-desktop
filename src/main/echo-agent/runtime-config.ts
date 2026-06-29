import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex')
}

export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr && typeof addr === 'object') {
        const { port } = addr
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('failed to acquire port')))
      }
    })
  })
}
