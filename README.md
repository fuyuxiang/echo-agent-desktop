# Echo Agent Desktop

Echo Agent 跨平台桌面客户端(macOS / Windows),基于 Electron + React + TypeScript。

## 技术栈

| 层       | 选型                                                 |
| -------- | ---------------------------------------------------- |
| 桌面框架 | Electron + electron-vite + electron-builder          |
| UI       | React 18 + TypeScript + CSS Modules(SCSS)            |
| 状态     | Zustand(+ immer + persist,落盘 electron-store)       |
| 网络     | axios(BaseData 统一解包 + Mock 开关)                 |
| 本地数据 | electron-store(KV/设置) + better-sqlite3(结构化数据) |
| 多语言   | i18next(默认中文)                                    |
| 日志     | electron-log(双进程统一落盘)                         |

## 快速开始

```bash
npm install        # 安装依赖(postinstall 自动 rebuild 原生模块)
npm run dev        # 开发模式(热更新)
```

## 常用命令

```bash
npm run new:page     # 生成页面四件套(page + service + mock + 路由)
npm run typecheck    # 类型检查
npm run lint         # ESLint 检查并修复
npm run build:mac    # 打包 mac(dmg + zip)
npm run build:win    # 打包 win(nsis,需在 win 或配置 wine 环境)
npm run build:unpack # 仅打包目录产物(本地快速验证)
```

## 目录速览

```
src/
├── shared/     主进程↔渲染层共享(IPC channel 常量、类型)
├── main/       主进程(窗口/托盘/快捷键/数据库/存储/权限/IPC)
├── preload/    contextBridge 桥接(window.api)
└── renderer/   渲染层
    ├── pages/      ★ 业务页面(日常开发区)
    ├── services/   ★ 接口定义(URL + 类型)
    ├── mock/       ★ Mock 数据
    ├── request/    axios 封装 + urls 收口
    ├── utils/      基础能力门面(存储/数据库/权限/日志/通知...)
    ├── stores/     zustand 全局状态
    ├── components/ 通用组件(Toast 等)
    └── layouts/    布局 + 自定义标题栏
```

## 开发规范

页面开发请阅读 [docs/PAGE_GUIDE.md](docs/PAGE_GUIDE.md)(新建页面三步走 + 基础能力索引 + 禁止事项)。

## 说明

- Electron 暂固定在 41.x:better-sqlite3 与 Electron ≥42 的 V8 API 存在已知编译不兼容([WiseLibs/better-sqlite3#1474](https://github.com/WiseLibs/better-sqlite3/issues/1474)),官方修复发版后再升级
- 应用图标当前为占位图(`scripts/generate-placeholder-icons.mjs` 生成),正式图标到位后替换 `resources/`
- mac/win 均未配置代码签名,产物仅供内部分发
- Agent 通信层(`services/agent/`)为预留占位,本期未设计
