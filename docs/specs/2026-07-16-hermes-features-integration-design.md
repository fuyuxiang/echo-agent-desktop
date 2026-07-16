# Echo Agent Desktop 功能整合设计文档

**日期**: 2026-07-16
**作者**: 产品经理
**状态**: 草案

---

## 一、项目背景

### 1.1 当前状态

**Echo Agent Desktop** 是一个基于 Electron + React + TypeScript 的跨平台桌面客户端，已具备以下核心功能：
- 聊天系统 (Chat)
- 记忆系统 (Memory)
- 会议系统 (Meeting)
- 知识库 (Knowledge)
- 技能管理 (Skills)
- 设置管理 (Settings)
- 频道管理 (Channels)
- 登录认证 (Login)
- 管理后台 (Admin)

**Hermes Desktop** 是一个功能更丰富的同类项目，具备以下 Echo Agent Desktop 缺失的功能：
- 模型管理 (Models)
- 提供商管理 (Providers)
- 工具集管理 (Tools)
- 计划任务 (Schedules)
- 消息网关 (Gateway)
- 看板系统 (Kanban)
- 人格编辑 (Soul)
- 配置管理 (Profiles)
- Office 3D 界面

### 1.2 目标

将 Hermes Desktop 的主要功能整合到 Echo Agent Desktop 中，同时保留 Echo Agent Desktop 的特色功能（会议、知识库、频道等），打造一个功能完整、体验统一的 AI Agent 桌面客户端。

---

## 二、功能对比分析

### 2.1 功能模块对比矩阵

| 功能模块 | Hermes Desktop | Echo Agent Desktop | 整合策略 |
|---------|---------------|-------------------|---------|
| **聊天 (Chat)** | ✅ 完整 | ✅ 完整 | 保持现有实现 |
| **会话管理 (Sessions)** | ✅ 完整 | ✅ 基础 | 增强 |
| **记忆系统 (Memory)** | ✅ 完整 | ✅ 完整 | 保持现有实现 |
| **技能 (Skills)** | ✅ 完整 | ✅ 基础 | 增强 |
| **模型管理 (Models)** | ✅ 完整 | ❌ 缺失 | **新增** |
| **提供商 (Providers)** | ✅ 完整 | ❌ 缺失 | **新增** |
| **工具集 (Tools)** | ✅ 完整 | ❌ 缺失 | **新增** |
| **计划任务 (Schedules)** | ✅ 完整 | ❌ 缺失 | **新增** |
| **消息网关 (Gateway)** | ✅ 完整 | ❌ 缺失 | **新增** |
| **看板 (Kanban)** | ✅ 基础 | ❌ 缺失 | **新增** |
| **人格编辑 (Soul)** | ✅ 完整 | ❌ 缺失 | **新增** |
| **配置管理 (Profiles)** | ✅ 完整 | ❌ 缺失 | **新增** |
| **Office 3D** | ✅ 基础 | ❌ 缺失 | 可选 |
| **设置 (Settings)** | ✅ 完整 | ✅ 基础 | 增强 |
| **会议 (Meeting)** | ❌ 缺失 | ✅ 完整 | **保留** |
| **知识库 (Knowledge)** | ❌ 缺失 | ✅ 完整 | **保留** |
| **频道 (Channels)** | ❌ 缺失 | ✅ 基础 | **保留** |
| **登录认证 (Login)** | ❌ 缺失 | ✅ 完整 | **保留** |
| **管理后台 (Admin)** | ❌ 缺失 | ✅ 基础 | **保留** |

### 2.2 核心差异分析

#### Hermes Desktop 的优势功能：

1. **多提供商支持** - 11+ 个 LLM 提供商（OpenRouter、Anthropic、OpenAI、Google 等）
2. **完整的消息网关** - 16 个消息平台（Telegram、Discord、Slack、WhatsApp 等）
3. **看板系统 (Kanban)** - 任务管理和多代理协作
4. **计划任务 (Schedules)** - Cron 任务调度
5. **工具集管理** - 14 种工具集的启用/禁用
6. **人格编辑 (Soul)** - SOUL.md 人格设定
7. **配置切换 (Profiles)** - 多环境隔离
8. **模型管理** - 跨提供商的模型配置

#### Echo Agent Desktop 的特色功能：

1. **会议系统 (Meeting)** - 会议记录、实时转录、ASR
2. **知识库 (Knowledge)** - 知识库管理、问答系统
3. **频道 (Channels)** - 渠道管理
4. **登录认证** - 用户认证系统
5. **管理后台** - 系统管理功能
6. **PPT 生成** - PPT 组件

---

## 三、技术架构分析

### 3.1 技术栈对比

| 技术 | Hermes Desktop | Echo Agent Desktop | 整合策略 |
|------|---------------|-------------------|---------|
| Electron | 39.x | 41.x | 保持 41.x |
| React | 19 | 18 | 保持 18 |
| TypeScript | 5.9 | 6.0 | 保持 6.0 |
| CSS | Tailwind CSS 4 | CSS Modules (SCSS) | 保持 SCSS |
| 状态管理 | useState/useContext | Zustand | 保持 Zustand |
| 测试 | Vitest | Vitest | 保持 Vitest |
| 数据库 | better-sqlite3 | better-sqlite3 | 保持 |
| 国际化 | i18next | i18next | 保持 |

### 3.2 架构差异

#### Hermes Desktop 架构：
- **目录结构**: `screens/` 目录，无独立 `services`、`stores`
- **状态管理**: React useState/useContext + localStorage
- **IPC 通信**: 单一 `register.ts` 文件（2948 行）
- **组件组织**: 扁平化组件目录

#### Echo Agent Desktop 架构：
- **目录结构**: `pages/` + `services/` + `stores/` 标准结构
- **状态管理**: Zustand 全局状态
- **IPC 通信**: 按功能模块拆分的 IPC 文件
- **组件组织**: 模块化组件目录

### 3.3 整合策略

**保持 Echo Agent Desktop 的架构优势**：
1. 继续使用 Zustand 状态管理
2. 继续使用 CSS Modules (SCSS)
3. 继续使用模块化的 IPC 架构
4. 继续使用 pages/services/stores 目录结构

**借鉴 Hermes Desktop 的功能逻辑**：
1. 参考 Hermes Desktop 的功能实现逻辑
2. 适配到 Echo Agent Desktop 的架构中
3. 保持代码风格和命名规范的一致性

---

## 四、功能整合规划

### 4.1 第一阶段：核心功能补全（P0，优先级最高）

#### 4.1.1 模型管理 (Models) - 预计 2 周

**功能需求**：
- 模型配置的 CRUD（增删改查）
- 跨提供商的模型管理
- 模型定义和上下文窗口配置
- 模型切换和默认模型设置

**技术实现**：
```
src/main/models.ts              # 主进程模型管理
src/renderer/src/pages/Models/  # 模型管理页面
src/shared/model-types.ts       # 类型定义
```

**参考实现**：
- Hermes Desktop: `src/main/models.ts` + `src/renderer/src/screens/Models/`

**关键逻辑**：
1. 模型配置存储（JSON/YAML）
2. 模型定义管理（名称、上下文窗口、提供商）
3. 模型切换逻辑
4. IPC 接口：`list-models`、`add-model`、`remove-model`、`update-model`

#### 4.1.2 提供商管理 (Providers) - 预计 2 周

**功能需求**：
- API 密钥管理
- 多提供商配置（OpenRouter、Anthropic、OpenAI、Google 等）
- 提供商测试和验证
- 自定义提供商支持

**技术实现**：
```
src/main/providers.ts              # 提供商配置管理
src/renderer/src/pages/Providers/  # 提供商管理页面
src/shared/provider-types.ts       # 类型定义
```

**参考实现**：
- Hermes Desktop: `src/main/providers-store.ts` + `src/renderer/src/screens/Providers/`

**关键逻辑**：
1. 提供商配置存储
2. API 密钥加密存储
3. 提供商连接测试
4. IPC 接口：`list-providers`、`add-provider`、`remove-provider`、`test-provider`

#### 4.1.3 工具集管理 (Tools) - 预计 1.5 周

**功能需求**：
- 14 种工具集的启用/禁用
- 工具集分类和描述
- 工具集状态持久化

**技术实现**：
```
src/main/tools.ts              # 工具集管理
src/renderer/src/pages/Tools/  # 工具集管理页面
src/shared/tool-types.ts       # 类型定义
```

**参考实现**：
- Hermes Desktop: `src/main/tools.ts` + `src/renderer/src/screens/Tools/`

**关键逻辑**：
1. 工具集配置存储
2. 工具集启用/禁用逻辑
3. 工具集分类管理
4. IPC 接口：`get-toolsets`、`set-toolset-enabled`

---

### 4.2 第二阶段：会话和配置增强（P1）

#### 4.2.1 会话管理增强 - 预计 2 周

**功能需求**：
- 全文搜索（SQLite FTS5）
- 按日期分组的历史记录
- 会话标题编辑
- 会话导出/导入

**技术实现**：
```
src/main/sessions.ts              # 会话管理增强
src/renderer/src/pages/Sessions/  # 会话历史页面
src/shared/session-types.ts       # 类型定义
```

**参考实现**：
- Hermes Desktop: `src/main/sessions.ts` + `src/renderer/src/screens/Sessions/`

#### 4.2.2 配置管理 (Profiles) - 预计 1.5 周

**功能需求**：
- 多环境配置切换
- 配置隔离和独立存储
- 配置导入/导出
- 配置颜色和头像设置

**技术实现**：
```
src/main/profiles.ts              # 配置管理
src/renderer/src/pages/Agents/    # 配置管理页面
src/shared/profile-types.ts       # 类型定义
```

**参考实现**：
- Hermes Desktop: `src/main/profiles.ts` + `src/renderer/src/screens/Agents/`

#### 4.2.3 计划任务 (Schedules) - 预计 2 周

**功能需求**：
- Cron 任务创建和管理
- 15 种推送目标支持
- 任务暂停/恢复
- 任务触发和日志

**技术实现**：
```
src/main/cronjobs.ts                # 计划任务管理
src/renderer/src/pages/Schedules/   # 计划任务页面
src/shared/schedule-types.ts        # 类型定义
```

**参考实现**：
- Hermes Desktop: `src/main/cronjobs.ts` + `src/renderer/src/screens/Schedules/`

---

### 4.3 第三阶段：高级功能（P2）

#### 4.3.1 消息网关 (Gateway) - 预计 3 周

**功能需求**：
- 16 个消息平台集成
- 平台配置和测试
- 消息转发和同步
- 网关状态监控

**技术实现**：
```
src/main/gateway.ts              # 网关管理
src/renderer/src/pages/Gateway/  # 网关管理页面
src/shared/gateway-types.ts      # 类型定义
```

**参考实现**：
- Hermes Desktop: `src/main/messaging-platforms.ts` + `src/renderer/src/screens/Gateway/`

#### 4.3.2 看板系统 (Kanban) - 预计 2.5 周

**功能需求**：
- 任务看板（9 种状态）
- 任务创建和分配
- 依赖关系管理
- 实时更新（WebSocket）

**技术实现**：
```
src/main/kanban.ts              # 看板管理
src/renderer/src/pages/Kanban/  # 看板页面
src/shared/kanban-types.ts      # 类型定义
```

**参考实现**：
- Hermes Desktop: `src/main/kanban.ts` + `src/renderer/src/screens/Kanban/`

#### 4.3.3 人格编辑 (Soul) - 预计 1 周

**功能需求**：
- SOUL.md 编辑器
- 人格设定和重置
- 人格模板

**技术实现**：
```
src/main/soul.ts              # 人格管理
src/renderer/src/pages/Soul/  # 人格编辑页面
src/shared/soul-types.ts      # 类型定义
```

**参考实现**：
- Hermes Desktop: `src/main/soul.ts` + `src/renderer/src/screens/Soul/`

---

### 4.4 第四阶段：设置和优化（P3）

#### 4.4.1 设置页面增强 - 预计 2 周

**功能需求**：
- 提供商配置集成
- 凭证池管理
- 备份/导入
- 日志查看器
- 网络设置
- 主题切换

**技术实现**：
```
src/renderer/src/pages/Settings/  # 设置页面增强
src/main/backup.ts                # 备份管理
src/main/logs.ts                  # 日志管理
```

**参考实现**：
- Hermes Desktop: `src/renderer/src/screens/Settings/`

#### 4.4.2 技能管理增强 - 预计 1.5 周

**功能需求**：
- 技能市场（Discover）
- 技能安装/卸载
- 技能内容查看
- 技能版本管理

**技术实现**：
```
src/main/skills.ts              # 技能管理增强
src/renderer/src/pages/Discover/  # 技能发现页面
src/shared/skill-types.ts       # 类型定义
```

**参考实现**：
- Hermes Desktop: `src/main/skills.ts` + `src/renderer/src/screens/Discover/`

---

## 五、保留 Echo Agent Desktop 的特色功能

### 5.1 必须保留的核心功能

1. **会议系统 (Meeting)**
   - 会议记录和转录
   - 实时 ASR 语音识别
   - 会议详情和回放
   - 参考: `src/renderer/src/pages/Meeting/`

2. **知识库 (Knowledge)**
   - 知识库管理
   - 知识库问答 (KbQA)
   - 知识库库 (KbLibrary)
   - 参考: `src/renderer/src/pages/Knowledge/`、`KbQA/`、`KbLibrary/`

3. **频道 (Channels)**
   - 渠道管理
   - 多渠道配置
   - 参考: `src/renderer/src/pages/Channels/`

4. **登录认证 (Login)**
   - 用户认证系统
   - 登录/登出
   - 参考: `src/renderer/src/pages/Login/`

5. **管理后台 (Admin)**
   - 系统管理功能
   - 用户管理
   - 参考: `src/renderer/src/pages/Admin/`

6. **PPT 生成**
   - PPT 组件
   - PPT 生成逻辑
   - 参考: `src/renderer/src/components/PptComposer/`

### 5.2 技术栈保持

- 继续使用 CSS Modules (SCSS)
- 继续使用 Zustand 状态管理
- 继续使用现有的 IPC 架构
- 继续使用 pages/services/stores 目录结构

---

## 六、实施路线图

### 6.1 详细时间表

```
第 1-2 周: 模型管理 + 提供商管理
第 3-4 周: 工具集管理 + 会话增强
第 5-6 周: 配置管理 + 计划任务
第 7-9 周: 消息网关 + 看板系统
第 10-11 周: 人格编辑 + 设置增强
第 12 周: 技能管理增强 + 测试
```

### 6.2 里程碑

1. **M1 (第 2 周)**: 模型管理和提供商管理完成
2. **M2 (第 4 周)**: 工具集管理和会话增强完成
3. **M3 (第 6 周)**: 配置管理和计划任务完成
4. **M4 (第 9 周)**: 消息网关和看板系统完成
5. **M5 (第 11 周)**: 人格编辑和设置增强完成
6. **M6 (第 12 周)**: 技能管理增强和测试完成

---

## 七、风险评估和缓解措施

### 7.1 技术风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 技术栈差异 | 中 | 保持现有技术栈，仅借鉴逻辑 |
| 功能耦合 | 高 | 模块化设计，松耦合架构 |
| 测试覆盖 | 中 | 每个功能模块配套单元测试 |
| 用户体验 | 中 | 保持现有 UI 风格一致性 |
| 性能影响 | 中 | 性能测试和优化 |

### 7.2 项目风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 时间延期 | 高 | 分阶段实施，优先核心功能 |
| 需求变更 | 中 | 灵活调整，保持架构弹性 |
| 资源不足 | 中 | 合理分配，优先高价值功能 |

---

## 八、成功标准

### 8.1 功能完整性

- 实现 Hermes Desktop 80% 的核心功能
- 100% 保留 Echo Agent Desktop 的特色功能

### 8.2 代码质量

- 测试覆盖率 > 80%
- 代码风格一致性 > 95%
- 无严重 Bug

### 8.3 用户体验

- 界面风格统一
- 操作流畅
- 响应时间 < 100ms

### 8.4 性能指标

- 启动时间 < 3s
- 内存占用 < 500MB
- CPU 使用率 < 30%

---

## 九、附录

### 9.1 参考资料

1. Hermes Desktop 项目: `/Users/fuyuxiang/Documents/100-主业/130-东方国信/13.代码仓库/echo-desktop/hermes-desktop`
2. Echo Agent Desktop 项目: `/Users/fuyuxiang/Documents/100-主业/130-东方国信/13.代码仓库/echo-desktop/echo-agent-desktop`
3. Hermes Desktop 功能分析: `lat.md/` 目录
4. Kanban 差距分析: `KANBAN_GAP_REPORT.md`

### 9.2 术语表

- **Provider**: LLM 提供商（如 OpenAI、Anthropic 等）
- **Profile**: 配置环境（如开发、测试、生产）
- **Soul**: 人格设定（SOUL.md）
- **Gateway**: 消息网关
- **Kanban**: 任务看板
- **Schedule**: 计划任务

### 9.3 变更历史

- 2026-07-16: 初始版本

---

**文档结束**
