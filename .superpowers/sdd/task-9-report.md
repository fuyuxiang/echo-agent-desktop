# Task 9 实施报告

## 状态
DONE — 全量测试 9 文件 / 18 用例全部通过

## Commit
`5b766dd` feat: 管理路由与模型配置下发(凭证不明文下发)

## 变更文件
- `src/routes/admin.ts`（新建）— users/groups CRUD，`requireAdmin` preHandler
- `src/routes/model-config.ts`（新建）— GET /api/model-config + PUT /api/admin/model-config，凭证 AES-256-GCM 加密落库，下发只返回 `hasCredential`
- `src/app.ts`（修改）— 注册 `registerAdminRoutes` 和 `registerModelConfigRoutes`
- `test/admin-routes.test.ts`（新建）— 2 个测试用例

## 测试摘要
- admin creates group+user, member cannot: PASS（member 请求 POST /api/admin/groups 返回 403）
- model-config hides credential plaintext: PASS（响应体不含 `sk-secret`，`hasCredential: true`）

## 关注点
- `model-config.ts` 中未 import `requireAdmin`，改用局部 `requireAdminInline` 避免潜在循环 import，逻辑与 `auth.requireAdmin` 完全一致
- UPSERT 语句中 credential 使用 `COALESCE(excluded.credential, model_configs.credential)`，不传 credential 时保留已有加密值

## Fix 报告
修复：requireAdminInline → requireAdmin
测试：admin-routes.test.ts 2/2 PASS
commit: d849980
