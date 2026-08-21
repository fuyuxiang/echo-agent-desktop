# Echo Agent Desktop 内置企业插件

这是 Echo Agent Desktop 随包分发的 Python 企业组织知识库插件。Desktop 首次启动时把它安装到 echo-agent 的同一 venv，通过 `echo_agent.plugins` entry point 接入普通聊天的 hook/tool 链路。

## 设计前提

插件不锁定 echo-agent 版本，也不声明 echo-agent 包依赖；Desktop 先安装 PyPI latest `echo-agent[all]`，再安装本目录。插件 API 兼容性由 Desktop 的集成测试负责。

## 安装

普通用户不需要手工安装。开发调试可运行 `pip install ./resources/echo-agent-org`。

## 配置

配置读的是 `plugins.config.<config_key>`（由 `MANIFEST.config_key` 决定，此处为 `org`），不是 `plugins.org`：

```yaml
# ~/.echo-agent/echo-agent.yaml
plugins:
  config:
    org:
      enabled: true                     # 缺省 false，装了也不生效
      server_url: https://echo.company.internal
      credentials_path: ~/.echo-agent/plugins/org/credentials.json
      cache_path: /path/to/desktop/userData/echo.db
      inject_mode: auto                 # auto | tool_only | off
      material_token_budget: 6000
      allow_agentic: true               # false 则强制单跳，控制 token 成本
      timeouts: { connect_ms: 3000, read_ms: 8000 }
```

若企业把 `plugins.permission_mode` 设为 `strict`，本插件已在 MANIFEST 里声明 `hook.register` / `tool.register` / `network`，无需额外配置。

## 凭证

token **不放配置文件**。默认读 `~/.echo-agent/plugins/org/credentials.json`（0600）：

```json
{ "access_token": "<jwt>", "user_id": "u_zhang" }
```

由 Desktop 登录和 token 刷新流程自动写入，或通过 `ECHO_ORG_CREDENTIALS` 指定路径。

身份取自该文件里 JWT 的 `sub`，**不取自会话的 user_id** —— desktop 的 `gateway-client.ts` 把 `user_id` 硬编码为 `'desktop-user'`，那是占位符。权限一律由服务端按 JWT 判定。

## 工作方式

| 查询类型 | 路由 | 行为 |
|---|---|---|
| 问候语、翻译、纯计算 | `no_retrieval` | 不检索，零开销 |
| 一般事实型问题 | `fast` | 单次检索 + 注入材料（默认） |
| 对比 / 汇总 / 多问句 | `agentic` | 不注入，让模型自己调 `org_search` 多跳 |

默认偏向 `fast`：agentic 循环消耗 3~10 倍 token。

## 降级行为

任何失败都不会中断对话：

| 情况 | 行为 |
|---|---|
| 服务器不可达 / 超时 | 降级到本地缓存 |
| 凭证无效或过期 | **不读缓存**，直接放行并告警 |
| 缓存缺失 / 损坏 | 返回空结果，正常回答 |
| 插件内部异常 | 捕获并放行 |

凭证无效时刻意不读缓存：那会让权限撤销被绕过。

## 提供的工具

`org_search`、`org_fetch_doc`、`org_who_knows`、`org_submit_knowledge`（提交进审核队列，不直接写库）。

## 开发

```bash
pip install -e ".[dev]"
pytest tests/ -v
```

## 给插件作者的两个坑

1. **`pre_llm_call` 必须返回 `HookResult(modified=...)`**。`hooks.py` 只读返回值的 `.modified`；返回裸 list 会抛 `AttributeError` 并被吞成一条 warning —— 插件看起来正常加载、日志干净，但注入完全没发生。放行时返回 `None`。
2. **entry-point 目标是模块，不是函数**。loader 在目标上找 `activate` 属性和模块级 `MANIFEST` dict。
