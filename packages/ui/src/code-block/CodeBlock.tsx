/**
 * CodeBlock - 代码块组件
 *
 * 提供语法高亮（Shiki / Web Worker）、语言标签和复制按钮。
 * 用于 react-markdown 的 pre 元素自定义渲染。
 *
 * 流式渲染策略：
 * 1. 高亮计算在 worker 中完成，主线程只渲染；高亮未就绪时先渲染纯文本
 * 2. 每个代码块一个稳定 blockId，worker 内部按行增量 tokenize（只重算最后一行 + 新增行）
 * 3. worker 只回传变化行，React 用稳定行级 key 做最小更新
 * 4. 节流 80ms + 「同一份 code 只请求一次」短路 → 避免重复请求与高频重算
 *
 * 结构：
 * ┌─────────────────────────────────────────┐
 * │ [language]                     [📋 复制] │  ← 头部栏
 * ├─────────────────────────────────────────┤
 * │  const foo = 'bar'                      │  ← 高亮代码区（逐行渲染）
 * │  console.log(foo)                       │
 * └─────────────────────────────────────────┘
 */

import * as React from 'react'
import {
  getDisplayName,
  highlightToTokensIncremental,
  releaseHighlightBlock,
} from '@proma/core'
import type {
  HighlightIncrementalResult,
  HighlightToken,
  HighlightTokensResult,
} from '@proma/core'

/** react-markdown 传入的 <code> 元素 props */
interface CodeElementProps {
  className?: string
  children?: React.ReactNode
}

interface CodeBlockProps {
  /** react-markdown 传入的 <pre> 子元素（内含 <code>） */
  children: React.ReactNode
  /** 覆盖默认剪贴板实现（Electron 可注入主进程剪贴板） */
  onCopy?: (text: string) => Promise<void>
}

/** 节流间隔（ms）：流式输出时限制高亮更新频率 */
const THROTTLE_MS = 80

// ===== 工具函数 =====

/** 递归提取 ReactNode 中的纯文本 */
function extractText(node: React.ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (!node) return ''
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (React.isValidElement(node)) {
    return extractText((node.props as CodeElementProps).children)
  }
  return ''
}

/** 从 children 中提取语言名和代码文本 */
function extractCodeInfo(children: React.ReactNode): { language: string; code: string } {
  // react-markdown v10 把 <code> 替换成自定义组件后，type 不再是字符串 'code'，
  // 但 pre 的 code child 要么是原生 'code'（v9 及之前），要么是自定义函数/对象组件（v10+）。
  // 通过 type 形态过滤掉意外混入的其他原生 HTML 元素，避免未来 react-markdown
  // 行为变化时静默把第一个 element 误识别为 code
  const codeElement = React.Children.toArray(children).find(
    (child): child is React.ReactElement => {
      if (!React.isValidElement(child)) return false
      const t = (child as React.ReactElement).type
      return t === 'code' || typeof t === 'function' || typeof t === 'object'
    }
  ) as React.ReactElement | undefined

  if (!codeElement) {
    return { language: '', code: extractText(children) }
  }

  const props = codeElement.props as CodeElementProps
  const langMatch = props.className?.match(/language-(\S+)/)

  return {
    language: langMatch?.[1] ?? '',
    code: extractText(props.children),
  }
}

// ===== 高亮状态 Hook =====

interface HighlightState {
  displayed: HighlightTokensResult | null
  /** 最近一次「已发出请求」的 code 指纹：同一次 render 内多处触发也只请求一次 */
  sentKey: string
  /** 是否已有请求在途：请求串行化，保证增量结果能安全合并 */
  inFlight: boolean
  timer: ReturnType<typeof setTimeout> | null
  lastFlushAt: number
  disposed: boolean
  /** 脱节重试标记，避免无限重试 */
  retried: boolean
}

/**
 * 订阅某个代码块的增量高亮结果。
 *
 * 关键不变量：
 * - 同一份 (language, code) 只会发起一次请求（sentKey 短路），彻底消除旧实现里
 *   「初始化 + effect 同步路径 + 定时器」对同一份 code 的 2~3 次重复计算
 * - 请求严格串行（inFlight），因此 worker 返回的「变化行区间」总是相对上一次已应用结果，
 *   客户端保留前 startLine 行 + 追加即可
 */
function useIncrementalHighlight(blockId: string, code: string, language: string): HighlightTokensResult | null {
  const [result, setResult] = React.useState<HighlightTokensResult | null>(null)
  const stateRef = React.useRef<HighlightState>({
    displayed: null,
    sentKey: '',
    inFlight: false,
    timer: null,
    lastFlushAt: 0,
    disposed: false,
    retried: false,
  })

  // 最新待高亮内容放在 ref 里：flush 是异步的，必须读取「发起请求那一刻」的最新值
  const latestRef = React.useRef({ code, language })
  latestRef.current = { code, language }

  function applyResult(response: HighlightIncrementalResult): void {
    const state = stateRef.current
    if (state.disposed) return

    const previous = state.displayed
    const canMerge = response.startLine > 0
      && !!previous
      && previous.language === response.language
      && previous.lines.length >= response.startLine

    if (response.startLine > 0 && !canMerge) {
      // 客户端缓存与 worker 增量状态脱节（理论上不会发生，因为请求串行且每次都应用结果）：
      // 重置 worker 侧状态后重取一次全量，避免把变化行拼到错误的前缀上
      if (!state.retried) {
        state.retried = true
        state.sentKey = ''
        releaseHighlightBlock(blockId)
        flush()
        return
      }
      // 重试后仍无法合并：退回纯文本渲染（宁可暂不上色，也不能渲染错行）
      state.retried = false
      state.displayed = null
      setResult(null)
      return
    }

    state.retried = false
    const next: HighlightTokensResult = canMerge
      ? {
          lines: (previous as HighlightTokensResult).lines.slice(0, response.startLine).concat(response.lines),
          bgColor: response.bgColor,
          fgColor: response.fgColor,
          language: response.language,
        }
      : {
          lines: response.lines,
          bgColor: response.bgColor,
          fgColor: response.fgColor,
          language: response.language,
        }

    state.displayed = next
    setResult(next)
  }

  function flush(): void {
    const state = stateRef.current
    if (state.disposed) return

    const { code: latestCode, language: latestLanguage } = latestRef.current
    const key = `${latestLanguage}\u0000${latestCode}`

    // 去重：同一份 code 已请求过就直接短路（流式重复 render 不会重复请求）
    if (key === state.sentKey) return
    // 串行化：等上一次响应应用完再发下一次，保证 startLine 语义成立
    if (state.inFlight) return

    state.sentKey = key
    state.inFlight = true
    state.lastFlushAt = Date.now()

    void (async () => {
      let response: HighlightIncrementalResult | null = null
      try {
        response = await highlightToTokensIncremental(blockId, { code: latestCode, language: latestLanguage })
      } catch (error) {
        // 服务层已经内部吞掉失败并返回 null，这里只是兜底，避免未处理的 rejection
        console.error('[CodeBlock] 高亮请求失败:', error)
      } finally {
        state.inFlight = false
      }
      if (state.disposed) return
      if (response) applyResult(response)

      // 响应期间 code 又变了：补一次（仍受节流约束）
      if (`${latestRef.current.language}\u0000${latestRef.current.code}` !== state.sentKey) {
        schedule()
      }
    })()
  }

  function schedule(): void {
    const state = stateRef.current
    if (state.disposed || state.timer) return

    // 已经请求过同一份 (language, code)：不必再排期，避免无意义的定时器
    const { code: latestCode, language: latestLanguage } = latestRef.current
    if (`${latestLanguage}\u0000${latestCode}` === state.sentKey) return

    const elapsed = Date.now() - state.lastFlushAt
    if (elapsed >= THROTTLE_MS) {
      flush()
      return
    }
    state.timer = setTimeout(() => {
      state.timer = null
      flush()
    }, THROTTLE_MS - elapsed)
  }

  React.useEffect(() => {
    // StrictMode（开发模式）会执行「挂载 → 卸载 → 再挂载」，而 ref 在这一次模拟卸载中不会被重置。
    // 因此每次 effect 启动都要把 disposed 复位，并清空 sentKey 以便重新发起一次请求，
    // 否则模拟卸载期间的响应会被丢弃、后续 flush 又被 sentKey 短路，导致颜色永远上不去。
    const state = stateRef.current
    state.disposed = false
    state.sentKey = ''
    schedule()
    // 依赖只取 blockId：其余状态都在 ref 中，schedule/flush 读取最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockId])

  React.useEffect(() => {
    schedule()
    // 依赖只取 code/language：其余状态都在 ref 中，schedule/flush 读取最新值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, language])

  React.useEffect(() => {
    return () => {
      const state = stateRef.current
      state.disposed = true
      if (state.timer) clearTimeout(state.timer)
      // 通知 worker 释放该 blockId 的增量状态，避免长会话内存持续增长
      releaseHighlightBlock(blockId)
    }
  }, [blockId])

  return result
}

// ===== SVG 图标路径常量 =====

const ICON_ATTRS = {
  width: 14, height: 14, viewBox: '0 0 24 24',
  fill: 'none', stroke: 'currentColor', strokeWidth: 2,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
}

const copyIconPath = (
  <>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </>
)

const checkIconPath = <polyline points="20 6 9 17 4 12" />

// ===== 逐行渲染子组件 =====

interface CodeLineProps {
  tokens: HighlightToken[]
  /** 该行的原始文本（token 未覆盖部分作为 fallback） */
  rawLine: string
}

/** 单行代码渲染（memo 避免已稳定行重复渲染） */
const CodeLine = React.memo(function CodeLine({ tokens, rawLine }: CodeLineProps): React.ReactElement {
  // token 覆盖的字符数
  const tokenLen = tokens.reduce((sum, t) => sum + t.content.length, 0)

  return (
    <span className="line">
      {tokens.map((token, i) => (
        <span key={i} style={token.color ? { color: token.color } : undefined}>
          {token.content}
        </span>
      ))}
      {/* 流式输出时可能有 token 尚未覆盖的尾部文本 */}
      {tokenLen < rawLine.length && (
        <span>{rawLine.slice(tokenLen)}</span>
      )}
    </span>
  )
})

// ===== 主组件 =====

/**
 * CodeBlock 代码块组件
 *
 * 渲染策略：
 * - 逐行渲染：worker 返回 token → 每行独立 React 元素 + 稳定 key
 * - 节流 80ms：流式输出时控制请求频率
 * - 渐进增强：worker 首次响应前渲染纯文本，响应后再补上颜色
 */
export function CodeBlock({ children, onCopy }: CodeBlockProps): React.ReactElement {
  const { language, code } = React.useMemo(() => extractCodeInfo(children), [children])
  const [copied, setCopied] = React.useState(false)

  const trimmedCode = code.replace(/\n$/, '')
  const langOrText = language || 'text'
  const rawLines = React.useMemo(() => trimmedCode.split('\n'), [trimmedCode])

  // 组件实例级稳定 id：worker 用它维护增量状态，跨 render 不变
  const blockId = React.useId()
  const tokenResult = useIncrementalHighlight(blockId, trimmedCode, langOrText)

  // 复制到剪贴板
  const handleCopy = React.useCallback(async () => {
    try {
      await (onCopy ? onCopy(trimmedCode) : navigator.clipboard.writeText(trimmedCode))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('[CodeBlock] 复制失败:', error)
    }
  }, [trimmedCode, onCopy])

  return (
    <div className="code-block-wrapper group/code rounded-lg overflow-hidden my-2 border border-border/50">
      {/* 头部栏：语言标签 + 复制按钮 */}
      <div className="flex items-center justify-between h-[34px] px-2 py-1 bg-muted/60 text-muted-foreground text-xs">
        <span className="font-medium select-none">{getDisplayName(language)}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-foreground/10 transition-colors text-muted-foreground hover:text-foreground"
        >
          <svg {...ICON_ATTRS}>{copied ? checkIconPath : copyIconPath}</svg>
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>

      {/* 代码区域：逐行渲染 */}
      <pre
        className="shiki overflow-x-auto p-4 m-0 text-[0.875em] leading-[1.6] bg-[hsl(var(--code-bg))]"
        style={{
          color: tokenResult?.fgColor ?? '#e1e4e8',
          borderRadius: '0 0 8px 8px',
        }}
      >
        <code>
          {rawLines.map((rawLine, i) => (
            <React.Fragment key={i}>
              {i > 0 && '\n'}
              <CodeLine
                tokens={tokenResult?.lines[i] ?? []}
                rawLine={rawLine}
              />
            </React.Fragment>
          ))}
        </code>
      </pre>
    </div>
  )
}
