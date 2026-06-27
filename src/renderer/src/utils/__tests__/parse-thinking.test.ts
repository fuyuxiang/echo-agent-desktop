import { describe, it, expect } from 'vitest'
import { parseThinkingTags } from '../parse-thinking'

describe('parseThinkingTags', () => {
  describe('<think> 标签', () => {
    it('提取单个 <think> 标签', () => {
      const text = '<think>我需要思考一下...</think>\n\n你好！'
      const result = parseThinkingTags(text)
      expect(result.reasoning).toBe('我需要思考一下...')
      expect(result.content).toBe('你好！')
    })

    it('提取多个 <think> 标签', () => {
      const text = '<think>第一步思考</think>\n\n中间内容\n\n<think>第二步思考</think>\n\n最终回复'
      const result = parseThinkingTags(text)
      expect(result.reasoning).toBe('第一步思考\n\n第二步思考')
      expect(result.content).toBe('中间内容\n\n最终回复')
    })

    it('处理多行 <think> 内容', () => {
      const text = `<think>
第一行思考
第二行思考
第三行思考
</think>

实际回复内容`
      const result = parseThinkingTags(text)
      expect(result.reasoning).toBe('第一行思考\n第二行思考\n第三行思考')
      expect(result.content).toBe('实际回复内容')
    })

    it('处理大小写不敏感', () => {
      const text = '<THINK>大写思考</THINK>\n\n<Think>混合大小写</Think>\n\n回复'
      const result = parseThinkingTags(text)
      expect(result.reasoning).toBe('大写思考\n\n混合大小写')
      expect(result.content).toBe('回复')
    })
  })

  describe('<thinking> 标签', () => {
    it('提取单个 <thinking> 标签', () => {
      const text = '<thinking>正在思考...</thinking>\n\n这是回复'
      const result = parseThinkingTags(text)
      expect(result.reasoning).toBe('正在思考...')
      expect(result.content).toBe('这是回复')
    })

    it('提取多个 <thinking> 标签', () => {
      const text = '<thinking>步骤1</thinking>\n\n内容\n\n<thinking>步骤2</thinking>\n\n最终'
      const result = parseThinkingTags(text)
      expect(result.reasoning).toBe('步骤1\n\n步骤2')
      expect(result.content).toBe('内容\n\n最终')
    })

    it('处理 <thinking> 大小写', () => {
      const text = '<THINKING>大写</THINKING>\n\n<Thinking>混合</Thinking>\n\n回复'
      const result = parseThinkingTags(text)
      expect(result.reasoning).toBe('大写\n\n混合')
      expect(result.content).toBe('回复')
    })
  })

  describe('混合标签', () => {
    it('同时处理 <think> 和 <thinking>', () => {
      const text = '<think>用think思考</think>\n\n中间\n\n<thinking>用thinking思考</thinking>\n\n回复'
      const result = parseThinkingTags(text)
      expect(result.reasoning).toBe('用think思考\n\n用thinking思考')
      expect(result.content).toBe('中间\n\n回复')
    })
  })

  describe('边界情况', () => {
    it('没有思考标签时返回原内容', () => {
      const text = '这是一条普通回复'
      const result = parseThinkingTags(text)
      expect(result.reasoning).toBe('')
      expect(result.content).toBe('这是一条普通回复')
    })

    it('处理空标签', () => {
      const text = '<think></think>\n\n<thinking></thinking>\n\n回复内容'
      const result = parseThinkingTags(text)
      expect(result.reasoning).toBe('')
      expect(result.content).toBe('回复内容')
    })

    it('处理仅有思考标签无实际内容', () => {
      const text = '<think>只有思考过程</think>'
      const result = parseThinkingTags(text)
      expect(result.reasoning).toBe('只有思考过程')
      expect(result.content).toBe('')
    })
  })
})
