/**
 * 会话 JSONL 读取的 worker 客户端
 *
 * 主进程只负责解析出文件路径（config-paths 依赖 Electron），真正的读文件与逐行
 * JSON.parse 交给 worker。长会话 JSONL 可达几十 MB / 数万行，同步执行会冻结主进程
 * 事件循环，表现为「打开长会话时整个界面卡住」。
 *
 * 在 dist/workers 缺失（开发态、bun test 直接跑 TS 源码）时自动降级为进程内执行，
 * 语义完全一致，只是拿不到并发收益。
 */

import type { AgentMessage, ChatMessage, SDKMessage } from '@proma/shared'
import {
  readAgentMessagesFile,
  readAgentSdkMessagesFile,
  readChatMessagesFile,
  readRecentChatMessagesFile,
} from './jsonl-parse'
import { createWorkerTask } from './worker-pool'
import type { RecentMessagesResult } from '@proma/shared'

type JsonlPayload =
  | { op: 'agentMessages'; filePath: string; id: string }
  | { op: 'agentSdkMessages'; filePath: string; id: string }
  | { op: 'chatMessages'; filePath: string }
  | { op: 'chatRecentMessages'; filePath: string; limit: number }

/** 降级实现：与 worker 侧调用完全相同的纯函数 */
function runInProcess(payload: JsonlPayload): unknown {
  switch (payload.op) {
    case 'agentMessages':
      return readAgentMessagesFile(payload.filePath, payload.id)
    case 'agentSdkMessages':
      return readAgentSdkMessagesFile(payload.filePath, payload.id)
    case 'chatMessages':
      return readChatMessagesFile(payload.filePath)
    case 'chatRecentMessages':
      return readRecentChatMessagesFile(payload.filePath, payload.limit)
  }
}

const jsonlWorker = createWorkerTask<JsonlPayload, unknown>({
  name: 'jsonl',
  fallback: runInProcess,
})

export function readAgentMessagesInWorker(filePath: string, sessionId: string): Promise<AgentMessage[]> {
  return jsonlWorker.run({ op: 'agentMessages', filePath, id: sessionId }) as Promise<AgentMessage[]>
}

export function readAgentSdkMessagesInWorker(filePath: string, sessionId: string): Promise<SDKMessage[]> {
  return jsonlWorker.run({ op: 'agentSdkMessages', filePath, id: sessionId }) as Promise<SDKMessage[]>
}

export function readChatMessagesInWorker(filePath: string): Promise<ChatMessage[]> {
  return jsonlWorker.run({ op: 'chatMessages', filePath }) as Promise<ChatMessage[]>
}

export function readRecentChatMessagesInWorker(filePath: string, limit: number): Promise<RecentMessagesResult> {
  return jsonlWorker.run({ op: 'chatRecentMessages', filePath, limit }) as Promise<RecentMessagesResult>
}

/** 应用退出时释放 worker 线程 */
export function disposeJsonlWorker(): void {
  jsonlWorker.dispose()
}
