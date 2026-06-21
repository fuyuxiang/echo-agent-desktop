# Task 10 实施报告

## 完成内容

### 新增文件
- `src/server.ts` — 服务入口，导出 `ensureInitialAdmin(db)` 和 `start()`
- `test/bootstrap.test.ts` — 初始管理员引导测试
- `README.md` — 启动说明文档

### 关键实现
- `ensureInitialAdmin`：检查 `listUsers(db).length > 0`，若为空则用 `ECHO_ADMIN_USER/ECHO_ADMIN_PASSWORD` 环境变量创建首个 admin，幂等
- `start()`：`getDb()` → `ensureInitialAdmin` → `buildApp` → `app.listen({ port, host: '0.0.0.0' })`
- 直接运行判断：`process.argv[1].endsWith('server.js')`，兼容 ESM 模块格式

## 测试结果

全量测试 10 个文件、19 个用例，全部通过：
- bootstrap.test.ts — 1 passed（新增）
- 其余 9 个测试文件 — 18 passed（原有，无回归）

## 提交
commit: a3a2363
message: feat: 服务入口、初始管理员引导与启动文档
