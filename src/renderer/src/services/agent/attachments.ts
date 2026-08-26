import { agentManagement } from './management'

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
   * 走 Agent 管理 API 的二进制桥接，渲染层不直接接触 Gateway 凭证。
   */
  upload: async (file: File): Promise<ChatAttachmentRef> => {
    return agentManagement<ChatAttachmentRef>({
      method: 'POST',
      path: '/chat/attachments',
      file: {
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        data: new Uint8Array(await file.arrayBuffer())
      }
    })
  }
}
