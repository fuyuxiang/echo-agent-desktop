# Task 8 报告：项目记忆 REST 路由

## 状态
DONE — commit `8d56d88`

## 变更文件
- 新增 `src/routes/memory.ts` — 四条路由实现
- 修改 `src/app.ts` — import 并调用 `registerMemoryRoutes(app)`
- 新增 `test/memory-routes.test.ts` — 2 个测试用例

## 测试摘要
- 本任务测试：2/2 通过
- 全量测试：16/16 通过，无回归

## 组隔离
`group_id` 全部从 `req.user.groupId`（JWT claims）读取，未从请求体或查询参数读取。

## 关注点
无。
