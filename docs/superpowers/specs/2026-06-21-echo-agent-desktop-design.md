# Echo Agent 企业版客户端 — 设计文档

日期:2026-06-21
状态:待评审

## 1. 背景与目标

为企业内部打造一个 AI Agent 桌面客户端。核心诉求:

- **跨平台桌面应用**(macOS / Windows),企业内部分发。
- **个人记忆区(本地)**:与个人相关的对话、偏好沉淀在本机,不出本地,隐私最强。
- **项目记忆区(服务器)**:与公司/项目相关的知识存到公司服务器,按部门/项目组隔离、组内共享。
- **复用 echo-agent 的认知记忆与自进化能力**(本地推理),不重写其记忆/进化算法。
- 形态参考 WorkBuddy 企业版、商汤办公小浣熊(本地集成强 + agent 能力),但本项目选择**本地内置推理**而非云端推理,以最大化个人数据隐私。

非目标(本期不做):跨实例记忆联邦、项目记忆的完整认知记忆算法(衰减/矛盾检测)、对接企业 SSO/LDAP、移动端。

## 2. 关键架构决策(已确认)

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 客户端起点 | 基于已有 `echo-desktop` 脚手架继续开发 | 脚手架已实现本地 echo-agent 进程/环境管理,避免重造 |
| 是否复用 echo-agent | 复用,不重写记忆/进化算法 | 这是 echo-agent 最难、最有价值的资产 |
| 推理位置 | **本地内置 echo-agent**(胖客户端) | 个人数据不出本机,隐私最强;契合 echo-agent 本地优先设计 |
| 服务器职责 | **仅项目记忆存取 + 检索 + 账号分组 + 模型配置下发**,不跑 echo-agent | 服务器轻量化,运维简单;项目记忆多为稳定知识,基础检索够用 |
| 项目记忆隔离 | 数据层 `group_id` 字段隔离(B:多组) | 不需多进程多实例,简洁 |
| 记忆分流 | **D 方案**:本地自动识别候选 → 写入前弹确认 → 同意才共享 | 平衡自动化与隐私,避免误写共享区 |
| 模型配置 | **A+B 双来源**:A 服务端下发(优先)+ B 本地手填;覆盖策略由管理员控制;不写死 | 兼顾企业统一管控与灵活性 |
| 账号体系 | 服务器自建(用户名+密码+JWT),管理员/成员两角色,不接企业系统 | MVP 简洁,后续可接 SSO |
| 本期范围 | 客户端 + 轻量服务器一起做 | 服务器变轻后负担可控 |
| 技术栈 | 客户端 Electron+React+TS;服务器 Node+TS | 同语言,降低维护成本 |

## 3. 代码库与目录

- **客户端**:`echo-agent-desktop/`(当前目录,基于 `echo-desktop` 脚手架)
- **服务器**:`echo-agent-server/`(新建,与客户端同级)
- **echo-agent**:现成 Python 项目,客户端打包内置一份;**本项目不修改其源码**

## 4. 总体架构

```
┌─────────────────────────── 用户机器 ───────────────────────────┐
│  Electron 客户端 (纯 TS)                                        │
│  ┌─────────────┐   ┌──────────────────────────────────────┐   │
│  │ Renderer    │   │ Main 进程                             │   │
│  │ (React)     │←→ │  - agent-process: 管理本地 echo-agent │   │
│  │  聊天/记忆区 │   │  - server-connector: 连服务器         │   │
│  │  设置/管理   │   │  - 本地工具执行 (文件读写等)          │   │
│  └─────────────┘   └──────────────────────────────────────┘   │
│         ↓ 本地 HTTP (127.0.0.1, gateway)                        │
│  ┌──────────────────────────────────────────────────────┐     │
│  │ 本地内置 echo-agent (Python)                          │     │
│  │  - 个人记忆区 (workspace, 四层认知记忆 + 自进化)      │     │
│  │  - 推理大脑 (agent loop)                              │     │
│  │  - 模型调用 → 模型配置 (A 下发 / B 本地)              │     │
│  └──────────────────────────────────────────────────────┘     │
└────────────────────────────┬───────────────────────────────────┘
                             │ HTTPS (JWT)
┌────────────────────────────▼───────────────────────────────────┐
│  echo-agent-server (Node + TS,公司内网)                        │
│  - 账号 / 分组 / JWT 认证                                       │
│  - 项目记忆:存储 + 向量检索 (按 group_id 隔离)                  │
│  - 模型配置下发 (组织级,含覆盖策略)                            │
│  - 管理 API (建账号/建组/分配成员)                              │
│  存储:SQLite (+ sqlite-vec 做向量检索)                          │
└──────────────────────────────────────────────────────────────┘
```

### 数据流(一次对话)

1. 用户在客户端输入 → Main 转发给本地 echo-agent。
2. 本地 echo-agent 推理;若需项目背景 → 客户端按本组 `group_id` 向服务器检索项目记忆 → 注入本次上下文。
3. echo-agent 产出回复;如需操作本地文件,通过工具调用让客户端在本机执行。
4. 本地识别出"值得共享为项目记忆"的候选 → 客户端弹确认(D 方案)。
5. 用户同意 → 客户端经服务器接口写入项目记忆(带 `group_id`);拒绝 → 仅留在本地或丢弃。

## 5. 客户端功能规划(完整蓝图)

功能参考 WorkBuddy 企业版与商汤办公小浣熊,按本项目"个人/项目记忆 + 自进化"定位裁剪。规划一次完整,优先级仅决定实现先后:

- **P0** = 首期实现(产品成立的核心)
- **P1** = 次期实现(完善体验与差异化)
- **P2** = 后续增量(锦上添花)

### 一、对话与 Agent 内核
- 流式对话,首 token 即显(P0)
- 自主规划与多步执行(agent loop)(P0)
- 多会话管理:新建/切换/历史/重命名/删除,按工作区分组(P0)
- 工具调用可视化:展示 agent 正在做什么、调了什么工具(P1)
- 高风险工具审批:复用 echo-agent 三档策略,客户端弹审批(P1)
- 产物面板(artifacts):文件/PPT/网页/代码/报告结构化展示 + 预览 + 导出(P1)

### 二、记忆体系(核心特色)
- 个人记忆区:本地存储,浏览/搜索/编辑/删除/置顶(P0)
- 项目记忆区:服务器存储、组内共享,浏览/检索/管理(P0)
- 记忆分流(D):本地识别候选 → 写入前确认(共享到组/仅本地/丢弃)(P0)
- 记忆注入可视化:推理时展示引用了哪些记忆(P1)
- 记忆冲突/矛盾提示(个人记忆侧,echo-agent 已有)(P2)

### 三、自进化(核心特色)
- 技能自进化:从个人使用轨迹生成候选技能(P1)
- 进化审阅:候选展示、晋升/驳回、回滚(P1)
- 进化历史与状态查看(P2)

### 四、技能(Skill)系统
- 内置技能库(echo-agent skills)(P0)
- 技能管理页:启用/禁用/导入/删除(脚手架已有 Skills page)(P1)
- 通过链接添加技能(学小浣熊)(P2)
- 自进化产出技能并入统一管理(P1)

### 五、本地集成
- 读写授权的本地文件/文件夹:批处理、整理、重命名、格式转换(P0)
- 文件拖入对话作为上下文(P0)
- 授权范围管理:哪些目录可访问(参考脚手架 permission 模块)(P0)
- 全局快捷操作栏(类 Quick Bar,Cmd/Ctrl+K):选中文字 → 总结/改写/翻译/生成(P2)

### 六、办公产出能力(以技能形式提供)
- 文档/报告生成(Markdown / Word)(P1)
- 数据分析 + 可视化图表(P1)
- PPT 生成(P2)
- 网页生成(P2)
- 长文研究报告(deep research)(P2)

### 七、知识库
- 文档上传/构建(echo-agent knowledge 模块 + 脚手架 Knowledge page)(P1)
- 个人知识库(本地)/ 项目知识库(服务器,组内共享)(P1)
- 对话中引用知识库(P1)

### 八、账号与组织
- 登录/登出(用户名密码 + JWT)(P0)
- 个人资料与偏好设置(P0)
- 模型配置:A 服务端下发 + B 本地填,覆盖策略管理员控制(P0)
- 服务器连接配置(P0)
- 管理员:用户管理、组管理、组织级模型配置(P0)
- 管理员:项目记忆审计(P2)

### 九、系统与体验
- 引导/初始化(Onboarding:首启装本地 echo-agent,脚手架已有)(P0)
- 本地 echo-agent 状态监控:运行/重启/升级(P0)
- 多语言(i18next,默认中文,脚手架已有)(P0)
- 主题、托盘、快捷键、通知、日志(脚手架已有)(P0)
- 自动更新(electron-updater,脚手架已有)(P1)

## 6. 客户端设计(echo-agent-desktop)

### 6.1 复用脚手架已有能力

`echo-desktop` 脚手架已实现胖客户端核心地基,本期直接沿用:

- `src/main/agent-process/`:内置 Python 解压、venv 创建、`pip install echo-agent`、进程 spawn、就绪信号解析、health check、崩溃自动重启、优雅关闭。
- `config-gen.ts`:生成 `echo-agent.yaml`,**API Key 不落文件、走环境变量注入**,gateway 绑 `127.0.0.1` 随机端口。
- 数据根目录 `~/.echo-agent-desktop/`(python / venv / agent-data / logs)。
- 已有 stores(`agentStore/chatStore/memoryStore/skillStore/userStore`)与 pages(`Chat/Onboarding/Settings/Skills/Knowledge/Channels`)。

### 6.2 本期新增/改造

- **server-connector(主进程新增)**:封装与 `echo-agent-server` 的所有交互(登录、拉组信息、拉/写项目记忆、拉模型配置)。统一 JWT 注入、错误处理、离线降级。
- **项目记忆编排**:
  - 取:推理前按 `group_id` 检索项目记忆,注入本地 echo-agent 上下文(通过 system prompt / 上下文附加)。
  - 写:监听本地 echo-agent 识别出的项目记忆候选,弹确认对话框(D),同意后经 server-connector 写入。
- **记忆区视图(renderer)**:个人记忆区(读本地 echo-agent memory API)、项目记忆区(读服务器),两个 Tab,只读浏览 + 基础管理。
- **登录页 + 用户态**:用户名密码登录,JWT 存安全位置;`userStore` 保存当前用户、角色、所属组。
- **管理页(条件渲染)**:仅管理员可见,调用服务器管理 API。
- **设置页扩展**:模型配置(展示服务端下发值;若允许覆盖,提供本地填写入口)、服务器地址配置。

### 6.3 候选项目记忆的识别(D 方案)

采用最简实现:本地 echo-agent 在记忆写入流程中,对判定为 `ENVIRONMENT`(环境/项目)类型的记忆,客户端拦截并弹确认,而非直接写本地。判定逻辑复用 echo-agent 自身的 USER/ENVIRONMENT 分类,不额外训练模型。用户可在确认框中:同意共享到组 / 仅存本地 / 丢弃。

## 7. 服务器设计(echo-agent-server)

### 7.1 技术栈

- Node + TypeScript;HTTP 框架(Fastify 或 Express,实现时定);SQLite 存储;向量检索用 sqlite-vec(或 better-sqlite3 + 向量扩展)。
- 部署在公司内网,HTTPS,单实例即可(组隔离在数据层完成)。

### 7.2 数据模型(SQLite)

- `users`:id, username, password_hash, role(member/admin), group_id, disabled, created_at。
- `groups`:id, name, created_at。
- `project_memories`:id, group_id, content, embedding(向量), tags, source_user, created_at, updated_at。
- `model_configs`:id, scope(org/group), base_url, model_name, credential(加密), allow_local_override, updated_at。

### 7.3 API(前缀 `/api`)

认证:
- `POST /api/auth/login` → 返回 JWT;`POST /api/auth/logout`。
- 所有业务端点校验 JWT;管理端点额外校验 admin 角色。

项目记忆:
- `POST /api/project-memory`:写入(服务端按 token 推导 group_id,写入 content + 计算 embedding)。
- `POST /api/project-memory/search`:按 group_id + query 向量检索,返回 top-k。
- `GET /api/project-memory`:列出本组记忆(分页);`DELETE /api/project-memory/{id}`。

模型配置:
- `GET /api/model-config`:返回该用户适用的模型配置(org 级,未来可加 group 级)+ `allow_local_override` 标志。

管理(admin):
- `GET/POST/PATCH /api/admin/users`(建/禁用/改组)。
- `GET/POST /api/admin/groups`。
- `PUT /api/admin/model-config`(设置组织级模型配置与覆盖策略)。

### 7.4 安全

- 密码 bcrypt/argon2 哈希;JWT 签名密钥从服务器配置读取。
- 模型凭证加密落库,下发时按需返回(覆盖策略禁用时不下发可被覆盖的字段)。
- 首启从配置文件创建初始超级管理员。
- 全程 HTTPS;项目记忆按 group_id 强隔离(每个查询/写入都强制带 token 推导的 group_id,不信任客户端传入)。

## 8. 模型配置(A+B 双来源)

- 客户端启动/登录后调 `GET /api/model-config` 获取组织级配置(A),默认采用。
- 若 `allow_local_override = true`,设置页允许员工填本地模型配置(B)覆盖;为 false 时强制走 A。
- 配置最终落到本地 echo-agent:`config-gen.ts` 写 `apiBase`/`defaultModel`,Key/凭证走环境变量注入,不写死、不落配置文件明文。

## 9. 测试策略

- **客户端**:server-connector 单测(mock 服务器);记忆分流确认流程单测;agent-process 复用脚手架既有逻辑。
- **服务器**:API 集成测试(认证、组隔离、记忆检索、权限);组隔离重点测——A 组 token 不能读到 B 组记忆。
- **端到端**:登录 → 对话 → 触发项目记忆确认 → 写入 → 另一组员工检索验证隔离。

## 10. 里程碑

里程碑按功能优先级(P0→P1→P2)推进,实现计划阶段细化:

1. 服务器骨架:账号 + JWT + 组 + 项目记忆 CRUD + 向量检索 + 组隔离(P0)。
2. 客户端 server-connector + 登录 + 用户态(P0)。
3. 项目记忆编排:取(注入)+ 写(D 确认)(P0)。
4. 记忆区视图 + 设置页模型配置(A+B)+ 本地文件集成(P0)。
5. 管理页(admin)(P0)。
6. 端到端联调 + 组隔离验证 + 打包(含内置 echo-agent)(P0)。
7. P1/P2 功能增量:产物面板、自进化审阅、知识库、办公产出技能、Quick Bar 等。

## 11. 风险与待澄清

- **内置 echo-agent 打包体积**:Python 运行时 + 依赖使安装包显著增大;首启需联网 pip 安装(脚手架默认清华镜像),离线环境需预置。
- **项目记忆检索质量**:自写向量检索不及 echo-agent 混合检索;若项目记忆量大、检索不准,可后续增强。
- **本地工具执行的权限边界**:本地文件读写需明确授权范围(参考脚手架 permission 模块),避免越权。
- **模型凭证下发的安全细节**:加密方式、轮换机制实现时定。

