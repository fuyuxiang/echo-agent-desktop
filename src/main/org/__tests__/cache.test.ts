import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { OrgCache, toBigrams, buildMatch, type SyncPayload } from '../cache'

// 缓存是"离线可用"的代价:本地留了一份组织知识的副本。权限收回必须能
// 落到这份副本上,否则便利功能就变成了越权漏洞。

function makeCache(): OrgCache {
  return new OrgCache(new Database(':memory:'))
}

function payload(over: Partial<SyncPayload> = {}): SyncPayload {
  return {
    docs: [],
    memories: [],
    revokedDocs: [],
    revokedMemories: [],
    purgeAll: false,
    ...over
  }
}

function doc(id: string, title: string, text: string, scopeKind: 'org' | 'team' = 'org') {
  return {
    docId: id,
    title,
    scopeKind,
    updatedAt: Date.now(),
    chunks: [
      {
        chunkId: `${id}-c1`,
        text,
        heading: null,
        locPage: 3,
        locStartMs: null,
        modality: 'text'
      }
    ]
  }
}

describe('中文分词补偿', () => {
  // FTS5 的 unicode61 把 CJK 按单字切,查"报销"会命中所有含"报"或"销"的
  // 内容。bigram 化把多字词变成可匹配的单元。
  it('CJK 切成 bigram', () => {
    expect(toBigrams('报销审批')).toBe('报销 销审 审批')
  })

  it('单字保留原样', () => {
    expect(toBigrams('我')).toBe('我')
  })

  it('ASCII 词整体保留', () => {
    const out = toBigrams('XR2000 报销')
    expect(out).toContain('XR2000')
    expect(out).toContain('报销')
  })

  it('空串不报错', () => {
    expect(toBigrams('')).toBe('')
    expect(buildMatch('   ')).toBe('')
  })

  // 不转义会让用户输入的引号变成 FTS5 语法,查询直接报错。
  it('FTS 特殊字符被转义', () => {
    for (const q of ['"引号"', 'a*b', '(括号)', 'x^2', '--破折号']) {
      expect(() => buildMatch(q)).not.toThrow()
    }
  })
})

describe('缓存检索', () => {
  let cache: OrgCache

  beforeEach(() => {
    cache = makeCache()
    cache.applySync(
      payload({ docs: [doc('d1', '差旅管理办法', '一线城市住宿标准 500 元每晚。')] }),
      100
    )
  })

  it('中文多字词能命中', () => {
    const res = cache.search('住宿标准')
    expect(res.chunks.length).toBeGreaterThan(0)
    expect(res.chunks[0].text).toContain('500')
    expect(res.fromCache).toBe(true)
  })

  it('保留定位信息供引用跳转', () => {
    const res = cache.search('住宿标准')
    expect(res.chunks[0].citation.page).toBe(3)
    expect(res.chunks[0].citation.openUrl).toContain('d1')
  })

  it('无关查询不返回结果', () => {
    expect(cache.search('量子计算机采购预算').chunks).toHaveLength(0)
  })

  it('空缓存返回空结果而非抛错', () => {
    expect(makeCache().search('任何问题').chunks).toHaveLength(0)
  })

  it('特殊字符查询不破坏检索', () => {
    for (const q of ['100%', "'单引号'", ';DROP TABLE org_kb_cache;--']) {
      expect(() => cache.search(q)).not.toThrow()
    }
    // 表还在
    expect(cache.stats().chunks).toBeGreaterThan(0)
  })

  it('离线检索仍按组织/团队 scope 过滤', () => {
    cache.applySync(
      payload({ docs: [doc('d2', '团队差旅', '团队住宿标准 800 元每晚。', 'team')] }),
      101
    )
    expect(cache.search('住宿标准', 8, ['org']).chunks.map((c) => c.docId)).toEqual(['d1'])
    expect(cache.search('住宿标准', 8, ['team']).chunks.map((c) => c.docId)).toEqual(['d2'])
  })
})

describe('权限收回', () => {
  let cache: OrgCache

  beforeEach(() => {
    cache = makeCache()
    cache.applySync(
      payload({
        docs: [
          doc('d1', '公开手册', '弹性工作制说明。'),
          doc('d2', '财务内部', '发票审核流程说明。')
        ]
      }),
      100
    )
  })

  it('revokedDocs 中的文档被删除', () => {
    expect(cache.search('发票审核').chunks.length).toBeGreaterThan(0)
    cache.applySync(payload({ revokedDocs: ['d2'] }), 200)
    expect(cache.search('发票审核').chunks).toHaveLength(0)
    // 未被收回的仍在
    expect(cache.search('弹性工作制').chunks.length).toBeGreaterThan(0)
  })

  it('purgeAll 清空全部组织知识', () => {
    cache.applySync(payload({ purgeAll: true }), 200)
    expect(cache.stats().chunks).toBe(0)
    expect(cache.search('弹性工作制').chunks).toHaveLength(0)
  })

  // 顺序反了会让刚被收回的文档因同一批里的更新又被写回来。
  it('同一批中收回优先于写入', () => {
    cache.applySync(
      payload({
        docs: [doc('d2', '财务内部', '发票审核流程说明。')],
        revokedDocs: ['d2']
      }),
      200
    )
    expect(cache.search('发票审核').chunks).toHaveLength(0)
  })

  it('重复同步同一文档不产生重复片段', () => {
    const before = cache.stats().chunks
    cache.applySync(
      payload({ docs: [doc('d1', '公开手册', '弹性工作制说明。')] }),
      200
    )
    expect(cache.stats().chunks).toBe(before)
  })

  it('收回后 FTS 索引同步清理(不留可命中的残留)', () => {
    cache.applySync(payload({ revokedDocs: ['d1', 'd2'] }), 200)
    expect(cache.stats().chunks).toBe(0)
    expect(cache.search('弹性工作制').chunks).toHaveLength(0)
    expect(cache.search('发票审核').chunks).toHaveLength(0)
  })

  it('revokedMemories 中的组织记忆被删除', () => {
    cache.applySync(payload({
      memories: [{ id: 'm1', kind: 'fact', content: '住宿需审批', scopeKind: 'org' }]
    }), 150)
    expect(cache.search('住宿').memories).toHaveLength(1)
    cache.applySync(payload({ revokedMemories: ['m1'] }), 200)
    expect(cache.search('住宿').memories).toHaveLength(0)
  })
})

describe('同步状态', () => {
  it('记录游标与同步时间', () => {
    const cache = makeCache()
    expect(cache.getCursor()).toBe(0)
    cache.applySync(payload({ docs: [doc('d1', 'T', '正文内容。')] }), 12345)
    expect(cache.getCursor()).toBe(12345)
    expect(cache.stats().lastSyncAt).toBeGreaterThan(0)
  })

  it('统计文档与片段数', () => {
    const cache = makeCache()
    cache.applySync(
      payload({ docs: [doc('d1', 'A', '第一篇。'), doc('d2', 'B', '第二篇。')] }),
      100
    )
    const stats = cache.stats()
    expect(stats.docs).toBe(2)
    expect(stats.chunks).toBe(2)
  })

  it('清空后游标归零(下次全量拉取)', () => {
    const cache = makeCache()
    cache.applySync(payload({ docs: [doc('d1', 'A', '内容。')] }), 500)
    cache.clearAll()
    expect(cache.getCursor()).toBe(0)
  })
})

describe('待提交队列', () => {
  it('入队与出队', () => {
    const cache = makeCache()
    cache.enqueuePromotion({
      id: 'p1',
      payloadType: 'memory',
      payload: '{"kind":"fact","content":"x"}',
      source: 'qa',
      targetScope: 's_org'
    })
    expect(cache.pendingPromotions()).toHaveLength(1)
    cache.markPromotionSubmitted('p1')
    expect(cache.pendingPromotions()).toHaveLength(0)
  })

  it('失败记录原因但保留在队列', () => {
    const cache = makeCache()
    cache.enqueuePromotion({
      id: 'p1',
      payloadType: 'memory',
      payload: '{}',
      source: 'qa',
      targetScope: 's_org'
    })
    cache.markPromotionFailed('p1', '网络不可达')
    const pending = cache.pendingPromotions()
    expect(pending).toHaveLength(1)
    expect(pending[0].lastError).toContain('网络不可达')
  })

  // 待提交的是用户写的内容,清缓存(登出)不该顺手丢掉它。
  it('清空缓存不影响待提交队列', () => {
    const cache = makeCache()
    cache.enqueuePromotion({
      id: 'p1',
      payloadType: 'memory',
      payload: '{}',
      source: 'qa',
      targetScope: 's_org'
    })
    cache.clearAll()
    expect(cache.pendingPromotions()).toHaveLength(1)
  })
})
