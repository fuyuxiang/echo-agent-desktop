# Task 3 报告：密码哈希与凭证加密工具

## 完成状态

DONE

## Commit

`c0de56e` feat: 密码 argon2 哈希与凭证 AES-256-GCM 加密工具

## 新增文件

- `src/crypto.ts` — 实现 4 个导出函数
- `test/crypto.test.ts` — 2 个测试用例

## 测试摘要

```
Test Files  1 passed (1)
Tests  2 passed (2)
Duration  479ms
```

- `verifies a correct password and rejects wrong` — 通过（argon2 哈希 + 验证）
- `round-trips an encrypted secret` — 通过（AES-256-GCM 加解密往返）

## 技术说明

- 密码哈希：使用 `argon2.hash` / `argon2.verify`，参数采用 argon2 库默认值
- 凭证加密：AES-256-GCM，密钥由 `ECHO_SERVER_SECRET` 经 SHA-256 派生为 32 字节
- 密文格式：`base64(iv).base64(authTag).base64(ciphertext)`，三段用 `.` 分隔
- 密钥未设置时抛出明确错误 `ECHO_SERVER_SECRET not set`

## 关注点

无。
