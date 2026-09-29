/**
 * JSONL 解析的纯逻辑层
 *
 * 抽出来的原因：主进程和 worker 线程都要用同一份实现。
 * - 主进程侧只保留「写路径」需要的严格解析（见 agent-session-manager 的
 *   truncateSDKMessages / removeSDKErrorMessage）——那里是读-改-写，必须保持同
 *   一个 tick 内完成，不能被 await 打断，否则会破坏原子性。
 * - 读路径（打开会话、构建完成载荷、检索）交给 worker，这里就是 worker 用的实现。
 *
 * 本文件不得 import Electron 或任何主进程专属模块，否则 worker 无法加载。
 */

import { readFileSync } from 'node:fs'
import type { AgentMessage, ChatMessage, SDKMessage } from '@proma/shared'
import { convertLegacyMessage } from '@proma/session-core'

export interface JsonlParseError {
  lineNumber: number
  message: string
}

/**
 * 逐行解析 JSONL，调用方按业务场景决定容错或严格失败。
 */
export function parseJsonlLines<T>(lines: string[]): { records: T[]; errors: JsonlParseError[] } {
  const records: T[] = []
  const errors: JsonlParseError[] = []
  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]!) as T)
    } catch (err) {
      errors.push({
        lineNumber: i + 1,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { records, errors }
}

/**
 * 展示/检索类读取：跳过损坏行，保留其它可读消息。
 */
export function parseJsonlLenient<T>(lines: string[], context: string): T[] {
  const { records, errors } = parseJsonlLines<T>(lines)
  for (const error of errors) {
    console.warn(`[Agent 会话] ${context} — JSONL 第 ${error.lineNumber} 行解析失败，已跳过:`, error.message)
  }
  return records
}

/**
 * 回退/文件恢复类读取：任何损坏行都可能破坏消息顺序或快照完整性，必须停止。
 */
export function parseJsonlStrict<T>(lines: string[], context: string): T[] {
  const { records, errors } = parseJsonlLines<T>(lines)
  if (errors.length > 0) {
    const first = errors[0]!
    throw new Error(`${context} 失败：JSONL 第 ${first.lineNumber} 行解析失败: ${first.message}`)
  }
  return records
}

/**
 * 旧格式（AgentMessage，有 `role` 字段）→ SDKMessage。
 * 新格式（有 `type` 字段）原样返回。
 */
export function normalizePersistedSDKMessage(parsed: unknown): SDKMessage {
  if (parsed && typeof parsed === 'object' && 'role' in parsed && !('type' in parsed)) {
    return convertLegacyMessage(parsed as AgentMessage)
  }
  return parsed as SDKMessage
}

/** 读取文件并按行切分，过滤空行。文件不存在由调用方先行判断。 */
function readJsonlLines(filePath: string): string[] {
  const raw = readFileSync(filePath, 'utf-8')
  return raw.split('\n').filter((line) => line.trim())
}

/** 读取并解析 Agent 会话消息（AgentMessage 格式） */
export function readAgentMessagesFile(filePath: string, sessionId: string): AgentMessage[] {
  return parseJsonlLenient<AgentMessage>(readJsonlLines(filePath), `读取会话消息 (${sessionId})`)
}

/** 读取并解析 Agent 会话消息（SDKMessage 格式，兼容旧 AgentMessage） */
export function readAgentSdkMessagesFile(filePath: string, sessionId: string): SDKMessage[] {
  return parseJsonlLenient<unknown>(readJsonlLines(filePath), `读取 SDKMessage (${sessionId})`).map(normalizePersistedSDKMessage)
}

/** 读取并解析 Chat 对话的全部消息 */
export function readChatMessagesFile(filePath: string): ChatMessage[] {
  return readJsonlLines(filePath).map((line) => JSON.parse(line) as ChatMessage)
}

/**
 * 读取 Chat 对话的最近 N 条消息。
 *
 * 仍然要把整个文件读进来才能知道总行数，因此这里保留了「尾部切片只解析 limit 行」
 * 的既有优化：解析成本与 limit 成正比，与文件长度无关。
 */
export function readRecentChatMessagesFile(
  filePath: string,
  limit: number,
): { messages: ChatMessage[]; total: number; hasMore: boolean } {
  const lines = readJsonlLines(filePath)
  const total = lines.length
  if (total <= limit) {
    return { messages: lines.map((line) => JSON.parse(line) as ChatMessage), total, hasMore: false }
  }
  const messages = lines.slice(-limit).map((line) => JSON.parse(line) as ChatMessage)
  return { messages, total, hasMore: true }
}
