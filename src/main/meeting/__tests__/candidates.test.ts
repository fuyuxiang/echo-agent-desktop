import { describe, it, expect } from 'vitest'
import type { SegmentDTO } from '@shared/types/meeting'
import {
  buildCandidatePrompt,
  parseCandidates,
  parseTimestamp,
  extractCandidates
} from '../candidates'

// 模型输出不可控:会包代码块、会加解释、会编造字段、会返回非法类型。
// 解析层必须容错到"无论模型吐什么都不会崩",同时不能让垃圾条目进组织库 ——
// 组织库的噪音会污染所有人的后续问答。

function seg(idx: number, startMs: number, text: string, speaker?: string): SegmentDTO {
  return {
    id: idx,
    meetingId: 'm1',
    idx,
    startMs,
    endMs: startMs + 5000,
    text,
    speaker: speaker ?? null,
    createdAt: Date.now()
  }
}

const SEGMENTS: SegmentDTO[] = [
  seg(0, 0, '今天讨论采购流程。', '张三'),
  seg(1, 65000, '决定了,以后采购申请统一走线上流程,纸质单据不再受理。', '李四'),
  seg(2, 130000, '上次批量导入没备份,丢了一批数据,以后必须先备份。', '王五')
]

describe('提示词构造', () => {
  it('转写带时间戳与说话人', () => {
    const p = buildCandidatePrompt(SEGMENTS)
    expect(p).toContain('[00:00][张三]')
    expect(p).toContain('[01:05][李四]')
    expect(p).toContain('[02:10][王五]')
  })

  it('明确排除待办事项', () => {
    // "张三下周三提交报表"是任务不是知识,进了库就成永久噪音
    expect(buildCandidatePrompt(SEGMENTS)).toContain('那是任务,不是知识')
  })

  it('要求宁缺勿滥', () => {
    expect(buildCandidatePrompt(SEGMENTS)).toContain('宁缺勿滥')
  })
})

describe('时间戳解析', () => {
  it('解析 MM:SS', () => {
    expect(parseTimestamp('01:05')).toBe(65000)
    expect(parseTimestamp('00:00')).toBe(0)
    expect(parseTimestamp('120:30')).toBe(7230000)
  })

  it('非法值返回 null 而不猜', () => {
    for (const v of ['', 'abc', '1:5', '1分5秒', null, undefined, 65, {}]) {
      expect(parseTimestamp(v)).toBeNull()
    }
  })
})

describe('候选解析', () => {
  const valid = JSON.stringify([
    {
      kind: 'decision',
      content: '采购申请统一走线上流程,纸质单据不再受理。',
      rationale: '会上明确决定。',
      quote: '以后采购申请统一走线上流程',
      timestamp: '01:05'
    }
  ])

  it('解析规范输出', () => {
    const out = parseCandidates(valid, SEGMENTS)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('decision')
    expect(out[0].content).toContain('线上流程')
    expect(out[0].startMs).toBe(65000)
    // 时间戳落在李四的发言区间内
    expect(out[0].speaker).toBe('李四')
  })

  it('剥掉 Markdown 代码块包裹', () => {
    expect(parseCandidates(`\`\`\`json\n${valid}\n\`\`\``, SEGMENTS)).toHaveLength(1)
    expect(parseCandidates(`\`\`\`\n${valid}\n\`\`\``, SEGMENTS)).toHaveLength(1)
  })

  it('容忍数组前后的解释文字', () => {
    const out = parseCandidates(`好的,我提取到以下内容:\n${valid}\n以上就是全部。`, SEGMENTS)
    expect(out).toHaveLength(1)
  })

  it('空数组与无内容返回空', () => {
    expect(parseCandidates('[]', SEGMENTS)).toHaveLength(0)
    expect(parseCandidates('没有值得留存的内容', SEGMENTS)).toHaveLength(0)
    expect(parseCandidates('', SEGMENTS)).toHaveLength(0)
  })

  it('非法 JSON 返回空而不抛错', () => {
    expect(parseCandidates('[{kind: decision,', SEGMENTS)).toHaveLength(0)
    expect(parseCandidates('{"not":"array"}', SEGMENTS)).toHaveLength(0)
  })

  // 让模型的自由发挥进组织库才是真正的风险。
  it('丢弃白名单外的类型', () => {
    const raw = JSON.stringify([
      { kind: 'todo', content: '张三下周三提交报表' },
      { kind: 'random', content: '随便什么' },
      { kind: 'decision', content: '合法条目' }
    ])
    const out = parseCandidates(raw, SEGMENTS)
    expect(out).toHaveLength(1)
    expect(out[0].content).toBe('合法条目')
  })

  it('丢弃内容为空的条目', () => {
    const raw = JSON.stringify([
      { kind: 'decision', content: '' },
      { kind: 'decision', content: '   ' },
      { kind: 'decision', content: '有内容' }
    ])
    expect(parseCandidates(raw, SEGMENTS)).toHaveLength(1)
  })

  it('截断超长内容而非拒绝', () => {
    const raw = JSON.stringify([{ kind: 'decision', content: 'x'.repeat(5000) }])
    const out = parseCandidates(raw, SEGMENTS)
    expect(out).toHaveLength(1)
    // 服务端上限 2000,超了会被拒,所以客户端先截断
    expect(out[0].content.length).toBeLessThanOrEqual(2000)
  })

  it('缺时间戳时按原文反查说话人', () => {
    const raw = JSON.stringify([
      {
        kind: 'pitfall',
        content: '批量导入前必须先备份。',
        quote: '上次批量导入没备份'
      }
    ])
    const out = parseCandidates(raw, SEGMENTS)
    expect(out[0].startMs).toBeNull()
    expect(out[0].speaker).toBe('王五')
  })

  it('时间戳与原文都对不上时 speaker 为 null', () => {
    const raw = JSON.stringify([
      { kind: 'decision', content: '某条结论', quote: '完全不存在的原文' }
    ])
    expect(parseCandidates(raw, SEGMENTS)[0].speaker).toBeNull()
  })

  it('缺失可选字段不影响解析', () => {
    const raw = JSON.stringify([{ kind: 'convention', content: '周报周五提交' }])
    const out = parseCandidates(raw, SEGMENTS)
    expect(out).toHaveLength(1)
    expect(out[0].rationale).toBe('')
    expect(out[0].quote).toBe('')
  })

  it('生成的 id 在一次抽取内唯一', () => {
    const raw = JSON.stringify([
      { kind: 'decision', content: 'A' },
      { kind: 'convention', content: 'B' },
      { kind: 'pitfall', content: 'C' }
    ])
    const ids = parseCandidates(raw, SEGMENTS).map((c) => c.id)
    expect(new Set(ids).size).toBe(3)
  })

  it('数组项非对象时跳过', () => {
    const raw = JSON.stringify(['字符串', 123, null, { kind: 'decision', content: '合法' }])
    expect(parseCandidates(raw, SEGMENTS)).toHaveLength(1)
  })
})

describe('抽取流程', () => {
  function fakeProvider(output: string) {
    return {
      async *chat() {
        yield { type: 'text' as const, text: output }
      }
    } as never
  }

  it('空转写直接返回空,不调模型', async () => {
    let called = false
    const provider = {
      async *chat() {
        called = true
        yield { type: 'text' as const, text: '[]' }
      }
    } as never
    expect(await extractCandidates([], { provider })).toHaveLength(0)
    expect(called).toBe(false)
  })

  it('正常抽取', async () => {
    const raw = JSON.stringify([
      { kind: 'decision', content: '采购走线上流程', timestamp: '01:05' }
    ])
    const out = await extractCandidates(SEGMENTS, { provider: fakeProvider(raw) })
    expect(out).toHaveLength(1)
    expect(out[0].speaker).toBe('李四')
  })

  // 抽取失败只该让候选区为空,不能让会议详情页崩掉。
  it('provider 报错时返回空数组', async () => {
    const provider = {
      async *chat() {
        yield { type: 'error' as const, message: '模型不可用' }
      }
    } as never
    expect(await extractCandidates(SEGMENTS, { provider })).toHaveLength(0)
  })

  it('provider 抛异常时返回空数组', async () => {
    const provider = {
      async *chat() {
        throw new Error('网络中断')
      }
    } as never
    await expect(extractCandidates(SEGMENTS, { provider })).resolves.toHaveLength(0)
  })

  it('无 provider 时返回空数组', async () => {
    // 未配置模型的个人版环境不该报错
    const out = await extractCandidates(SEGMENTS, { provider: undefined as never })
    expect(Array.isArray(out)).toBe(true)
  })
})
