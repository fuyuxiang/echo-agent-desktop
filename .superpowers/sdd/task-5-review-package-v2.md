6340fb8 fix: embedding API 错误处理与维度校验
a443c67 feat: 可注入的 embedding 提供者(默认确定性向量桩)
---
 src/embedding.ts       | 42 ++++++++++++++++++++++++++++++++++++++++++
 test/embedding.test.ts | 14 ++++++++++++++
 2 files changed, 56 insertions(+)
---
diff --git a/src/embedding.ts b/src/embedding.ts
new file mode 100644
index 0000000..1c5aaee
--- /dev/null
+++ b/src/embedding.ts
@@ -0,0 +1,42 @@
+import { createHash } from 'node:crypto'
+
+export interface EmbeddingProvider {
+  embed(text: string): Promise<number[]>
+}
+
+export function hashEmbedding(text: string, dim = 1024): number[] {
+  const vec = new Array<number>(dim).fill(0)
+  // spread tokens across dimensions via rolling hash for a deterministic pseudo-vector
+  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean)
+  for (const tok of tokens) {
+    const h = createHash('md5').update(tok).digest()
+    for (let i = 0; i < h.length; i++) {
+      vec[(h[i] + i * 31) % dim] += (h[i] - 128) / 128
+    }
+  }
+  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1
+  return vec.map((x) => x / norm)
+}
+
+export function createEmbeddingProvider(): EmbeddingProvider {
+  const url = process.env.ECHO_EMBED_URL
+  const k = process.env.ECHO_EMBED_KEY
+  const model = process.env.ECHO_EMBED_MODEL ?? 'text-embedding-3-small'
+  if (!url || !k) {
+    return { embed: async (t) => hashEmbedding(t) }
+  }
+  return {
+    async embed(text: string): Promise<number[]> {
+      const res = await fetch(url, {
+        method: 'POST',
+        headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` },
+        body: JSON.stringify({ model, input: text })
+      })
+      if (!res.ok) throw new Error(`embedding API error ${res.status}: ${await res.text()}`)
+      const json = (await res.json()) as { data: { embedding: number[] }[] }
+      const vec = json.data[0].embedding
+      if (vec.length !== 1024) throw new Error(`embedding dim mismatch: expected 1024, got ${vec.length}. Set ECHO_EMBED_MODEL to a 1024-dim model or configure dimensions parameter`)
+      return vec
+    }
+  }
+}
diff --git a/test/embedding.test.ts b/test/embedding.test.ts
new file mode 100644
index 0000000..a9195c6
--- /dev/null
+++ b/test/embedding.test.ts
@@ -0,0 +1,14 @@
+import { describe, it, expect } from 'vitest'
+import { hashEmbedding } from '../src/embedding.js'
+
+describe('hashEmbedding', () => {
+  it('is deterministic and correct length', () => {
+    const a = hashEmbedding('hello', 1024)
+    const b = hashEmbedding('hello', 1024)
+    expect(a).toHaveLength(1024)
+    expect(a).toEqual(b)
+  })
+  it('differs for different text', () => {
+    expect(hashEmbedding('a')).not.toEqual(hashEmbedding('b'))
+  })
+})
