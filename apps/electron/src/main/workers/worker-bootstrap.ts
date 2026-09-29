/**
 * worker 侧通用引导
 *
 * 每个 worker 入口只需提供「任务名 → 处理函数」的映射，由本模块负责：
 * - 挂载 parentPort 监听
 * - 把 console 输出转发到主进程（worker 的 console 不会自动出现在主进程日志里）
 * - 统一异常包装，让主进程侧拿到 message 而不是一个被吞掉的 rejection
 */

import { parentPort } from 'node:worker_threads'
import type { WorkerLogLevel, WorkerRequestMessage, WorkerResponseMessage } from '../lib/worker-protocol'

export type WorkerHandler = (payload: unknown) => unknown | Promise<unknown>

export interface WorkerServeOptions {
  /** 任务名，仅用于日志前缀 */
  name: string
  /** 任务名 → 处理函数 */
  handlers: Record<string, WorkerHandler>
}

/** 把 console 的方法名映射到协议里的日志等级 */
const CONSOLE_METHODS: Record<string, WorkerLogLevel> = {
  log: 'log',
  info: 'log',
  warn: 'warn',
  error: 'error',
  debug: 'log',
}

/**
 * 启动 worker 消息循环。
 *
 * 必须在 worker 入口顶层调用，否则 parentPort 无人监听、请求会永远挂起。
 */
export function serveWorker(options: WorkerServeOptions): void {
  const port = parentPort
  if (!port) {
    throw new Error(`[worker:${options.name}] 未在 worker 线程中运行，parentPort 不可用`)
  }

  const LOG_PREFIX = `[worker:${options.name}]`
  const originalConsole: Record<string, (...args: unknown[]) => void> = {}
  for (const method of Object.keys(CONSOLE_METHODS)) {
    const level = CONSOLE_METHODS[method]!
    originalConsole[method] = ((...args: unknown[]) => {
      const text = args
        .map((arg) => (typeof arg === 'string' ? arg : safeStringify(arg)))
        .join(' ')
      port.postMessage({ type: 'log', level, text: `${LOG_PREFIX} ${text}` } satisfies WorkerResponseMessage)
    }) as (...args: unknown[]) => void
    // 不依赖 worker 侧模块解析成功也能转发日志
    ;(console as unknown as Record<string, unknown>)[method] = originalConsole[method]
  }

  port.on('message', (message: WorkerRequestMessage) => {
    void handle(message)
  })

  async function handle(message: WorkerRequestMessage): Promise<void> {
    const { id, payload } = message
    try {
      const taskName = (payload as { op?: string } | null)?.op
      if (!taskName) {
        throw new Error('缺少 op 字段')
      }
      const handler = options.handlers[taskName]
      if (!handler) {
        throw new Error(`未知的 op: ${taskName}`)
      }
      const result = await handler(payload)
      port!.postMessage({ id, ok: true, result } satisfies WorkerResponseMessage)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      port!.postMessage({
        id,
        ok: false,
        error: { name: err.name, message: err.message },
      } satisfies WorkerResponseMessage)
    }
  }
}

/** 日志转发用的安全序列化，避免循环引用把日志本身炸掉 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
