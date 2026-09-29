/**
 * 主进程 ↔ worker_threads 的消息协议
 *
 * 主进程与 worker 双向引用同一份定义，避免两侧字段名漂移导致静默丢消息。
 */

/** 主进程 → worker：一次任务请求 */
export interface WorkerRequestMessage {
  /** 自增请求 ID，用于把响应配对回 Promise */
  id: number
  /** 任务载荷，由各 worker 自行约定结构 */
  payload: unknown
}

/** worker 日志转发的等级，与 console 方法名一一对应 */
export type WorkerLogLevel = 'log' | 'warn' | 'error'

/**
 * worker → 主进程的消息。
 *
 * 带 `id` 的是任务响应，带 `type: 'log'` 的是日志转发。
 * worker 的 console 默认不会出现在主进程日志里，必须显式转发，否则排障会瞎。
 */
export type WorkerResponseMessage =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { name?: string; message: string } }
  | { type: 'log'; level: WorkerLogLevel; text: string }

/** 判断一条 worker 消息是否为日志转发 */
export function isWorkerLogMessage(message: WorkerResponseMessage): message is Extract<WorkerResponseMessage, { type: 'log' }> {
  return (message as { type?: string }).type === 'log'
}
