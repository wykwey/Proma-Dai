/**
 * Shiki 高亮 Web Worker
 *
 * 把语法高亮从渲染进程主线程搬到 worker，并实现按行增量 tokenize：
 * - 主线程只负责渲染，不再被 Shiki 的 tokenize 长任务阻塞
 * - 流式输出时只重算「最后一行 + 新增行」，并只回传变化的行
 *
 * 前缀复用的正确性依据：tokenize 是「从左到右、状态携带」的确定性函数，
 * 文本前缀不变时其对应行的 token 必然与全量结果一致。
 * 因此只要拿到「最后一行开始处」的 grammar state，就能安全续接。
 *
 * ⚠️ 依赖 bundledLanguages 是刻意的（2026-09-29 决策）：它让 worker 能按需加载任意
 * 语言，代价是 worker 会各自产出一份语言 chunk，与主入口（@pierre/diffs 静态依赖 shiki）
 * 重复约 12.9MB，详见 apps/electron/vite.config.ts 的 worker 配置注释。
 * 不要为了减小体积而改成固定白名单 —— 那会让冷门语言代码块退化成纯文本。
 */

import { bundledLanguages, createHighlighter } from 'shiki'
import type { BundledLanguage, BundledTheme, GrammarState, ThemedToken } from 'shiki'
import {
  DEFAULT_BG_COLOR,
  DEFAULT_FG_COLOR,
  DEFAULT_LANGS,
  DEFAULT_THEME,
  DEFAULT_THEMES,
  PLAIN_TEXT_LANGUAGE,
  resolveLanguageAlias,
} from './shiki-config.ts'
import type {
  HighlightResult,
  HighlightToken,
  ShikiHighlighter,
  ShikiTokenPayload,
  ShikiWorkerRequest,
  ShikiWorkerResponse,
} from './shiki-config.ts'

/**
 * worker 全局对象的最小接口。
 * packages/core 的 tsconfig 不含 DOM lib（主进程也会编译同一份源码），
 * 所以这里不引用 DedicatedWorkerGlobalScope，改用结构化声明。
 */
interface WorkerScope {
  postMessage: (message: ShikiWorkerResponse) => void
  onmessage: ((event: { data: ShikiWorkerRequest }) => void) | null
}

const scope = globalThis as unknown as WorkerScope

// ===== 高亮器（懒加载单例） =====

let highlighterPromise: Promise<ShikiHighlighter> | null = null

function getHighlighter(): Promise<ShikiHighlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: DEFAULT_THEMES,
      langs: DEFAULT_LANGS,
    })
      .then((highlighter) => {
        // 通知主线程「高亮器就绪」，让 isHighlighterReady / onHighlighterReady 语义成立
        scope.postMessage({ type: 'ready' })
        return highlighter
      })
      .catch((error: unknown) => {
        // 初始化失败必须复位 promise，否则后续请求只会拿到同一个 rejected promise
        highlighterPromise = null
        throw error
      })
  }
  return highlighterPromise
}

// worker 一开始创建就预热：主线程首次请求时通常已经就绪，避免「先白屏再上色」
void getHighlighter().catch((error: unknown) => {
  console.error('[shiki-worker] 高亮器初始化失败:', error)
})

/**
 * 解析语言别名并按需加载；未知语言或加载失败统一退回 'text'。
 * 与旧的主线程实现不同：这里能动态加载任意 bundled 语言，而不仅限于预加载的 18 种。
 */
async function resolveLanguage(highlighter: ShikiHighlighter, language: string): Promise<string> {
  const resolved = resolveLanguageAlias(language || PLAIN_TEXT_LANGUAGE)

  if (resolved === PLAIN_TEXT_LANGUAGE) return PLAIN_TEXT_LANGUAGE
  if (!(resolved in bundledLanguages)) {
    console.warn(`[shiki-worker] 未知语言 "${resolved}"，回退到 text`)
    return PLAIN_TEXT_LANGUAGE
  }
  if (highlighter.getLoadedLanguages().includes(resolved)) return resolved

  try {
    await highlighter.loadLanguage(resolved as BundledLanguage)
    return resolved
  } catch {
    console.warn(`[shiki-worker] 加载语言 "${resolved}" 失败，回退到 text`)
    return PLAIN_TEXT_LANGUAGE
  }
}

/** 主题未加载时退回默认主题，避免 getTheme / tokenize 抛错 */
function resolveTheme(highlighter: ShikiHighlighter, theme: string | undefined): BundledTheme {
  const candidate = (theme || DEFAULT_THEME) as BundledTheme
  return highlighter.getLoadedThemes().includes(candidate) ? candidate : DEFAULT_THEME
}

function themeColors(highlighter: ShikiHighlighter, theme: BundledTheme): { bgColor: string; fgColor: string } {
  const resolved = highlighter.getTheme(theme)
  return {
    bgColor: resolved.bg ?? DEFAULT_BG_COLOR,
    fgColor: resolved.fg ?? DEFAULT_FG_COLOR,
  }
}

// ===== 增量状态 =====

interface BlockState {
  /** 已解析的语言标识（别名展开 + 加载后的结果） */
  lang: string
  theme: BundledTheme
  /** 上一次 tokenize 时的完整文本，用于判断能否走「仅追加」前缀复用 */
  text: string
  /** 除最后一行外所有行的 token：这些行已由换行符定界，不会再变化，可直接复用 */
  stableTokens: ThemedToken[][]
  /** 最后一行的 token：流式增长时每次都会被重算 */
  tailTokens: ThemedToken[]
  /** 最后一行开始处的 grammar state；undefined 表示无法安全续接（此时增量回退全量） */
  stateBeforeTail?: GrammarState
}

/** 按 blockId 维护增量状态，LRU 淘汰避免长会话内存持续增长 */
const blockStates = new Map<string, BlockState>()
const BLOCK_STATE_LIMIT = 64

function setBlockState(blockId: string, state: BlockState): void {
  blockStates.delete(blockId)
  blockStates.set(blockId, state)
  if (blockStates.size > BLOCK_STATE_LIMIT) {
    const oldest = blockStates.keys().next().value
    if (oldest !== undefined) blockStates.delete(oldest)
  }
}

// ===== token 缓存 =====

const tokenCache = new Map<string, { code: string; payload: ShikiTokenPayload }>()
const TOKEN_CACHE_LIMIT = 120

/** FNV-1a 32bit：只用于给缓存分区，碰撞由缓存的原文二次校验兜底 */
function codeHash(code: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < code.length; i++) {
    hash ^= code.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

function cacheKey(lang: string, theme: string, code: string): string {
  return `${lang}\u0000${theme}\u0000${code.length}\u0000${codeHash(code)}`
}

function readTokenCache(key: string, code: string): ShikiTokenPayload | null {
  const hit = tokenCache.get(key)
  if (!hit) return null
  // 哈希碰撞时按未命中处理：宁可重算，也不能把别的代码的颜色渲染出来
  if (hit.code !== code) return null
  // 重新插入以维护 LRU 顺序
  tokenCache.delete(key)
  tokenCache.set(key, hit)
  return hit.payload
}

function writeTokenCache(key: string, code: string, payload: ShikiTokenPayload): void {
  tokenCache.set(key, { code, payload })
  if (tokenCache.size > TOKEN_CACHE_LIMIT) {
    const oldest = tokenCache.keys().next().value
    if (oldest !== undefined) tokenCache.delete(oldest)
  }
}

// ===== tokenize =====

/** 只保留渲染需要的字段，减小结构化克隆体积 */
function toHighlightLines(lines: ThemedToken[][]): HighlightToken[][] {
  return lines.map((line) => line.map((token) => ({ content: token.content, color: token.color })))
}

/** 读取一段 token 结束时的 grammar state；失败返回 undefined，由调用方决定是否回退 */
function readGrammarState(highlighter: ShikiHighlighter, tokens: ThemedToken[][]): GrammarState | undefined {
  try {
    return highlighter.getLastGrammarState(tokens)
  } catch {
    return undefined
  }
}

interface TokenizedBlock {
  /** 已定界（以换行结束）行的 token，可整段复用 */
  stableTokens: ThemedToken[][]
  /** 最后一行的 token */
  tailTokens: ThemedToken[]
  /** 最后一行的起始 grammar state，供下一次续接使用 */
  stateBeforeTail?: GrammarState
}

/**
 * 从 stateBeforeStart 续接 tokenize allLines[startLine..]。
 *
 * 为什么最后一行要单独一次调用：最后一行可能仍在流式增长，其 token 每次都要重算；
 * 而「最后一行开始处」的 grammar state 要留给下一次增量请求，所以必须单独取出来。
 * 中间那些已确定的行合并成一次 codeToTokensBase 调用，避免逐行调用的额外开销。
 */
function tokenizeTail(
  highlighter: ShikiHighlighter,
  allLines: string[],
  startLine: number,
  lang: string,
  theme: BundledTheme,
  stateBeforeStart?: GrammarState,
): TokenizedBlock {
  const lastIndex = allLines.length - 1
  const regionLines = allLines.slice(startLine, lastIndex)

  let stableTokens: ThemedToken[][] = []
  let stateBeforeTail = stateBeforeStart

  if (regionLines.length > 0) {
    const region = highlighter.codeToTokensBase(regionLines.join('\n'), {
      lang: lang as BundledLanguage,
      theme,
      grammarState: stateBeforeStart,
    })
    stableTokens = region
    // 纯文本语言没有 grammar state，也不需要续接
    stateBeforeTail = lang === PLAIN_TEXT_LANGUAGE ? undefined : readGrammarState(highlighter, region)
  }

  const tail = highlighter.codeToTokensBase(allLines[lastIndex] ?? '', {
    lang: lang as BundledLanguage,
    theme,
    grammarState: stateBeforeTail,
  })

  return { stableTokens, tailTokens: tail[0] ?? [], stateBeforeTail }
}

// ===== op 实现 =====

async function runTokens(request: ShikiWorkerRequest): Promise<ShikiTokenPayload> {
  const code = request.code ?? ''
  const highlighter = await getHighlighter()
  const lang = await resolveLanguage(highlighter, request.language ?? '')
  const theme = resolveTheme(highlighter, request.theme)

  const key = cacheKey(lang, theme, code)
  const cached = readTokenCache(key, code)
  if (cached) return cached

  const allLines = code.split('\n')
  const tail = tokenizeTail(highlighter, allLines, 0, lang, theme, undefined)
  const payload: ShikiTokenPayload = {
    startLine: 0,
    lines: toHighlightLines(tail.stableTokens.concat([tail.tailTokens])),
    totalLines: allLines.length,
    ...themeColors(highlighter, theme),
    language: lang,
  }
  writeTokenCache(key, code, payload)
  return payload
}

/**
 * 回退路径：整块重新 tokenize。
 * 仍然会重建 BlockState 并把结果写入缓存，这样后续的增量请求还能继续走快路径。
 */
function fullIncremental(
  highlighter: ShikiHighlighter,
  blockId: string,
  code: string,
  lang: string,
  theme: BundledTheme,
): ShikiTokenPayload {
  const allLines = code.split('\n')
  const tail = tokenizeTail(highlighter, allLines, 0, lang, theme, undefined)

  setBlockState(blockId, {
    lang,
    theme,
    text: code,
    stableTokens: tail.stableTokens,
    tailTokens: tail.tailTokens,
    stateBeforeTail: tail.stateBeforeTail,
  })

  const payload: ShikiTokenPayload = {
    startLine: 0,
    lines: toHighlightLines(tail.stableTokens.concat([tail.tailTokens])),
    totalLines: allLines.length,
    ...themeColors(highlighter, theme),
    language: lang,
  }
  writeTokenCache(cacheKey(lang, theme, code), code, payload)
  return payload
}

async function runIncremental(request: ShikiWorkerRequest): Promise<ShikiTokenPayload> {
  const blockId = request.blockId
  if (!blockId) throw new Error('incremental 请求缺少 blockId')

  const code = request.code ?? ''
  const highlighter = await getHighlighter()
  const lang = await resolveLanguage(highlighter, request.language ?? '')
  const theme = resolveTheme(highlighter, request.theme)
  const previous = blockStates.get(blockId)

  // 前置条件不满足（首次 / 语言或主题变化 / 非纯追加）→ 全量
  const canReusePrefix = !!previous
    && previous.lang === lang
    && previous.theme === theme
    && code.startsWith(previous.text)

  if (!canReusePrefix || !previous) {
    return fullIncremental(highlighter, blockId, code, lang, theme)
  }

  // 可复用的稳定行数 = 上一轮「除最后一行外」的行数（最后一行可能被追加内容改变）
  const startLine = previous.stableTokens.length

  // 关键回退条件：需要复用前缀，但上一轮没能拿到续接用的 grammar state（非纯文本语言）。
  // 缺少 state 时续接会丢掉语法上下文（例如跨行的注释/字符串），必须回退全量保证正确性。
  if (startLine > 0 && lang !== PLAIN_TEXT_LANGUAGE && !previous.stateBeforeTail) {
    return fullIncremental(highlighter, blockId, code, lang, theme)
  }

  const allLines = code.split('\n')
  let tail: TokenizedBlock
  try {
    tail = tokenizeTail(highlighter, allLines, startLine, lang, theme, previous.stateBeforeTail)
  } catch (error) {
    // grammarState 与语言/主题不匹配、语法状态异常等：正确性优先，回退全量
    console.warn('[shiki-worker] 增量 tokenize 失败，回退全量:', error)
    return fullIncremental(highlighter, blockId, code, lang, theme)
  }

  setBlockState(blockId, {
    lang,
    theme,
    text: code,
    stableTokens: previous.stableTokens.concat(tail.stableTokens),
    tailTokens: tail.tailTokens,
    stateBeforeTail: tail.stateBeforeTail,
  })

  // 只回传变化行：0..startLine-1 的 token 由主线程复用
  const changedLines = tail.stableTokens.concat([tail.tailTokens])
  return {
    startLine,
    lines: toHighlightLines(changedLines),
    totalLines: allLines.length,
    ...themeColors(highlighter, theme),
    language: lang,
  }
}

async function runHtml(request: ShikiWorkerRequest): Promise<HighlightResult> {
  const highlighter = await getHighlighter()
  const lang = await resolveLanguage(highlighter, request.language ?? '')
  const theme = resolveTheme(highlighter, request.theme)

  return {
    html: highlighter.codeToHtml(request.code ?? '', { lang: lang as BundledLanguage, theme }),
    language: lang,
  }
}

// ===== 消息分发 =====

async function handleRequest(request: ShikiWorkerRequest): Promise<void> {
  try {
    let result: ShikiTokenPayload | HighlightResult | null = null
    switch (request.op) {
      case 'tokens':
        result = await runTokens(request)
        break
      case 'incremental':
        result = await runIncremental(request)
        break
      case 'html':
        result = await runHtml(request)
        break
      case 'release':
        if (request.blockId) blockStates.delete(request.blockId)
        break
      default:
        throw new Error(`未知的 shiki worker 操作: ${String(request.op)}`)
    }
    scope.postMessage({ id: request.id, ok: true, result })
  } catch (error) {
    scope.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

scope.onmessage = (event) => {
  const request = event.data
  if (!request || typeof request.id !== 'number') return
  void handleRequest(request)
}
