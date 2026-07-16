import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer/src'),
      '@shared': path.resolve(__dirname, 'src/shared'),
      // better-sqlite3 在 postinstall 中被 electron-builder 重编译为 Electron ABI,
      // 与 Vitest 使用的 Node.js ABI 不兼容;此处指向一份为 Node.js 单独编译的副本
      'better-sqlite3': path.resolve(__dirname, 'tests/native-deps/node_modules/better-sqlite3')
    }
  },
  test: { environment: 'node' }
})
