### Task 5: Embedding 提供者(可注入,默认确定性桩)

**Files:**
- Create: `src/embedding.ts`
- Test: `test/embedding.test.ts`

**Interfaces:**
- Produces: `EmbeddingProvider = { embed(text: string): Promise<number[]> }`;`createEmbeddingProvider(): EmbeddingProvider`(读 `ECHO_EMBED_URL`/`ECHO_EMBED_KEY`/`ECHO_EMBED_MODEL`;未配置时返回 `hashEmbedding` 桩);`hashEmbedding(text, dim=1024): number[]`(确定性,L2 归一化)

> 设计说明:服务器本身不绑定具体大模型。生产用 OpenAI 兼容 `/embeddings` 接口(由 env 配置);未配置时用确定性 hash 向量桩,保证可独立测试与离线开发。维度固定 1024,与 Task 2 的 vec 虚表一致。

- [ ] **Step 1: 写失败测试 test/embedding.test.ts**

```ts
import { describe, it, expect } from 'vitest'
import { hashEmbedding } from '../src/embedding.js'

describe('hashEmbedding', () => {
  it('is deterministic and correct length', () => {
    const a = hashEmbedding('hello', 1024)
    const b = hashEmbedding('hello', 1024)
    expect(a).toHaveLength(1024)
    expect(a).toEqual(b)
  })
  it('differs for different text', () => {
    expect(hashEmbedding('a')).not.toEqual(hashEmbedding('b'))
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `npm test test/embedding.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 src/embedding.ts**

```ts
import { createHash } from 'node:crypto'

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>
}

export function hashEmbedding(text: string, dim = 1024): number[] {
  const vec = new Array<number>(dim).fill(0)
  // 用滚动 hash 把 token 散布到各维度,得到确定性伪向量
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean)
  for (const tok of tokens) {
    const h = createHash('md5').update(tok).digest()
    for (let i = 0; i < h.length; i++) {
      vec[(h[i] + i * 31) % dim] += (h[i] - 128) / 128
    }
  }
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1
  return vec.map((x) => x / norm)
}

export function createEmbeddingProvider(): EmbeddingProvider {
  const url = process.env.ECHO_EMBED_URL
  const k = process.env.ECHO_EMBED_KEY
  const model = process.env.ECHO_EMBED_MODEL ?? 'text-embedding-3-small'
  if (!url || !k) {
    return { embed: async (t) => hashEmbedding(t) }
  }
  return {
    async embed(text: string): Promise<number[]> {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` },
        body: JSON.stringify({ model, input: text })
      })
      const json = (await res.json()) as { data: { embedding: number[] }[] }
      return json.data[0].embedding
    }
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npm test test/embedding.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 可注入的 embedding 提供者(默认确定性向量桩)"
```

---

