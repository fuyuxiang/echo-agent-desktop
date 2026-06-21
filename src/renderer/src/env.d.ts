/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

/** Vite 环境变量类型(新增 .env 字段时在此同步声明) */
interface ImportMetaEnv {
  /** 是否启用 Mock 数据('true' / 'false') */
  readonly VITE_USE_MOCK: string
  /** 后台 API host */
  readonly VITE_API_BASE_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** CSS Modules 类型声明 */
declare module '*.module.scss' {
  const classes: { readonly [key: string]: string }
  export default classes
}
