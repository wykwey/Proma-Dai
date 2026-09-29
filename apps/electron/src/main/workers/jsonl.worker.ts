/**
 * 会话 JSONL 解析 worker
 *
 * 只负责「读文件 + 逐行 JSON.parse」，路径由主进程解析后传入（config-paths 依赖
 * Electron app.getPath，不能进 worker）。
 */

import { existsSync } from 'node:fs'
import {
  readAgentMessagesFile,
  readAgentSdkMessagesFile,
  readChatMessagesFile,
  readRecentChatMessagesFile,
} from '../lib/jsonl-parse'
import { serveWorker } from './worker-bootstrap'

interface FilePayload {
  op: string
  filePath: string
  /** 主进程侧实体 ID，仅用于日志可读性 */
  id?: string
  /** chatRecentMessages 专用 */
  limit?: number
}

serveWorker({
  name: 'jsonl',
  handlers: {
    agentMessages: (payload) => {
      const { filePath, id } = payload as FilePayload
      if (!existsSync(filePath)) return []
      return readAgentMessagesFile(filePath, id ?? filePath)
    },

    agentSdkMessages: (payload) => {
      const { filePath, id } = payload as FilePayload
      if (!existsSync(filePath)) return []
      return readAgentSdkMessagesFile(filePath, id ?? filePath)
    },

    chatMessages: (payload) => {
      const { filePath } = payload as FilePayload
      if (!existsSync(filePath)) return []
      return readChatMessagesFile(filePath)
    },

    chatRecentMessages: (payload) => {
      const { filePath, limit = 0 } = payload as FilePayload
      if (!existsSync(filePath)) return { messages: [], total: 0, hasMore: false }
      return readRecentChatMessagesFile(filePath, limit)
    },
  },
})
