# 思考过程展示支持

本应用支持多种 LLM 模型的思考过程展示，自动识别和解析不同格式。

## 支持的格式

### 1. 原生 `reasoning_content` 字段（后端处理）

**支持模型**：
- OpenAI o1/o1-mini
- DeepSeek V3/R1
- 其他实现 OpenAI 兼容接口的模型

**实现位置**：
- `src/main/agent/providers/openai-compatible.ts`
- 识别 SSE 流中的 `delta.reasoning_content`
- 转换为 `{ type: 'reasoning', text: ... }` delta

**示例响应**：
```json
{
  "choices": [{
    "delta": {
      "reasoning_content": "让我分析一下这个问题..."
    }
  }]
}
```

---

### 2. Anthropic `thinking_delta` 字段（后端处理）

**支持模型**：
- Claude 3.5 Sonnet (Extended Thinking)
- 其他支持 thinking 的 Claude 模型

**实现位置**：
- `src/main/agent/providers/anthropic.ts`
- 识别 `delta.type === 'thinking_delta'`
- 转换为 `{ type: 'reasoning', text: ... }` delta

**示例响应**：
```json
{
  "type": "content_block_delta",
  "delta": {
    "type": "thinking_delta",
    "thinking": "我需要仔细考虑..."
  }
}
```

---

### 3. `<think>` 标签（前端解析）

**支持模型**：
- MiniMax M3/M6 系列
- 可能还有其他国内模型

**实现位置**：
- `src/renderer/src/utils/parse-thinking.ts`
- 前端在流式和最终消息中解析

**示例回复**：
```
<think>
这个问题需要从几个方面考虑：
1. 首先...
2. 其次...
</think>

你好！根据分析，我的建议是...
```

**解析结果**：
- `reasoning`: "这个问题需要从几个方面考虑：\n1. 首先...\n2. 其次..."
- `content`: "你好！根据分析，我的建议是..."

---

### 4. `<thinking>` 标签（前端解析）

**支持模型**：
- 某些模型的变体
- 自定义微调模型

**实现位置**：
- `src/renderer/src/utils/parse-thinking.ts`（同上）

**示例回复**：
```
<thinking>正在分析问题...</thinking>

这是我的回答...
```

---

## UI 展示

### 思考中状态
- 发送消息后立即显示"思考中..."动画（三个跳动的点）
- 收到首帧内容后动画消失

### 思考过程展示
- 使用 `<details>` 折叠面板，标题为 "💭 思考过程"
- 流式中默认展开，完成后默认收起
- 用户可随时点击展开/收起查看详细思考内容
- 支持 Markdown 渲染（代码块、列表等）

### 代码位置
- `src/renderer/src/components/MessageBubble/index.tsx`
- 第 67-72 行

---

## 扩展新格式

如果需要支持新的思考标记格式，修改：

### 1. 后端原生支持（推荐）
在对应的 Provider 中识别特定字段并转换为 `{ type: 'reasoning' }` delta：

```typescript
// src/main/agent/providers/your-provider.ts
if (delta?.your_thinking_field) {
  yield { type: 'reasoning', text: delta.your_thinking_field }
}
```

### 2. 前端标签解析（备选）
在 `parse-thinking.ts` 的 `patterns` 数组中添加新正则：

```typescript
const patterns = [
  /<think>([\s\S]*?)<\/think>/gi,
  /<thinking>([\s\S]*?)<\/thinking>/gi,
  /<your_tag>([\s\S]*?)<\/your_tag>/gi  // 新增
]
```

---

## 测试

运行测试验证解析逻辑：

```bash
npm test -- parse-thinking.test.ts
```

当前测试覆盖：
- ✅ 单个/多个 `<think>` 标签
- ✅ 单个/多个 `<thinking>` 标签
- ✅ 混合使用两种标签
- ✅ 多行内容
- ✅ 大小写不敏感
- ✅ 空标签
- ✅ 边界情况

---

## 兼容性矩阵

| 模型 | 格式 | 支持状态 | 实现位置 |
|------|------|---------|---------|
| OpenAI o1/o1-mini | `reasoning_content` | ✅ 已支持 | 后端 Provider |
| Claude 3.5 Sonnet | `thinking_delta` | ✅ 已支持 | 后端 Provider |
| DeepSeek V3/R1 | `reasoning_content` | ✅ 已支持 | 后端 Provider |
| MiniMax M3/M6 | `<think>` | ✅ 已支持 | 前端解析 |
| 其他模型变体 | `<thinking>` | ✅ 已支持 | 前端解析 |
| GPT-4/GPT-4o | 无 | ✅ 不显示（正常） | - |
| 本地 Ollama | 取决于模型 | ✅ 自动适配 | 两种机制 |

---

## 注意事项

1. **优先级**：后端原生 > 前端解析
   - 如果模型同时返回 `reasoning_content` 和 `<think>` 标签，会合并显示

2. **性能**：前端解析每次流式更新都会执行
   - 正则匹配已优化，对性能影响可忽略

3. **安全**：思考内容来自 LLM 回复
   - 已通过 Markdown 渲染器处理，防止 XSS

4. **可扩展**：新增格式无需修改核心逻辑
   - 只需在 `patterns` 数组添加正则即可
