# Phase 2: 会话和配置增强设计文档

**日期**: 2026-07-16
**作者**: 产品经理
**状态**: 草案

---

## 一、项目背景

### 1.1 Phase 1 完成情况

Phase 1 已成功完成，实现了模型管理和提供商管理功能：
- ✅ 模型管理（类型、服务、IPC、Store、页面）
- ✅ 提供商管理（类型、服务、IPC、Store、页面）
- ✅ 路由和导航集成
- ✅ 108+ 测试全部通过

### 1.2 Phase 2 目标

在 Phase 1 的基础上，继续实现会话管理增强、配置管理和计划任务功能，进一步完善 Echo Agent Desktop 的功能。

---

## 二、功能规划

### 2.1 会话管理增强（预计 2 周）

#### 功能需求：
1. **全文搜索** - SQLite FTS5 支持
2. **按日期分组** - 今天、昨天、本周、更早
3. **会话标题编辑** - 支持手动修改标题
4. **会话导出/导入** - JSON 格式

#### 技术实现：
```
src/main/sessions.ts              # 会话管理服务增强
src/renderer/src/pages/Sessions/  # 会话历史页面
src/shared/session-types.ts       # 类型定义
src/renderer/src/stores/sessionStore.ts  # 状态管理
```

#### 参考实现：
- Hermes Desktop: `src/main/sessions.ts` + `src/renderer/src/screens/Sessions/`

### 2.2 配置管理 (Profiles)（预计 1.5 周）

#### 功能需求：
1. **多环境配置切换** - 开发、测试、生产
2. **配置隔离** - 独立存储和配置
3. **配置导入/导出** - JSON 格式
4. **配置颜色和头像** - 个性化设置

#### 技术实现：
```
src/main/profiles.ts              # 配置管理服务
src/renderer/src/pages/Profiles/  # 配置管理页面
src/shared/profile-types.ts       # 类型定义
src/renderer/src/stores/profileStore.ts  # 状态管理
```

#### 参考实现：
- Hermes Desktop: `src/main/profiles.ts` + `src/renderer/src/screens/Agents/`

### 2.3 计划任务 (Schedules)（预计 2 周）

#### 功能需求：
1. **Cron 任务创建** - 分钟、小时、天、周、自定义
2. **15 种推送目标** - 本地、Telegram、Discord、Slack 等
3. **任务暂停/恢复** - 灵活控制
4. **任务触发和日志** - 执行记录

#### 技术实现：
```
src/main/cronjobs.ts                # 计划任务服务
src/renderer/src/pages/Schedules/   # 计划任务页面
src/shared/schedule-types.ts        # 类型定义
src/renderer/src/stores/scheduleStore.ts  # 状态管理
```

#### 参考实现：
- Hermes Desktop: `src/main/cronjobs.ts` + `src/renderer/src/screens/Schedules/`

---

## 三、技术架构

### 3.1 目录结构

```
src/
├── shared/
│   ├── session-types.ts      # 会话类型定义
│   ├── profile-types.ts      # 配置类型定义
│   └── schedule-types.ts     # 计划任务类型定义
├── main/
│   ├── sessions.ts           # 会话管理服务
│   ├── profiles.ts           # 配置管理服务
│   ├── cronjobs.ts           # 计划任务服务
│   └── ipc/
│       ├── sessions.ts       # 会话 IPC 处理器
│       ├── profiles.ts       # 配置 IPC 处理器
│       └── schedules.ts      # 计划任务 IPC 处理器
└── renderer/
    └── src/
        ├── pages/
        │   ├── Sessions/     # 会话历史页面
        │   ├── Profiles/     # 配置管理页面
        │   └── Schedules/    # 计划任务页面
        └── stores/
            ├── sessionStore.ts    # 会话状态管理
            ├── profileStore.ts    # 配置状态管理
            └── scheduleStore.ts   # 计划任务状态管理
```

### 3.2 数据流

```
用户操作 → 页面组件 → Zustand Store → IPC 调用 → 主进程服务 → 数据存储
```

### 3.3 状态管理

使用 Zustand 进行状态管理，每个功能模块一个 Store：
- `sessionStore` - 会话状态
- `profileStore` - 配置状态
- `scheduleStore` - 计划任务状态

---

## 四、实施计划

### 4.1 第一阶段：会话管理增强（2 周）

#### Week 1: 类型定义和服务
- Task 1: Session Types Definition
- Task 2: Session Management Service
- Task 3: Session IPC Handlers

#### Week 2: Store 和页面
- Task 4: Session Store
- Task 5: Session Management Page
- Task 6: 路由和导航集成

### 4.2 第二阶段：配置管理（1.5 周）

#### Week 1: 类型定义和服务
- Task 7: Profile Types Definition
- Task 8: Profile Management Service
- Task 9: Profile IPC Handlers

#### Week 2: Store 和页面
- Task 10: Profile Store
- Task 11: Profile Management Page
- Task 12: 路由和导航集成

### 4.3 第三阶段：计划任务（2 周）

#### Week 1: 类型定义和服务
- Task 13: Schedule Types Definition
- Task 14: Schedule Management Service
- Task 15: Schedule IPC Handlers

#### Week 2: Store 和页面
- Task 16: Schedule Store
- Task 17: Schedule Management Page
- Task 18: 路由和导航集成

---

## 五、风险评估

### 5.1 技术风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| SQLite FTS5 兼容性 | 中 | 测试不同平台兼容性 |
| 配置隔离复杂性 | 中 | 参考 Hermes Desktop 实现 |
| Cron 表达式解析 | 低 | 使用成熟库 |

### 5.2 项目风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 时间延期 | 中 | 分阶段实施，优先核心功能 |
| 需求变更 | 低 | 灵活调整，保持架构弹性 |

---

## 六、成功标准

### 6.1 功能完整性

- 实现会话管理增强功能
- 实现配置管理功能
- 实现计划任务功能
- 100% 保留 Phase 1 功能

### 6.2 代码质量

- 测试覆盖率 > 80%
- 代码风格一致性 > 95%
- 无严重 Bug

### 6.3 用户体验

- 界面风格统一
- 操作流畅
- 响应时间 < 100ms

---

## 七、附录

### 7.1 参考资料

1. Hermes Desktop 项目: `/Users/fuyuxiang/Documents/100-主业/130-东方国信/13.代码仓库/echo-desktop/hermes-desktop`
2. Phase 1 设计文档: `docs/specs/2026-07-16-hermes-features-integration-design.md`
3. Phase 1 实施计划: `docs/specs/2026-07-16-hermes-features-integration-phase1.md`

### 7.2 术语表

- **Session**: 会话，用户与 Agent 的对话记录
- **Profile**: 配置，用户环境和设置
- **Schedule**: 计划任务，定时执行的任务
- **Cron**: 定时任务表达式

### 7.3 变更历史

- 2026-07-16: 初始版本

---

**文档结束**
