# 页面开发规范(依葫芦画瓢指南)

> 本文档是业务页面开发的唯一说明书。基建目录(`src/main`、`src/preload`、`utils`、`request`)**只调用、不修改**;日常开发只碰三个地方:`pages/`、`services/`、`mock/`。

## 一、新建页面三步走

### 第 1 步:生成四件套

```bash
npm run new:page
# 输入页面名(PascalCase),如 Settings
```

自动生成并注册:

| 文件                                  | 说明                     |
| ------------------------------------- | ------------------------ |
| `pages/Settings/index.tsx`            | 页面组件                 |
| `pages/Settings/settings.module.scss` | 页面样式(CSS Modules)    |
| `services/settings.ts`                | 接口定义(URL + 类型)     |
| `mock/settings.ts`                    | Mock 数据(已自动 import) |
| `constants/index.ts`                  | 路由常量自动追加         |
| `router/index.tsx`                    | 懒加载路由自动注册       |

### 第 2 步:照 Figma 写 UI

参照活模板 [`pages/Example`](../src/renderer/src/pages/Example/index.tsx),它演示了全部基建用法。

样式规则:

- 颜色一律用 CSS 变量:`var(--color-primary)`、`var(--color-text-1)`...(见 `styles/themes.scss`,自动支持深浅色)
- 间距/字号/圆角用 SCSS 变量:`$spacing-lg`、`$font-size-base`、`$radius-md`(见 `styles/variables.scss`,已自动注入,无需 import)
- 常用 mixin 直接 `@include`:`flex-center`、`ellipsis`、`thin-scrollbar`
- 文案不写死,进 `i18n/locales/zh-CN.json` + `en-US.json`,组件里 `t('xxx.yyy')`

### 第 3 步:定义接口 + Mock

```ts
// 1) request/urls.ts —— 添加路径常量
export const ApiUrls = {
  settings: {
    profile: '/api/settings/profile'
  }
}

// 2) services/settings.ts —— 类型 + 请求函数
export interface Profile {
  id: string
  nickname: string
}
export function fetchProfile(): Promise<Profile> {
  return request.get<Profile>(ApiUrls.settings.profile)
}

// 3) mock/settings.ts —— Mock 数据(后台就绪后此文件不用动)
registerMock('GET', ApiUrls.settings.profile, (): Profile => ({ id: '1', nickname: 'Echo' }))
```

说明:

- 响应统一为 `BaseData<T> = { code, msg, data }`,`code === 0` 成功
- 拦截器已自动解包,业务代码直接拿到 `data`;业务错误自动 toast,无需 try/catch(需要精细处理时 catch `BizError`)
- `.env` 的 `VITE_USE_MOCK=true/false` 一键切换 Mock / 真实请求

## 二、基础能力索引(import 即用)

```ts
import {
  storage, // KV 存储: storage.get/set/remove; storage.secure.*(加密存 token)
  db, // 本地数据库: db.example.list/add/remove(新表见 main/db/dao 流程)
  permission, // 权限: permission.check('microphone') / request / setLaunchAtLogin
  logger, // 日志: logger.info/warn/error(自动落盘主进程日志)
  notify, // 系统通知: notify({ title, body })
  clipboard, // 剪贴板: clipboard.readText / writeText
  shellOpen, // 外部打开: shellOpen.external(url) / showInFolder(path)
  fileDialog, // 文件对话框: fileDialog.open / save
  appWindow, // 窗口控制: minimize / toggleMaximize / close / setAlwaysOnTop
  isMac,
  isWin, // 平台判断
  appControl, // 应用: getVersion / relaunch / quit / checkForUpdates
  eventBus, // 事件总线: eventBus.emit/on(跨组件轻量通知)
  formatTime,
  formatSmartTime,
  formatFileSize,
  formatNumber, // 格式化
  isEmpty,
  isHttpUrl // 类型判断
} from '@/utils'

import { toast } from '@/components/Toast' // toast.success / error / info
import { useAppStore } from '@/stores/appStore' // 主题/语言/设置
import { useUserStore } from '@/stores/userStore' // 用户信息/登录态
import { useRequest } from 'ahooks' // 请求状态管理(loading/error/refresh)
```

## 三、状态管理约定

- 页面内部状态:`useState` / `useReducer`
- 跨页面共享状态:`stores/` 新建 zustand store(参考 `appStore.ts`,需要持久化就加 `persist` + `electronStoreStorage`)
- 服务端数据:`ahooks` 的 `useRequest`,不要手写 loading

## 四、常用第三方库

| 场景          | 库                          | 备注                       |
| ------------- | --------------------------- | -------------------------- |
| 表单          | react-hook-form + zod       | 校验 schema 写在表单组件旁 |
| 动效          | framer-motion               | 参考 Toast 组件用法        |
| Markdown 渲染 | react-markdown + remark-gfm | AI 回复展示                |
| 代码高亮      | shiki                       | 配合 react-markdown        |
| 长列表        | react-virtuoso              | 聊天消息列表必用           |
| 时间          | dayjs                       | 已封装 formatTime          |
| 工具函数      | lodash-es                   | 按需 import                |
| className     | clsx                        | 多 class 组合              |

## 五、禁止事项

1. 禁止散落 URL 字符串——一律收口 `request/urls.ts`
2. 禁止直接用 `window.api`——一律走 `@/utils` 门面
3. 禁止用 localStorage——持久化一律走 `storage` / store 的 persist
4. 禁止手写 IPC channel 字符串——常量在 `shared/ipc-channels.ts`
5. 禁止在页面里写死中文文案——进 i18n
6. 禁止修改基建目录(`main/`、`preload/`、`request/index.ts`、`utils/`)——有缺口找架构负责人

## 六、新增数据库表流程(需要时)

1. `src/main/db/migrations.ts` 追加 migration(version 递增)
2. `src/main/db/dao/xxx.ts` 写 DAO
3. `src/shared/ipc-channels.ts` 加 channel 常量
4. `src/main/ipc/db.ts` 注册 handler
5. `src/shared/types/api.ts` 补 BridgeApi 类型,`src/preload/index.ts` 桥接
6. `src/renderer/src/utils/db.ts` 暴露门面方法
