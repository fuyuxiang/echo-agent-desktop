import { useEffect, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { MessageBubble } from '@/components/MessageBubble'
import { FileDropZone } from '@/components/FileDropZone'
import { useChatStore } from '@/stores/chatStore'
import { useAgentStore } from '@/stores/agentStore'
import { useSkillStore } from '@/stores/skillStore'
import { agentWs } from '@/services/agent/runtime-client'
import { attachmentsAPI } from '@/services/agent/attachments'
import { skillsAPI } from '@/services/agent/skills'
import skillDescriptionsZh from '@/services/agent/skill-descriptions'
import { useSkillImport } from '@/hooks/useSkillImport'
import { buildProjectMemoryContext } from '@/services/chat-inject'
import { db } from '@/utils/db'
import { logger } from '@/utils/logger'
import { confirmShareToProject, type MemoryCandidate } from '@/services/memory-router'
import { ShareMemoryDialog } from '@/components/ShareMemoryDialog'
import { PptComposer } from '@/components/PptComposer'
import { MeetingButton } from '@/components/MeetingButton'
import { LivePanel } from '@/pages/Meeting/LivePanel'
import { useMeetingRecorder } from '@/hooks/useMeetingRecorder'
import { ScopeSwitcher } from '@/components/ScopeSwitcher'
import { toast } from '@/components/Toast'
import { permission } from '@/utils/permission'
import styles from './chat.module.scss'

const CHINESE_OUTPUT_DIRECTIVE = [
  '输出规则：',
  '1. 默认使用简体中文进行流式输出和最终回答。',
  '2. 代码、命令、日志、API 字段、错误栈和专有名词可以保留原文。',
  '3. 如需说明处理过程，只输出简洁的中文过程摘要，不输出隐藏推理链路。'
].join('\n')

/**
 * 等待 WS 重连并 auth 后进入 OPEN(sendMessage 仅在 OPEN 时才真正发出)。
 * 用于新建会话:switchSession 是异步重连,需等连接就绪再发首条消息,避免被静默丢弃。
 * 带超时兜底,避免无限等待。
 */
function waitForWsReady(timeoutMs = 5000): Promise<boolean> {
  if (agentWs.connected) return Promise.resolve(true)
  const start = Date.now()
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (agentWs.connected) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() - start >= timeoutMs) {
        clearInterval(timer)
        resolve(false)
      }
    }, 50)
  })
}

function getPayloadText(payload: Record<string, unknown>): string {
  const value = payload.text ?? payload.delta ?? payload.content ?? payload.message
  return typeof value === 'string' ? value : ''
}

function isReasoningPayload(payload: Record<string, unknown>): boolean {
  const meta = payload.metadata as Record<string, unknown> | undefined
  const rawKind =
    payload.stream_type ??
    payload.delta_type ??
    payload.content_type ??
    payload.phase ??
    meta?.stream_type ??
    meta?.delta_type ??
    meta?.content_type ??
    meta?.phase
  const kind = typeof rawKind === 'string' ? rawKind.toLowerCase() : ''
  return ['reasoning', 'thinking', 'thought', 'analysis', 'plan', 'process'].includes(kind)
}

function buildOutboundText(text: string, selectedSkill: string | null): string {
  const task = selectedSkill ? `请使用「${selectedSkill}」技能处理下面的任务：\n\n${text}` : text

  return `${CHINESE_OUTPUT_DIRECTIVE}\n\n用户任务：\n${task}`
}

/** 截断兜底:LLM 标题不可用时,按首句/标点边界裁到 ~16 字,不强行加省略号 */
function truncateTitle(text: string, max = 16): string {
  const firstLine = (text.split('\n').find((l) => l.trim()) ?? '').trim()
  if (!firstLine) return ''
  // 优先在标点处断句,得到更自然的短标题
  const sentence = firstLine.split(/[。！？!?；;\n]/)[0].trim() || firstLine
  if (sentence.length <= max) return sentence
  return sentence.slice(0, max) + '…'
}

/**
 * 为会话生成标题:优先用 LLM 概括主题(参考豆包/ChatGPT),失败回退到截断首句。
 * 异步执行,不阻塞消息流;生成后同步更新 store 与本地库。
 */
async function applySessionTitle(chatId: string, firstUserMessage: string): Promise<void> {
  if (!firstUserMessage) return
  let title = ''
  try {
    title = await window.api.agentChat.generateTitle(firstUserMessage)
  } catch {
    /* 忽略,走截断兜底 */
  }
  if (!title) title = truncateTitle(firstUserMessage)
  if (!title) return
  // 标题生成期间用户可能已改名/删会话,这里只在仍为占位名时回填,避免覆盖用户操作
  const session = useChatStore.getState().sessions.find((s) => s.chatId === chatId)
  if (session && session.title && session.title !== '新对话') return
  useChatStore.getState().updateSessionTitle(chatId, title)
  void db.session.updateTitle(chatId, title)
}

/**
 * 欢迎首屏工具箱磁贴(参考办公小浣熊「数据分析 / 一图读懂 / 知识库问答 / 文案生成」)
 * 点击磁贴 = 往输入框填入引导语并聚焦,不臆造后端能力
 * tint 为磁贴左侧图标底色(紫/薄荷交替),呼应办公小浣熊磁贴质感
 */
interface ToolboxItem {
  key: string
  icon: string
  tint: string
  nameKey: string
  descKey: string
  promptKey: string
}

/** 待发送附件:上传中→就绪/失败,就绪后随消息携带 remoteId 发往 agent */
interface PendingAttachment {
  localId: string
  name: string
  size: number
  status: 'uploading' | 'ready' | 'error'
  remoteId?: string
}

const TOOLBOX: ToolboxItem[] = [
  {
    key: 'analysis',
    icon: '📊',
    tint: 'rgba(142, 107, 242, 0.12)',
    nameKey: 'chat.tools.analysis.name',
    descKey: 'chat.tools.analysis.desc',
    promptKey: 'chat.tools.analysis.prompt'
  },
  {
    key: 'chart',
    icon: '📈',
    tint: 'rgba(171, 231, 213, 0.16)',
    nameKey: 'chat.tools.chart.name',
    descKey: 'chat.tools.chart.desc',
    promptKey: 'chat.tools.chart.prompt'
  },
  {
    key: 'knowledge',
    icon: '📚',
    tint: 'rgba(142, 107, 242, 0.12)',
    nameKey: 'chat.tools.knowledge.name',
    descKey: 'chat.tools.knowledge.desc',
    promptKey: 'chat.tools.knowledge.prompt'
  },
  {
    key: 'writing',
    icon: '✍️',
    tint: 'rgba(171, 231, 213, 0.16)',
    nameKey: 'chat.tools.writing.name',
    descKey: 'chat.tools.writing.desc',
    promptKey: 'chat.tools.writing.prompt'
  }
]

export default function ChatPage(): React.JSX.Element {
  const { t } = useTranslation()
  const messages = useChatStore((s) => s.messages)
  const addUserMessage = useChatStore((s) => s.addUserMessage)
  const startAssistantMessage = useChatStore((s) => s.startAssistantMessage)
  const appendStreamDelta = useChatStore((s) => s.appendStreamDelta)
  const appendReasoningDelta = useChatStore((s) => s.appendReasoningDelta)
  const finalizeAssistantMessage = useChatStore((s) => s.finalizeAssistantMessage)
  const stopGenerating = useChatStore((s) => s.stopGenerating)
  const removeLastAssistant = useChatStore((s) => s.removeLastAssistant)
  const isGenerating = useChatStore((s) => s.isGenerating)

  const wsConnected = useAgentStore((s) => s.ready)
  const clearExecutionEvents = useAgentStore((s) => s.clearExecutionEvents)
  const skills = useSkillStore((s) => s.skills)
  const setSkills = useSkillStore((s) => s.setSkills)
  const activeSkill = useSkillStore((s) => s.activeSkill)
  const setActiveSkill = useSkillStore((s) => s.setActiveSkill)
  const meetingRec = useMeetingRecorder()

  const [inputText, setInputText] = useState('')
  const [uploading, setUploading] = useState(false)
  // 待发送附件:点上传/拖拽后先挂在此处,等用户输入文字一并发送(不立即入知识库)
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [listening, setListening] = useState(false)
  // 技能选择浮层开关
  const [skillMenuOpen, setSkillMenuOpen] = useState(false)
  const { importing: skillImporting, handleImport: handleSkillImport } = useSkillImport()
  // 待分流确认的项目记忆候选（null 表示当前无弹窗）
  const [candidate, setCandidate] = useState<MemoryCandidate | null>(null)
  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const recognitionRef = useRef<{
    streamId: string
    context: AudioContext
    source: MediaStreamAudioSourceNode
    processor: ScriptProcessorNode
    stream: MediaStream
    pollTimer: ReturnType<typeof setInterval>
  } | null>(null)
  const composerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const skillMenuRef = useRef<HTMLDivElement>(null)
  // 用户点「停止」后置 true,忽略本轮后续 streaming/final 帧;下次发送时复位
  const stoppedRef = useRef(false)
  // primer(历史回顾)回合进行中置 true:其 streaming/final 帧不进 UI、不落库;
  // 消费掉该回合的 final 后复位,使 primer 之后用户的正常消息不受影响
  const primerPendingRef = useRef(false)
  // 本轮流式回复归属的 chatId 快照:流式开始时记录,落库时使用,
  // 避免回复到达时用户已切换会话导致 onFinal 用实时 activeChatId 写错会话
  const streamOwnerChatIdRef = useRef<string>('')
  // 发送进行中守卫:覆盖新会话 waitForWsReady 等待窗口(此时 isGenerating 仍为 false),
  // 防止该窗口内重复回车对同一会话发出多条消息
  const sendingRef = useRef(false)

  // 工具箱磁贴点击:填充输入框并聚焦(纯前端引导,不直接发送)
  const fillPrompt = useCallback((prompt: string) => {
    setInputText(prompt)
    textareaRef.current?.focus()
  }, [])

  // PPT 入口:激活 ppt 技能并把结构化 prompt 填入输入框,由用户确认后发送
  const onGeneratePpt = useCallback(
    (prompt: string) => {
      const ppt = skills.find((s) => s.id === 'ppt')
      if (!ppt) {
        toast.error(t('chat.ppt.needSkill'))
        return
      }
      // 显式激活当前 chatId 的 ppt 技能
      const chatId = useChatStore.getState().activeChatId
      if (chatId) {
        void window.api.agentSkill.activate(chatId, 'ppt')
      }
      setActiveSkill('ppt')
      fillPrompt(prompt)
    },
    [skills, setActiveSkill, fillPrompt, t]
  )

  useEffect(() => {
    if (skills.length > 0) return
    skillsAPI
      .list()
      .then((data) => setSkills(data.skills ?? []))
      .catch(() => {})
  }, [skills.length, setSkills])

  useEffect(() => {
    const sessionKey = useChatStore.getState().activeChatId || 'default'

    // IPC 模式 connect 同步即用,无 auth 握手。会话就绪后若有 primer(历史回顾)则补发,
    // 用于重建服务端上下文:其回流帧不进 UI、不落库,避免产生无 user 对应的孤儿 assistant 行。
    const primeSession = (): void => {
      const primer = useChatStore.getState().pendingPrimer
      if (primer) {
        primerPendingRef.current = true
        agentWs.sendMessage(primer)
        useChatStore.getState().setPendingPrimer('')
      }
    }

    // 本轮 streaming 帧统计:用于判断后端是逐段下发(流式)还是只发 final(伪流式)
    let streamFrameCount = 0
    let streamCharCount = 0

    const onStreaming = (payload: Record<string, unknown>): void => {
      if (stoppedRef.current) return
      // primer 回合:丢弃所有流式帧,不建气泡、不累积
      if (primerPendingRef.current) return
      if (!useChatStore.getState().isGenerating) {
        streamOwnerChatIdRef.current = useChatStore.getState().activeChatId
        startAssistantMessage()
        streamFrameCount = 0
        streamCharCount = 0
      }
      const text = getPayloadText(payload)
      if (!text) return

      streamFrameCount++
      streamCharCount += text.length
      logger.info(
        `[chat:onStreaming] 第${streamFrameCount}帧 reasoning=${isReasoningPayload(payload)} 本帧长度=${text.length} 累计=${streamCharCount}`
      )

      if (isReasoningPayload(payload)) {
        appendReasoningDelta(text)
      } else {
        appendStreamDelta(text)
      }
    }

    const onFinal = (payload: Record<string, unknown>): void => {
      if (stoppedRef.current) return
      // primer 回合的 final:消费掉这一轮即解除抑制,不 finalize、不落库直接返回。
      // 在 final 复位可覆盖「多帧 streaming + 一个 final」与「仅 final 无 streaming」两种情况。
      if (primerPendingRef.current) {
        primerPendingRef.current = false
        return
      }
      // 非流式回复(只有 final 帧、无 streaming 增量)时, 先建占位气泡, 否则 finalize 无目标导致回复不显示
      if (!useChatStore.getState().isGenerating) {
        streamOwnerChatIdRef.current = useChatStore.getState().activeChatId
        startAssistantMessage()
      }
      const finalText = getPayloadText(payload)
      logger.info(
        `[chat:onFinal] 最终回复长度=${finalText.length} 本轮streaming帧数=${streamFrameCount} ` +
          `${streamFrameCount === 0 ? '⚠️ 后端未下发流式增量帧(伪流式)' : '✓ 后端逐段下发(真流式)'} ` +
          `预览=${finalText.slice(0, 40)}`
      )
      streamFrameCount = 0
      streamCharCount = 0
      finalizeAssistantMessage(finalText)

      const state = useChatStore.getState()
      // 落库归属本轮流式开始时的会话, 而非到达时的 activeChatId(用户可能已切换会话)
      const chatId = streamOwnerChatIdRef.current || state.activeChatId
      const last = state.messages[state.messages.length - 1]
      // 仅在内容非空时落库, 避免空 final 持久化空 assistant 气泡
      if (chatId && last && last.role === 'assistant' && last.content.trim()) {
        void db.session.appendMessage({
          chatId,
          role: 'assistant',
          content: last.content,
          reasoning: last.reasoning ?? null
        })
      }
      streamOwnerChatIdRef.current = ''

      const userMessages = state.messages.filter((m) => m.role === 'user')
      if (userMessages.length === 1 && chatId) {
        const session = state.sessions.find((s) => s.chatId === chatId)
        if (session && (!session.title || session.title === '新对话')) {
          const raw = userMessages[0].content
          const cleaned = raw
            .replace(CHINESE_OUTPUT_DIRECTIVE, '')
            .replace(/^用户任务：\n?/, '')
            .trim()
          void applySessionTitle(chatId, cleaned)
        }
      }
    }

    const onDisconnected = (): void => {
      // IPC 模式 ready 由 runtime 装配态决定,断开客户端包装不改 ready(runtime 仍在)
      // Drop primer suppression on disconnect: the primer-turn final may never
      // arrive after a drop, and leaving it set would swallow later replies.
      primerPendingRef.current = false
      // 断线时若正在生成, 服务端那次推理已无法回流: 定格当前流式气泡并复位生成态,
      // 否则 isGenerating/isStreaming 永真, 界面卡在"思考中"且无法再发送消息
      if (useChatStore.getState().isGenerating) {
        stopGenerating()
        streamOwnerChatIdRef.current = ''
        toast.error('连接已断开，本次回复已中断')
      }
    }

    const onProgress = (payload: Record<string, unknown>): void => {
      if (primerPendingRef.current) return
      // 用户已点停止: 不再累积工具调用/记忆/引用事件(后端推理可能仍在跑)
      if (stoppedRef.current) return
      const meta = payload.metadata as Record<string, unknown> | undefined
      if (!meta) return
      const type = meta.progress_type as string

      if (type === 'tool_call' || type === 'tool_result') {
        useAgentStore.getState().addToolCall({
          id: `tc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          tool: (meta.tool as string) ?? '',
          args: type === 'tool_call' ? ((meta.args as string) ?? '') : '',
          status:
            type === 'tool_result'
              ? 'done'
              : ((meta.status as 'started' | 'done' | 'error') ?? 'started'),
          result: type === 'tool_result' ? ((meta.result_preview as string) ?? '') : undefined,
          durationMs: type === 'tool_result' ? (meta.duration_ms as number) : undefined,
          timestamp: Date.now()
        })
      } else if (type === 'memory_retrieved') {
        useAgentStore
          .getState()
          .setRetrievedMemories(
            (meta.entries as Array<{ id: string; content: string; tier: string }>) ?? []
          )
      } else if (type === 'knowledge_cited') {
        useAgentStore
          .getState()
          .setCitations(
            (meta.citations as Array<{ path: string; chunk: string; score: number }>) ?? []
          )
      }
    }

    agentWs.on('message.streaming', onStreaming)
    agentWs.on('message.final', onFinal)
    agentWs.on('message.progress', onProgress)
    agentWs.on('_disconnected', onDisconnected)

    // IPC 模式: connect 立即可用,无需等待 auth;连接后立刻补发 primer
    agentWs.connect('', sessionKey || 'default')
    primeSession()

    return () => {
      agentWs.off('message.streaming', onStreaming)
      agentWs.off('message.final', onFinal)
      agentWs.off('message.progress', onProgress)
      agentWs.off('_disconnected', onDisconnected)
      agentWs.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (messages.length === 0) return
    virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, behavior: 'smooth' })
  }, [messages.length])

  // 点击技能浮层外部时关闭
  useEffect(() => {
    if (!skillMenuOpen) return
    const onPointerDown = (e: PointerEvent): void => {
      if (skillMenuRef.current && !skillMenuRef.current.contains(e.target as Node)) {
        setSkillMenuOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [skillMenuOpen])

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        clearInterval(recognitionRef.current.pollTimer)
        recognitionRef.current.processor.disconnect()
        recognitionRef.current.source.disconnect()
        recognitionRef.current.stream.getTracks().forEach((t) => t.stop())
        recognitionRef.current.context.close()
        window.api.asr.stop(recognitionRef.current.streamId)
      }
    }
  }, [])

  // 实际发送一段用户文本到 agent(注入项目记忆 + 中文指令);供首次发送与重新生成复用
  const dispatchToAgent = useCallback(
    async (text: string, attachments?: Array<{ id: string; name: string }>) => {
      stoppedRef.current = false
      // Any real user send clears primer suppression, so a missing primer-turn
      // final can never permanently swallow subsequent replies.
      primerPendingRef.current = false
      clearExecutionEvents()
      const memoryContext = await buildProjectMemoryContext(text)
      const outbound = buildOutboundText(text, activeSkill)
      const finalText = memoryContext ? `${memoryContext}\n\n${outbound}` : outbound
      agentWs.sendMessage(finalText, attachments)
    },
    [activeSkill, clearExecutionEvents]
  )

  const handleSend = useCallback(async () => {
    const text = inputText.trim()
    const readyAttachments = pendingAttachments.filter((a) => a.status === 'ready')
    const stillUploading = pendingAttachments.some((a) => a.status === 'uploading')
    // 可发送条件:有文本或有就绪附件;附件仍在上传中时拦截,提示等待
    if ((!text && readyAttachments.length === 0) || !wsConnected || isGenerating) return
    if (stillUploading) {
      toast.error('附件仍在上传中，请稍候')
      return
    }
    // 发送守卫: 新会话路径存在 waitForWsReady 等待窗口(此时 isGenerating 仍为 false),
    // 没有该守卫的话窗口内重复回车会对同一会话重复发送
    if (sendingRef.current) return
    sendingRef.current = true
    try {
      const outboundAttachments = readyAttachments.map((a) => ({ id: a.remoteId!, name: a.name }))
      let chatId = useChatStore.getState().activeChatId
      let isNewSession = false
      if (!chatId) {
        isNewSession = true
        chatId = crypto.randomUUID()
        try {
          await db.session.upsert({ chatId, title: '新对话', platform: 'desktop' })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          logger.warn('[chat] 创建会话写库失败:', message)
          toast.error(`创建会话失败：${message}`)
          return
        }
        useChatStore.getState().setActiveChatId(chatId)
        useAgentStore.getState().setCurrentSessionKey(chatId)
        // Brand-new session: drop any primer prepared for a previously opened session
        useChatStore.getState().setPendingPrimer('')
        await useChatStore.getState().loadSessionsFromLocal()
        // 新建会话需让 socket 以新 chatId 重新 auth,否则首条消息仍发到旧 chatId(如 'default')
        agentWs.switchSession(chatId)
      }
      addUserMessage(text, outboundAttachments)
      // 写库失败不阻断聊天:消息照常发往 agent、输入框照常清空
      // 附件名追加到落库内容,便于历史回看时知道本轮带了哪些文件
      const persistedContent = outboundAttachments.length
        ? `${text}${text ? '\n' : ''}[附件] ${outboundAttachments.map((a) => a.name).join('、')}`
        : text
      void db.session
        .appendMessage({ chatId, role: 'user', content: persistedContent })
        .catch((err) => logger.warn('[chat] 用户消息写库失败:', err))
      setInputText('')
      setPendingAttachments([])
      if (isNewSession) {
        // switchSession 异步重连,等新连接 auth 成功(OPEN)后再发,避免被静默丢弃
        const ready = await waitForWsReady()
        if (!ready) {
          toast.error('连接未就绪，消息发送失败，请重试')
          return
        }
      }
      await dispatchToAgent(text, outboundAttachments)
    } finally {
      sendingRef.current = false
    }
  }, [inputText, pendingAttachments, wsConnected, isGenerating, addUserMessage, dispatchToAgent])

  // 停止生成:前端侧定格当前流式消息并忽略后续帧(WS 协议无中断帧,后端推理可能仍在跑)
  const handleStop = useCallback(() => {
    stoppedRef.current = true
    stopGenerating()
    const s = useChatStore.getState()
    const chatId = s.activeChatId
    const last = s.messages[s.messages.length - 1]
    if (chatId && last && last.role === 'assistant' && last.content.trim()) {
      void db.session.appendMessage({
        chatId,
        role: 'assistant',
        content: last.content,
        reasoning: last.reasoning ?? null
      })
    }
  }, [stopGenerating])

  // 重新生成:取最近一条 user 消息,删除最后一条 assistant 后重发
  const handleRegenerate = useCallback(async () => {
    if (!wsConnected || isGenerating) return
    const msgs = useChatStore.getState().messages
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
    if (!lastUser) return
    removeLastAssistant()
    // 同步删 DB 中最后一条 assistant 行,避免重做后旧+新两条并存(落库失败不阻断)
    const chatId = useChatStore.getState().activeChatId
    if (chatId) {
      void db.session
        .deleteLastAssistantMessage(chatId)
        .catch((err) => logger.warn('[chat] 重新生成删除旧 assistant 落库失败:', err))
    }
    await dispatchToAgent(lastUser.content)
  }, [wsConnected, isGenerating, removeLastAssistant, dispatchToAgent])

  // 分流确认：用户在 ShareMemoryDialog 选择后调用，写入结果并提示
  const handleMemoryDecide = useCallback(
    async (decision: 'share' | 'local' | 'discard') => {
      if (!candidate) return
      const current = candidate
      setCandidate(null)
      try {
        const { shared } = await confirmShareToProject(current, decision)
        if (shared) toast.success('已共享到项目记忆')
      } catch {
        toast.error('共享到项目记忆失败')
      }
    },
    [candidate]
  )

  // TODO(Task 11 联调): 候选来源待与 echo-agent 联调确定——
  // 目前 WS 协议尚未约定"值得共享的项目记忆候选"的下行信号，
  // 不臆造协议、不做假数据自动弹窗。届时在收到该信号处调用 setCandidate(candidate) 即可触发弹窗。

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  // 暂存并后台上传附件:点上传/拖拽即调用,文件先入 agent 媒体缓存拿到 remoteId,
  // 真正发送在 handleSend(连同输入文字一起发给 agent),不立即入知识库
  const stageAttachments = async (files: File[]): Promise<void> => {
    if (files.length === 0) return
    const staged: PendingAttachment[] = files.map((file) => ({
      localId: `att-${crypto.randomUUID()}`,
      name: file.name,
      size: file.size,
      status: 'uploading'
    }))
    setPendingAttachments((prev) => [...prev, ...staged])
    setUploading(true)
    try {
      await Promise.all(
        files.map(async (file, i) => {
          const localId = staged[i].localId
          try {
            const ref = await attachmentsAPI.upload(file)
            setPendingAttachments((prev) =>
              prev.map((a) =>
                a.localId === localId ? { ...a, status: 'ready', remoteId: ref.id } : a
              )
            )
          } catch (err) {
            logger.warn('[chat] 附件上传失败:', err)
            setPendingAttachments((prev) =>
              prev.map((a) => (a.localId === localId ? { ...a, status: 'error' } : a))
            )
            toast.error(`附件上传失败：${file.name}`)
          }
        })
      )
    } finally {
      setUploading(false)
    }
  }

  const removePendingAttachment = (localId: string): void => {
    setPendingAttachments((prev) => prev.filter((a) => a.localId !== localId))
  }

  const handleFileDrop = async (files: File[]): Promise<void> => {
    await stageAttachments(files)
  }

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    await stageAttachments(files)
  }

  const handleVoiceInput = async (): Promise<void> => {
    if (listening) {
      if (recognitionRef.current) {
        clearInterval(recognitionRef.current.pollTimer)
        recognitionRef.current.processor.disconnect()
        recognitionRef.current.source.disconnect()
        recognitionRef.current.stream.getTracks().forEach((t) => t.stop())
        recognitionRef.current.context.close()
        const finalText = await window.api.asr.stop(recognitionRef.current.streamId)
        if (finalText) {
          setInputText((current) => (current ? `${current}\n${finalText}` : finalText))
        }
        recognitionRef.current = null
      }
      setListening(false)
      return
    }

    const permissionStatus = await permission.request('microphone')
    if (permissionStatus !== 'granted') {
      toast.error('麦克风权限未开启')
      return
    }

    let mediaStream: MediaStream
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      toast.error('无法访问麦克风')
      return
    }

    try {
      const streamId = await window.api.asr.start()
      const context = new AudioContext({ sampleRate: 16000 })
      const source = context.createMediaStreamSource(mediaStream)
      const processor = context.createScriptProcessor(4096, 1, 1)

      processor.onaudioprocess = (e): void => {
        const inputData = e.inputBuffer.getChannelData(0)
        const samples = new Float32Array(inputData)
        window.api.asr.feed(streamId, samples)
      }

      source.connect(processor)
      processor.connect(context.destination)

      const pollTimer = setInterval(async () => {
        const text = await window.api.asr.getResult(streamId)
        if (text) {
          setInputText(text)
        }
      }, 300)

      recognitionRef.current = {
        streamId,
        context,
        source,
        processor,
        stream: mediaStream,
        pollTimer
      }
      setListening(true)
    } catch {
      mediaStream.getTracks().forEach((t) => t.stop())
      toast.error('语音识别启动失败')
    }
  }

  const hasReadyAttachment = pendingAttachments.some((a) => a.status === 'ready')
  const canSend =
    wsConnected && (inputText.trim().length > 0 || hasReadyAttachment)
  // 仅展示已启用的技能(未启用的后端不加载,选了也无效)
  // 当前会话已激活的技能 id(per chatId 激活,从主进程拉)
  const activeChatId = useChatStore((s) => s.activeChatId)
  const [activeSkillIds, setActiveSkillIds] = useState<string[]>([])
  useEffect(() => {
    const chatId = activeChatId || 'default'
    window.api.agentSkill
      .active(chatId)
      .then((ids) => setActiveSkillIds(ids as string[]))
      .catch(() => setActiveSkillIds([]))
  }, [activeChatId, skills])
  const enabledSkills = skills.filter((s) => activeSkillIds.includes(s.id))

  return (
    <div className={styles.page}>
      <div className={styles.chatArea}>
        <FileDropZone onDrop={handleFileDrop}>
          <div className={styles.messageList}>
            {messages.length === 0 && (
              <div className={styles.welcome}>
                <div className={styles.welcomeMark}>E</div>
                <h1 className={styles.welcomeTitle}>{t('chat.welcomeTitle')}</h1>
                <p className={styles.welcomeSubtitle}>
                  {wsConnected ? t('chat.welcomeSubtitle') : t('chat.waitingAgent')}
                </p>
                <div className={styles.toolbox}>
                  {TOOLBOX.map((tool) => (
                    <button
                      key={tool.key}
                      type="button"
                      className={styles.toolCard}
                      style={{ '--tool-tint': tool.tint } as React.CSSProperties}
                      onClick={() => fillPrompt(t(tool.promptKey))}
                      disabled={!wsConnected}
                    >
                      <span className={styles.toolIcon}>{tool.icon}</span>
                      <span className={styles.toolText}>
                        <span className={styles.toolName}>{t(tool.nameKey)}</span>
                        <span className={styles.toolDesc}>{t(tool.descKey)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <Virtuoso
              ref={virtuosoRef}
              data={messages}
              itemContent={(index, msg) => (
                <MessageBubble
                  message={msg}
                  onRegenerate={
                    msg.role === 'assistant' && index === messages.length - 1 && !isGenerating
                      ? () => void handleRegenerate()
                      : undefined
                  }
                />
              )}
              followOutput="smooth"
              className={styles.virtuoso}
            />
          </div>
        </FileDropZone>

        <div className={styles.composer} ref={composerRef}>
          {pendingAttachments.length > 0 && (
            <div className={styles.attachmentBar}>
              {pendingAttachments.map((att) => (
                <div
                  key={att.localId}
                  className={`${styles.attachmentChip} ${
                    att.status === 'error' ? styles.attachmentError : ''
                  }`}
                  title={att.name}
                >
                  <span className={styles.attachmentIcon} aria-hidden="true">
                    {att.status === 'uploading' ? '⏳' : att.status === 'error' ? '⚠️' : '📎'}
                  </span>
                  <span className={styles.attachmentName}>{att.name}</span>
                  {att.status === 'uploading' && (
                    <span className={styles.attachmentStatus}>上传中</span>
                  )}
                  {att.status === 'error' && (
                    <span className={styles.attachmentStatus}>失败</span>
                  )}
                  <button
                    type="button"
                    className={styles.attachmentRemove}
                    onClick={() => removePendingAttachment(att.localId)}
                    aria-label={`移除附件 ${att.name}`}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className={styles.input}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              wsConnected
                ? '今天帮你做些什么？@ 引用对话文件，/ 调用技能与指令'
                : '等待 Agent 连接...'
            }
            disabled={!wsConnected}
            rows={4}
          />
          <div className={styles.composerBar}>
            <div className={styles.composerTools}>
              <PptComposer disabled={!wsConnected} onGenerate={onGeneratePpt} />
              <div className={styles.skillPicker} ref={skillMenuRef}>
                <button
                  type="button"
                  className={`${styles.skillTrigger} ${activeSkill ? styles.skillActive : ''}`}
                  onClick={() => setSkillMenuOpen((v) => !v)}
                  title={
                    activeSkill ? `${t('chat.skill.using')}: ${activeSkill}` : t('chat.skill.pick')
                  }
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M12 3 4 7v6c0 4.5 3.4 7.3 8 8 4.6-.7 8-3.5 8-8V7l-8-4Z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <span>{activeSkill ?? t('chat.skill.label')}</span>
                  {activeSkill && (
                    <span
                      className={styles.skillClear}
                      role="button"
                      aria-label={t('chat.skill.clear')}
                      onClick={(e) => {
                        e.stopPropagation()
                        setActiveSkill(null)
                        setSkillMenuOpen(false)
                      }}
                    >
                      ✕
                    </span>
                  )}
                </button>
                {skillMenuOpen && (
                  <div className={styles.skillMenu}>
                    <button
                      type="button"
                      className={styles.skillImport}
                      disabled={skillImporting}
                      onClick={() => void handleSkillImport()}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                        <path
                          d="M12 4v11m0 0 4-4m-4 4-4-4M5 19h14"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      {skillImporting ? '导入中…' : t('chat.skill.import')}
                    </button>
                    {enabledSkills.length === 0 ? (
                      <div className={styles.skillEmpty}>{t('chat.skill.empty')}</div>
                    ) : (
                      enabledSkills.map((s) => (
                        <button
                          key={s.id}
                          type="button"
                          className={`${styles.skillItem} ${
                            activeSkill === s.id ? styles.skillItemActive : ''
                          }`}
                          onClick={() => {
                            setActiveSkill(activeSkill === s.id ? null : s.id)
                            setSkillMenuOpen(false)
                          }}
                        >
                          <span className={styles.skillItemName}>{s.label}</span>
                          {(skillDescriptionsZh[s.id] ?? s.description) && (
                            <span className={styles.skillItemDesc}>
                              {skillDescriptionsZh[s.id] ?? s.description}
                            </span>
                          )}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
              <MeetingButton disabled={!wsConnected} onStart={() => void meetingRec.start()} />
              <ScopeSwitcher />
            </div>
            <div className={styles.composerActions}>
              <button
                className={styles.iconBtn}
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                title={uploading ? '上传中' : '添加附件'}
                aria-label={uploading ? '上传中' : '添加附件'}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M12 5v14m-7-7h14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button
                className={`${styles.iconBtn} ${listening ? styles.listening : ''}`}
                onClick={handleVoiceInput}
                title={listening ? '停止语音输入' : '语音输入'}
                aria-label={listening ? '停止语音输入' : '语音输入'}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  />
                  <path
                    d="M5 11a7 7 0 0 0 14 0M12 18v3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              {isGenerating ? (
                <button
                  className={styles.stopBtn}
                  onClick={handleStop}
                  title={t('chat.stop')}
                  aria-label={t('chat.stop')}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
                  </svg>
                </button>
              ) : (
                <button
                  className={styles.sendBtn}
                  onClick={() => void handleSend()}
                  disabled={!canSend}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      d="M5 12h13m0 0-5-5m5 5-5 5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={handleFileInputChange}
            />
          </div>
        </div>
      </div>
      {candidate && <ShareMemoryDialog candidate={candidate} onDecide={handleMemoryDecide} />}
      <LivePanel />
    </div>
  )
}
