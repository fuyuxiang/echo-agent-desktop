// src/main/agent/memory/__tests__/text.test.ts
import { describe, it, expect } from 'vitest'
import { bigramTokens, bigramText } from '../text'

describe('bigramTokens', () => {
  it('中文切单字 + bigram', () => {
    expect(bigramTokens('记忆')).toEqual(['记', '忆', '记忆'])
  })
  it('三字中文', () => {
    expect(bigramTokens('认知力')).toEqual(['认', '知', '力', '认知', '知力'])
  })
  it('中英混排:英文按词,中文按字+bigram', () => {
    const t = bigramTokens('用户 Alice 喜欢 coffee')
    expect(t).toContain('用')
    expect(t).toContain('用户')
    expect(t).toContain('alice')
    expect(t).toContain('coffee')
  })
  it('纯英文小写化按空白切', () => {
    expect(bigramTokens('Hello World')).toEqual(['hello', 'world'])
  })
  it('bigramText 用空格连接', () => {
    expect(bigramText('记忆')).toBe('记 忆 记忆')
  })
  it('空串返回空', () => {
    expect(bigramTokens('')).toEqual([])
  })
})
