# 测试基线扫描清单

> 配合 `2026-08-18-audit-driven-comprehensive-fix-design.md` §1 使用
> 扫描时间：2026-08-18
> 扫描方法：grep + 阅读相关测试文件，识别"把 bug 当预期行为"的测试

## 原则

每个被固化的错误行为，都必须按以下顺序修复：
1. 写正确行为的反向回归测试（先红）
2. 修改实现让测试通过（再绿）
3. 旧的固化错误行为的测试改为反向回归测试（命名加 `Regression:` 前缀）

---

## 已识别的测试-实现错配

### M1. 切换会话发送空消息（架构债务）

**生产代码**：
- `src/renderer/src/services/agent/runtime-client.ts:21`
  ```ts
  await window.api.agentChat.send(chatId, '', [])
  ```
- `src/main/ipc/agent-chat.ts:21-32` 的 send handler 里耦合了 switchSession

**固化测试**：
- `src/renderer/src/services/agent/__tests__/runtime-client.test.ts:87-92`
  ```ts
  it('switchSession 通知主进程切换网关会话', async () => {
    ...
    await ws.switchSession('c2')
    expect(send).toHaveBeenCalledWith('c2', '', [])  // ← 把 bug 写进断言
  })
  ```
- `src/renderer/src/services/agent/__tests__/runtime-client.test.ts:94-100`
  ```ts
  it('switchSession send 失败时不抛异常', async () => {
    send.mockRejectedValueOnce(...)
    await ws.switchSession('c3')  // ← 整个测试都基于错误行为
  })
  ```
- `src/main/ipc/__tests__/agent-chat.test.ts:38-43`
  ```ts
  it('send switches session then sends text via gateway', () => {
    ...
    expect(gw.switchSession).toHaveBeenCalledWith('c1')
    expect(gw.send).toHaveBeenCalledWith('hi', undefined)
  })
  ```

**修复方案**（spec §3.1）：
1. 拆 IPC：`agentChat.send` 只发文本，`agentChat.switchSession` 只切会话
2. send handler 拒绝空文本
3. `runtime-client.ts` 的 `switchSession` 调 `agentChat.switchSession` 而不是 `send`
4. 修正后的测试应断言：
   - `switchSession` 调用 `agentChat.switchSession`，**不**调用 `send`
   - `send` handler 拒绝空文本
   - `send` handler 只调 `gateway.send`，不再耦合 switchSession

---

### M2. 停止生成没真正停止（信任问题）

**生产代码**：
- `src/renderer/src/pages/Chat/index.tsx:565-580` `handleStop` 只置 `stoppedRef=true` 和 `stopGenerating()`
- 后端 `gateway-client.ts:140-153` 已有 `abort()` 实现
- IPC `agent-chat.ts:34-39` 已有 abort handler

**问题**：前端 Stop 没调 IPC abort

**修复方案**（spec §3.3）：handleStop 调 `await window.api.agentChat.abort({ requestId, chatId })`

---

### M3. API Key 明文写入 config/yaml（合规问题）

**生产代码**：
- `src/renderer/src/services/model-bootstrap.ts:18` 注释明说："apiKey 明文随 apply 传入(写进 yaml),不再走 safeStorage"
- `src/renderer/src/pages/Settings/sections/ModelSection.tsx:56` 把 `apiKey` 写入 LOCAL_CONFIG_KEY
- `src/main/echo-agent/config-writer.ts:36-40` `models.providers[].apiKey` 写到 yaml

**固化测试**：
- `src/renderer/src/services/__tests__/model-bootstrap.test.ts:102-126`
  ```ts
  it('服务器下发的明文 apiKey 原样随 apply 透传', async () => {
    ...
    expect(window.api.echoConfig.apply).toHaveBeenCalledWith({
      apiKey: 'sk-secret',  // ← 把 bug 写进断言
      ...
    })
  })
  ```
- `src/renderer/src/services/__tests__/model-bootstrap.test.ts:128-151`
  ```ts
  it('本地手动配置装配时读取已保存的 apiKey', async () => {
    ...
    expect(window.api.echoConfig.apply).toHaveBeenCalledWith({
      apiKey: 'sk-local',  // ← bug
      ...
    })
  })
  ```

**修复方案**（spec §2.1）：
1. apiKey 只走 safeStorage
2. yaml 中 apiKey 改为占位符 `<key from secure store>`
3. echo-agent 启动时主进程把 safeStorage 中的 key 注入环境变量或单文件
4. `LOCAL_CONFIG_KEY` 只存 `baseUrl` 和 `modelName`，**不存 apiKey**
5. 修正后的测试断言：apply 收到的 apiKey 字段是占位符或 undefined

---

### M4. 仅本机仍请求企业服务器（隐私合规）

**生产代码**：
- `src/renderer/src/stores/orgStore.ts:154-155` 把 scope 变 undefined 后仍走企业接口
- `src/main/org/client.ts:220` scope 字段含 'local' 但未真正短路

**修复方案**（spec §2.2）：scope='local' 时直接短路，不发任何远程请求；网络层加断言

---

### M5. frame:false 无自定义标题栏（Windows UX）

**生产代码**：
- `src/main/window.ts:37` Windows 下 `frame: false`

**问题**：所有渲染页（含 StartupGate、LoginPage）没接 TitleBar 组件

**修复方案**（spec §5.1）：所有 BrowserWindow 内容（包括 StartupGate）包 `<TitleBar>`

---

## 待扫描（Phase 0 后续批次）

### 待扫：mock 中是否固化错误行为

`src/renderer/src/mock/` 目录下 mock 数据可能包含错误的默认行为，需单独扫描。

### 待扫：e2e 测试是否依赖错误行为

`tests/` 目录下若有 e2e 测试，可能依赖错误的 IPC 行为。

---

## 已建/待建的反向回归测试

| 测试名 | 状态 | 位置 |
|---|---|---|
| `Regression: switchSession does NOT trigger send` | ✅ 新建 | `src/__tests__/p0-regressions.test.ts` |
| `Regression: stop invokes abort(requestId) on backend` | 待建（依赖阶段 2） | 同上 |
| `Regression: local scope makes zero network requests` | 待建（依赖阶段 1） | 同上 |
| `Regression: apiKey only written to safeStorage` | ✅ 新建 | 同上 |
| `Regression: window with frame:false has TitleBar component` | 待建（依赖阶段 4） | 同上 |
| `Regression: cross-page navigation preserves recorder UI` | 待建（依赖阶段 4） | 同上 |
| `Regression: signOut clears all identity state` | 待建（依赖阶段 3） | 同上 |

---

## 修复执行清单

- [x] M1 修正 runtime-client.test.ts / agent-chat.test.ts
- [x] M1 修正 runtime-client.ts / agent-chat.ts
- [x] M3 修正 model-bootstrap.test.ts（删除"明文透传"断言）
- [x] M3 修正 ModelSection.tsx（不写 apiKey 到 LOCAL_CONFIG_KEY）
- [x] M3 修正 config-writer.ts（apiKey 字段占位符）
- [ ] M2 修 handleStop（依赖阶段 2）
- [ ] M4 修 orgStore.ts scope=local 短路
- [ ] M5 Windows 标题栏（依赖阶段 4）
