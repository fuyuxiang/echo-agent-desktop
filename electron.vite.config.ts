import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import svgr from 'vite-plugin-svgr'

/**
 * electron-vite 构建配置
 * - main / preload: 外部化 package.json dependencies(原生模块如 better-sqlite3 不打包)
 * - renderer: React + SVGR(SVG 直接当组件用) + SCSS 全局变量注入
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    plugins: [
      react(),
      // import Icon from './icon.svg?react' 即可作为 React 组件使用
      svgr()
    ],
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    css: {
      preprocessorOptions: {
        scss: {
          // 所有 scss 文件自动注入设计变量与 mixin,业务样式无需手动 @use
          additionalData: `@use "@/styles/variables.scss" as *;\n@use "@/styles/mixins.scss" as *;\n`
        }
      }
    }
  }
})
