import { AgentApiUrls } from '@/request/urls'
import { useAgentStore } from '@/stores/agentStore'

async function getBaseUrl(): Promise<string> {
  const endpoint = await window.api.echoAgent.getEndpoint()
  if (!endpoint?.baseUrl) {
    throw new Error('Agent 未就绪')
  }
  return endpoint.baseUrl
}

/** 后端 /chat/attachments 返回的附件引用，用于随后在 WS message 帧中携带 */
export interface ChatAttachmentRef {
  id: string
  name: string
  mime_type: string
  size: number
}

export const attachmentsAPI = {
  /**
   * 上传一个聊天附件到 agent 媒体缓存（非持久知识库），返回引用。
   * 引用的 id 随后随 WS message 帧发送，后端据此还原本地路径并在本轮抽取/读取。
   * 走 multipart fetch（与 knowledgeAPI.upload 一致），axios 封装不便处理文件流。
   */
  upload: async (file: File): Promise<ChatAttachmentRef> => {
    const { remoteToken } = useAgentStore.getState()
    const baseUrl = await getBaseUrl()
    const form = new FormData()
    form.append('file', file)
    const resp = await fetch(`${baseUrl}${AgentApiUrls.chatAttachmentUpload}`, {
      method: 'POST',
      headers: remoteToken ? { 'X-Echo-Agent-Token': remoteToken } : undefined,
      body: form
    })
    if (!resp.ok) {
      throw new Error(`附件上传失败 HTTP ${resp.status}`)
    }
    return resp.json() as Promise<ChatAttachmentRef>
  }
}
