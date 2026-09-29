/**
 * Shiki 语法高亮服务（Web Worker 客户端）
 *
 * 高亮计算全部在 worker 中完成，主线程只做渲染：
 * - highlightCode()                 异步 HTML（worker）
 * - highlightToTokens()             异步全量 token（worker，带内容缓存）
 * - highlightToTokensIncremental()  异步增量 token（只回传变化的行，流式最优）
 *
 * 降级路径：没有 Worker 的环境（Bun/Node 测试、主进程）或 worker 连续崩溃时，
 * 自动回退到进程内 shiki。降级用动态 import('shiki')，只有真的降级才会把 shiki 拉进主线程。
 */

import {
  DEFAULT_BG_COLOR,
  DEFAULT_FG_COLOR,
  DEFAULT_LANGS,
  DEFAULT_THEME,
  DEFAULT_THEMES,
  PLAIN_TEXT_LANGUAGE,
  isTokenPayload,
  resolveLanguageAlias,
} from './shiki-config.ts'
import type {
  HighlightIncrementalResult,
  HighlightOptions,
  HighlightResult,
  HighlightTokensResult,
  ShikiHighlighter,
  ShikiTokenPayload,
  ShikiWorkerRequest,
  ShikiWorkerResponse,
} from './shiki-config.ts'
import type { BundledLanguage, BundledTheme } from 'shiki'

// ===== worker 结构化类型 =====
// packages/core 的 tsconfig 不含 DOM lib（主进程编译同一份源码），因此不直接用全局 Worker 类型。

type WorkerMessageListener = (event: { data: ShikiWorkerResponse }) => void
type WorkerErrorListener = (event: unknown) => void

interface WorkerLike {
  postMessage: (message: ShikiWorkerRequest) => void
  terminate: () => void
  addEventListener: (
    type: 'message' | 'error' | 'messageerror',
    listener: WorkerMessageListener | WorkerErrorListener,
  ) => void
}

interface WorkerConstructor {
  new (url: URL, options?: { type?: 'module' | 'classic'; name?: string }): WorkerLike
}

// 显式声明 Worker 标识：必须让 TS 认识 `new Worker(new URL(...), { type: 'module' })`
// 这一写法——Vite 依赖该字面形式把 worker 拆成独立产物（正则匹配 `new Worker(new URL(`）。
// `declare` 不产生运行时代码，运行时仍取全局 Worker；typeof 判断对不存在的全局是安全的。
declare const Worker: WorkerConstructor

/** 单个请求超时（含 worker 冷启动加载 shiki 的时间） */
const WORKER_REQUEST_TIMEOUT_MS = 15_000

/** 连续失败多少次后永久禁用 worker（避免每次请求都白等一轮超时） */
const MAX_WORKER_FAILURES = 3

interface PendingRequest {
  resolve: (value: ShikiTokenPayload | HighlightResult | null) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** worker 单例：为 null 表示尚未创建或已被终止 */
let worker: WorkerLike | null = null
/** 是否收到过 worker 的 ready（高亮器就绪） */
let workerReady = false
/** 连续失败计数 */
let workerFailureCount = 0
/** 永久禁用 worker（环境不支持 / 反复崩溃） */
let workerDisabled = false
/** 请求 id 自增 */
let requestSeq = 1
const pendingRequests = new Map<number, PendingRequest>()
const readyListeners = new Set<() => void>()

/** 降级路径的高亮器（动态 import shiki，只有降级时才加载） */
let fallbackHighlighterPromise: Promise<ShikiHighlighter> | null = null
let fallbackHighlighter: ShikiHighlighter | null = null

// ===== worker 生命周期 =====

/** 懒创建 worker；返回 null 表示当前环境不可用，调用方应走降级路径 */
function getWorker(): WorkerLike | null {
  if (worker) return worker
  if (workerDisabled) return null
  // 非渲染环境（Bun/Node 测试、主进程）：没有 Worker 构造函数
  if (typeof Worker === 'undefined') {
    workerDisabled = true
    return null
  }

  try {
    const instance = new Worker(new URL('./shiki.worker.ts', import.meta.url), { type: 'module' })
    instance.addEventListener('message', handleWorkerMessage)
    instance.addEventListener('error', handleWorkerFatal)
    instance.addEventListener('messageerror', handleWorkerFatal)
    worker = instance
    return instance
  } catch (error) {
    // 构造即失败通常意味着环境不支持（例如 file:// 下的模块 worker 被拦截），无需再重试
    console.warn('[shiki-service] 创建 worker 失败，回退到主线程高亮:', error)
    workerDisabled = true
    return null
  }
}

function handleWorkerMessage(event: { data: ShikiWorkerResponse }): void {
  const message = event.data
  if (!message) return

  if ('type' in message && message.type === 'ready') {
    workerReady = true
    notifyReady()
    return
  }
  if (!('id' in message)) return

  const pending = pendingRequests.get(message.id)
  if (!pending) return
  pendingRequests.delete(message.id)
  clearTimeout(pending.timer)

  if (message.ok) pending.resolve(message.result)
  else pending.reject(new Error(message.error))
}

/** worker 脚本加载失败 / 运行时崩溃 / 消息无法反序列化 */
function handleWorkerFatal(): void {
  failWorker(new Error('shiki worker 崩溃或脚本加载失败'))
}

/** 终止 worker、拒绝所有在途请求，并按失败次数决定是否永久禁用 */
function failWorker(error: Error): void {
  const stale = worker
  if (!stale) return
  worker = null
  workerReady = false
  try {
    stale.terminate()
  } catch {
    // 已经终止，忽略
  }

  const pending = Array.from(pendingRequests.values())
  pendingRequests.clear()
  for (const entry of pending) {
    clearTimeout(entry.timer)
    entry.reject(error)
  }

  workerFailureCount += 1
  if (workerFailureCount >= MAX_WORKER_FAILURES) {
    console.warn('[shiki-service] worker 连续失败，永久回退到主线程高亮')
    workerDisabled = true
  }
}

function notifyReady(): void {
  const listeners = Array.from(readyListeners)
  readyListeners.clear()
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.error('[shiki-service] ready listener 抛错:', error)
    }
  }
}

/** 发送请求并等待响应；worker 不可用时立即 reject，由调用方决定是否降级 */
function requestWorker(request: Omit<ShikiWorkerRequest, 'id'>): Promise<ShikiTokenPayload | HighlightResult | null> {
  const instance = getWorker()
  if (!instance) return Promise.reject(new Error('shiki worker 不可用'))

  const id = requestSeq++
  return new Promise<ShikiTokenPayload | HighlightResult | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id)
      failWorker(new Error('shiki worker 请求超时'))
      reject(new Error('shiki worker 请求超时'))
    }, WORKER_REQUEST_TIMEOUT_MS)

    pendingRequests.set(id, { resolve, reject, timer })
    try {
      instance.postMessage({ ...request, id })
    } catch (error) {
      clearTimeout(timer)
      pendingRequests.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

// ===== 就绪状态（API 兼容） =====

/**
 * 高亮器是否就绪。
 * worker 模式下表示「worker 内的高亮器已完成初始化」；降级模式下表示「进程内高亮器已加载」。
 */
export function isHighlighterReady(): boolean {
  if (worker) return workerReady
  if (workerDisabled) return fallbackHighlighter !== null
  return false
}

/**
 * 订阅高亮器就绪事件。
 * - 已就绪：立即同步触发回调，返回 noop unsubscribe
 * - 未就绪：入队并开始初始化（worker 模式创建 worker 并预热高亮器；降级模式预加载进程内高亮器）
 */
export function onHighlighterReady(callback: () => void): () => void {
  if (isHighlighterReady()) {
    callback()
    return () => {}
  }

  readyListeners.add(callback)

  if (!getWorker()) {
    void getFallbackHighlighter()
      .then(() => notifyReady())
      .catch((error: unknown) => console.error('[shiki-service] 进程内高亮器初始化失败:', error))
  }

  return () => readyListeners.delete(callback)
}

// ===== 降级路径（进程内 shiki） =====

function getFallbackHighlighter(): Promise<ShikiHighlighter> {
  if (!fallbackHighlighterPromise) {
    fallbackHighlighterPromise = import('shiki')
      .then(({ createHighlighter }) => createHighlighter({ themes: DEFAULT_THEMES, langs: DEFAULT_LANGS }))
      .then((highlighter) => {
        fallbackHighlighter = highlighter
        return highlighter
      })
      .catch((error: unknown) => {
        // 复位以便后续重试
        fallbackHighlighterPromise = null
        throw error
      })
  }
  return fallbackHighlighterPromise
}

/** 降级路径的语言解析：按需加载，失败退回 text（未知语言会直接 throw，无需额外判断） */
async function resolveFallbackLanguage(highlighter: ShikiHighlighter, language: string): Promise<string> {
  const resolved = resolveLanguageAlias(language || PLAIN_TEXT_LANGUAGE)
  if (resolved === PLAIN_TEXT_LANGUAGE) return PLAIN_TEXT_LANGUAGE
  if (highlighter.getLoadedLanguages().includes(resolved)) return resolved

  try {
    await highlighter.loadLanguage(resolved as BundledLanguage)
    return resolved
  } catch {
    console.warn(`[shiki-service] 加载语言 "${resolved}" 失败，回退到 text`)
    return PLAIN_TEXT_LANGUAGE
  }
}

async function fallbackTokenize(options: HighlightOptions): Promise<HighlightTokensResult> {
  const { code, language, theme = DEFAULT_THEME } = options
  const highlighter = await getFallbackHighlighter()
  const lang = await resolveFallbackLanguage(highlighter, language)

  const result = highlighter.codeToTokens(code, {
    lang: lang as BundledLanguage,
    theme: theme as BundledTheme,
  })

  return {
    lines: result.tokens.map((line) =>
      line.map((token) => ({ content: token.content, color: token.color }))
    ),
    bgColor: result.bg ?? DEFAULT_BG_COLOR,
    fgColor: result.fg ?? DEFAULT_FG_COLOR,
    language: lang,
  }
}

// ===== 对外 API =====

/**
 * 异步高亮代码，返回 HTML 字符串（首次初始化 + 按需加载语言时使用）
 */
export async function highlightCode(options: HighlightOptions): Promise<HighlightResult> {
  const { code, language, theme = DEFAULT_THEME } = options

  if (!workerDisabled || worker) {
    try {
      const result = await requestWorker({ op: 'html', code, language, theme })
      if (result && 'html' in result) return result
    } catch (error) {
      console.warn('[shiki-service] worker HTML 高亮失败，回退主线程:', error)
    }
  }

  const highlighter = await getFallbackHighlighter()
  const lang = await resolveFallbackLanguage(highlighter, language)
  return {
    html: highlighter.codeToHtml(code, { lang: lang as BundledLanguage, theme: theme as BundledTheme }),
    language: lang,
  }
}

/**
 * 异步高亮代码，返回按行 token 结构（适合 React 逐行渲染）。
 * 返回 null 表示 worker 与降级路径都失败（调用方应保留纯文本渲染）。
 */
export async function highlightToTokens(options: HighlightOptions): Promise<HighlightTokensResult | null> {
  if (!workerDisabled || worker) {
    try {
      const payload = await requestWorker({
        op: 'tokens',
        code: options.code,
        language: options.language,
        theme: options.theme ?? DEFAULT_THEME,
      })
      if (isTokenPayload(payload)) {
        return {
          lines: payload.lines,
          bgColor: payload.bgColor,
          fgColor: payload.fgColor,
          language: payload.language,
        }
      }
    } catch (error) {
      console.warn('[shiki-service] worker 全量高亮失败，回退主线程:', error)
    }
  }

  try {
    return await fallbackTokenize(options)
  } catch (error) {
    console.error('[shiki-service] 高亮失败:', error)
    return null
  }
}

/**
 * 按 blockId 增量高亮：同一 blockId 表示同一代码块在流式增长。
 * 返回值只包含 startLine 起的行；调用方保留前 startLine 行即可得到完整结果。
 * worker 不可用时降级为进程内全量高亮，返回 startLine=0（等价于整块变化）。
 */
export async function highlightToTokensIncremental(
  blockId: string,
  options: HighlightOptions,
): Promise<HighlightIncrementalResult | null> {
  if (!workerDisabled || worker) {
    try {
      const payload = await requestWorker({
        op: 'incremental',
        blockId,
        code: options.code,
        language: options.language,
        theme: options.theme ?? DEFAULT_THEME,
      })
      if (isTokenPayload(payload)) {
        return {
          startLine: payload.startLine,
          lines: payload.lines,
          totalLines: payload.totalLines,
          bgColor: payload.bgColor,
          fgColor: payload.fgColor,
          language: payload.language,
        }
      }
    } catch (error) {
      console.warn('[shiki-service] worker 增量高亮失败，回退主线程全量:', error)
    }
  }

  try {
    const full = await fallbackTokenize(options)
    return {
      startLine: 0,
      lines: full.lines,
      totalLines: full.lines.length,
      bgColor: full.bgColor,
      fgColor: full.fgColor,
      language: full.language,
    }
  } catch (error) {
    console.error('[shiki-service] 增量高亮失败:', error)
    return null
  }
}

/**
 * 释放某个代码块的增量状态（组件卸载时调用）。
 * 纯资源回收：失败或被忽略都没关系，worker 侧另有 LRU 兜底。
 */
export function releaseHighlightBlock(blockId: string): void {
  if (!worker) return
  requestWorker({ op: 'release', blockId }).catch(() => {})
}

export { getDisplayName } from './shiki-config.ts'
