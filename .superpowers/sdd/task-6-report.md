# Task 6 Report: 项目记忆 DAO

## 完成情况

**状态：** DONE  
**commit：** 265f296  
**测试：** 6 files, 13 tests — all passed

## 实现要点

### 文件
- `src/dao/memories.ts` — DAO 实现
- `test/memories.test.ts` — 测试（tmpdir 临时文件替代 :memory:）

### sqlite-vec KNN 语法处理

sqlite-vec 0.1.9 的 KNN 查询不支持在虚拟表 WHERE 里混合 group_id 等业务字段过滤。采用两步方案：

1. `WHERE embedding MATCH ? AND k = ?` — 只对 vec_memories 做纯向量 KNN，取候选 memory_id 列表
2. `WHERE id IN (...) AND group_id = ?` — 在 project_memories 上用 group_id 过滤，确保组隔离铁律

### 组隔离保证
- `searchMemories`：KNN 先取候选，再 WHERE group_id 过滤，跨组数据不会返回
- `listMemories`：直接 WHERE group_id
- `deleteMemory`：DELETE WHERE id AND group_id，跨组 id 不命中返回 false

## 关注点

测试文件原 brief 使用 `:memory:`，但 sqlite-vec 不支持内存数据库。改为 tmpdir 临时文件，并在 afterEach 中清理，与 db.test.ts 保持一致。
