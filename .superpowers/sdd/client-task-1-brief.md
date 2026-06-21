### Task 1: 基线导入与服务器地址配置

**Files:**
- Create: 整个客户端基线(从 `echo-desktop` 拷入)
- Modify: `.env`(新增 `VITE_API_BASE_URL`)
- Modify: `src/renderer/src/request/urls.ts`(确认 host 来源)

**Interfaces:**
- Produces: 可 `npm run dev` 启动的脚手架基线;`API_HOST` 指向 echo-agent-server。

- [ ] **Step 1: 拷入脚手架基线**

```bash
cd "/Users/fuyuxiang/Documents/100-主业/130-东方国信/13.代码仓库/echo-agent-desktop"
rsync -a --exclude node_modules --exclude out --exclude dist "../echo-desktop/" ./
npm install
```

- [ ] **Step 2: 验证基线可构建**

Run: `npm run typecheck`
Expected: 通过(无类型错误)

- [ ] **Step 3: 配置服务器地址**

在 `.env`(无则新建)追加:
```
VITE_API_BASE_URL=http://127.0.0.1:8787
VITE_USE_MOCK=false
```

- [ ] **Step 4: 提交**

```bash
git init && git add -A
git commit -m "chore: 导入桌面客户端脚手架基线并配置服务器地址"
```

---

