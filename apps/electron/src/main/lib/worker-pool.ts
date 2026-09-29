/**
 * 主进程 worker_threads 任务池
 *
 * 背景：Electron 主进程是单线程事件循环，任何同步 readFileSync + 逐行 JSON.parse
 * 或纯 CPU 解析都会冻结全部 IPC、Agent 流式输出和窗口交互。本模块把这类重活挪到
 * worker 线程，并复用同一个池避免反复创建线程。
 *
 * 关键约束：
 * - 主进程产物是 CJS（dist/main.cjs），没有 import.meta.url，因此用 __dirname 定位
 *   worker 文件（dist/workers/<name>.worker.cjs）。
 * - 开发态或单测里 dist/workers 可能根本不存在（bun test 直接跑 TS 源码）。此时回退到
 *   进程内实现：功能一致，只是拿不到并发收益。这条降级路径是必需的，否则单测会因缺文件
 *   而整体失败。
 * - worker 崩溃、超时、退出都必须能拒绝在途请求并自动重建，不能让调用方永久挂起。
 */

import { existsSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  isWorkerLogMessage,
  type WorkerRequestMessage,
  type WorkerResponseMessage,
} from './worker-protocol'

export interface WorkerTaskOptions<TPayload, TResult> {
  /** 任务名，同时决定 worker 文件名 dist/workers/<name>.worker.cjs */
  name: string
  /** worker 不可用时的进程内实现，语义必须与 worker 侧一致 */
  fallback: (payload: TPayload) => TResult | Promise<TResult>
  /** 并发 worker 上限，默认 availableParallelism() - 1（至少 1），留一核给主进程 */
  maxWorkers?: number
  /** 单任务超时（ms），<= 0 表示不超时 */
  timeoutMs?: number
}

export interface WorkerTask<TPayload, TResult> {
  run(payload: TPayload): Promise<TResult>
  /** 终止所有 worker 并拒绝排队中的任务；应用退出前应调用 */
  dispose(): void
  /** 当前是否真的在跑 worker（false 表示已降级到进程内实现），用于日志与自检 */
  isWorkerBacked(): boolean
}

interface QueuedTask {
  payload: unknown
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface InflightTask {
  id: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer?: NodeJS.Timeout
}

/** 计算默认并发上限：留一核给主进程与渲染进程 */
function defaultMaxWorkers(): number {
  return Math.max(1, availableParallelism() - 1)
}

export function createWorkerTask<TPayload, TResult>(
  options: WorkerTaskOptions<TPayload, TResult>,
): WorkerTask<TPayload, TResult> {
  const workerFile = join(__dirname, 'workers', `${options.name}.worker.cjs`)
  const maxWorkers = Math.max(1, options.maxWorkers ?? defaultMaxWorkers())
  const timeoutMs = options.timeoutMs ?? 0

  const allWorkers = new Set<Worker>()
  const idleWorkers: Worker[] = []
  const inflight = new Map<Worker, InflightTask>()
  const queue: QueuedTask[] = []

  /** 首次 run 时才探测文件，避免模块加载期做无谓的 fs 调用 */
  let workerAvailable: boolean | null = null
  let nextRequestId = 1
  let disposed = false

  function canUseWorker(): boolean {
    if (disposed) return false
    if (workerAvailable === null) {
      workerAvailable = existsSync(workerFile)
      if (!workerAvailable) {
        console.warn(
          `[worker:${options.name}] 未找到 ${workerFile}，已降级为主进程内执行（重活会占用事件循环）`,
        )
      }
    }
    return workerAvailable
  }

  function retireWorker(worker: Worker, error: Error): void {
    allWorkers.delete(worker)
    const idleIndex = idleWorkers.indexOf(worker)
    if (idleIndex >= 0) idleWorkers.splice(idleIndex, 1)

    const task = inflight.get(worker)
    if (task) {
      inflight.delete(worker)
      if (task.timer) clearTimeout(task.timer)
      task.reject(error)
    }
    pump()
  }

  function spawnWorker(): Worker {
    const worker = new Worker(workerFile)
    allWorkers.add(worker)

    worker.on('message', (message: WorkerResponseMessage) => {
      if (isWorkerLogMessage(message)) {
        const log = message.level === 'error' ? console.error : message.level === 'warn' ? console.warn : console.log
        log(message.text)
        return
      }

      const task = inflight.get(worker)
      // 迟到的响应（超时后被 terminate 的旧请求）直接丢弃
      if (!task || task.id !== message.id) return

      inflight.delete(worker)
      if (task.timer) clearTimeout(task.timer)

      if (message.ok) {
        task.resolve(message.result)
      } else {
        const error = new Error(message.error.message)
        error.name = message.error.name ?? 'Error'
        task.reject(error)
      }

      idleWorkers.push(worker)
      pump()
    })

    worker.on('error', (error: Error) => {
      console.error(`[worker:${options.name}] 运行出错，已丢弃该 worker:`, error.message)
      retireWorker(worker, error)
      void worker.terminate().catch(() => { /* 已崩溃，忽略 */ })
    })

    worker.on('exit', (code: number) => {
      // 正常 terminate（dispose）时 allWorkers 已被清理，不会重复处理
      if (!allWorkers.has(worker)) return
      retireWorker(worker, new Error(`worker 提前退出，exit code=${code}`))
    })

    return worker
  }

  function dispatch(worker: Worker, task: QueuedTask): void {
    const id = nextRequestId++
    const entry: InflightTask = {
      id,
      resolve: task.resolve,
      reject: task.reject,
    }
    if (timeoutMs > 0) {
      entry.timer = setTimeout(() => {
        inflight.delete(worker)
        const idleIndex = idleWorkers.indexOf(worker)
        if (idleIndex >= 0) idleWorkers.splice(idleIndex, 1)
        allWorkers.delete(worker)
        task.reject(new Error(`[worker:${options.name}] 任务超时（${timeoutMs}ms），已终止该 worker`))
        void worker.terminate().catch(() => { /* 忽略 */ })
        pump()
      }, timeoutMs)
    }
    inflight.set(worker, entry)

    const request: WorkerRequestMessage = { id, payload: task.payload }
    worker.postMessage(request)
  }

  function pump(): void {
    if (disposed) return
    while (queue.length > 0) {
      let worker = idleWorkers.pop()
      if (!worker) {
        if (allWorkers.size >= maxWorkers) return
        worker = spawnWorker()
      }
      dispatch(worker, queue.shift()!)
    }
  }

  return {
    isWorkerBacked(): boolean {
      return canUseWorker()
    },

    run(payload: TPayload): Promise<TResult> {
      if (!canUseWorker()) {
        return Promise.resolve(options.fallback(payload))
      }
      return new Promise<TResult>((resolve, reject) => {
        queue.push({
          payload,
          resolve: resolve as (value: unknown) => void,
          reject,
        })
        pump()
      })
    },

    dispose(): void {
      disposed = true
      const error = new Error(`[worker:${options.name}] 任务池已释放`)
      for (const task of queue.splice(0)) task.reject(error)
      for (const [worker, task] of inflight) {
        if (task.timer) clearTimeout(task.timer)
        task.reject(error)
        void worker.terminate().catch(() => { /* 忽略 */ })
      }
      inflight.clear()
      for (const worker of allWorkers) {
        void worker.terminate().catch(() => { /* 忽略 */ })
      }
      allWorkers.clear()
      idleWorkers.length = 0
    },
  }
}
