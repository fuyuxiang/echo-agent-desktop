// src/main/agent/memory/text.ts

// CJK 连续段: 无空格词边界,纯拉丁分词器会把中文整段丢空。
// 切成单字保证召回 + 相邻 bigram 提供廉价短语局部性。零依赖(不引 jieba)。
const CJK_RUN = /[一-鿿]+/g
const LATIN_RUN = /[a-zA-Z0-9]+/g

/** CJK 段切单字+bigram;拉丁段小写按词。 */
export function bigramTokens(text: string): string[] {
  if (!text) return []
  const tokens: string[] = []
  for (const run of text.match(CJK_RUN) ?? []) {
    for (const ch of run) tokens.push(ch)
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2))
  }
  for (const run of text.match(LATIN_RUN) ?? []) {
    tokens.push(run.toLowerCase())
  }
  return tokens
}

/** tokens 用空格连接,供 FTS5 入库/查询。 */
export function bigramText(text: string): string {
  return bigramTokens(text).join(' ')
}
