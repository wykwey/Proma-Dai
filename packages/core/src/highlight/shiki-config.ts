/**
 * Shiki 高亮共享配置与协议类型
 *
 * 主线程客户端（shiki-service.ts）和 worker（shiki.worker.ts）都要用到这里的常量、
 * 语言解析规则和消息结构，因此本文件有三条硬约束：
 * 1. 只 import type，不 import shiki 运行时：主线程依赖本文件，但 shiki 本体必须留在 worker 里，
 *    否则降级路径之外的场景仍会把整个 shiki 打进主线程 bundle。
 * 2. 不引用 Worker / React / document 等宿主 API：保证 worker 侧也能安全导入。
 * 3. 不依赖 bundledLanguages：判断「是否为已知语言」需要 shiki 的语言清单，
 *    只能由已经加载了 shiki 的 worker / 降级路径各自完成（见 resolveLanguageAlias 的注释）。
 */

import type { BundledLanguage, BundledTheme, HighlighterGeneric } from 'shiki'

/** Shiki 高亮器实例类型（与 createHighlighter 返回值一致） */
export type ShikiHighlighter = HighlighterGeneric<BundledLanguage, BundledTheme>

/** 默认预加载的语言列表（worker 与降级路径共用，不要随意缩减） */
export const DEFAULT_LANGS: BundledLanguage[] = [
  'javascript', 'typescript', 'python', 'java', 'json',
  'markdown', 'html', 'css', 'shellscript', 'go', 'rust', 'sql',
  'tsx', 'jsx', 'yaml', 'toml', 'c', 'cpp',
]

/** 默认加载的主题 */
export const DEFAULT_THEMES: BundledTheme[] = ['github-light', 'github-dark', 'one-light', 'one-dark-pro']

/** 主题缺省值：调用方未指定主题时使用 */
export const DEFAULT_THEME = 'github-dark'

/** 主题背景/前景色兜底值（个别主题不提供 bg/fg） */
export const DEFAULT_BG_COLOR = '#24292e'
export const DEFAULT_FG_COLOR = '#e1e4e8'

/** 纯文本语言标识：无需语法状态，也不会被 Shiki 当作可加载语言 */
export const PLAIN_TEXT_LANGUAGE = 'text'

/** 常见语言别名映射 */
export const LANGUAGE_ALIASES: Record<string, string> = {
  sh: 'shellscript',
  bash: 'shellscript',
  shell: 'shellscript',
  zsh: 'shellscript',
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  rb: 'ruby',
  yml: 'yaml',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  kt: 'kotlin',
  rs: 'rust',
  md: 'markdown',
  tf: 'terraform',
  dockerfile: 'docker',
  plaintext: 'text',
  txt: 'text',
  plain: 'text',
}

/** 不规则语言显示名称（无法通过首字母大写自动生成） */
const DISPLAY_NAMES: Record<string, string> = {
  js: 'JavaScript', javascript: 'JavaScript',
  ts: 'TypeScript', typescript: 'TypeScript',
  tsx: 'TSX', jsx: 'JSX',
  py: 'Python', rb: 'Ruby',
  cpp: 'C++', 'c++': 'C++',
  cs: 'C#', csharp: 'C#',
  kt: 'Kotlin', rs: 'Rust',
  sh: 'Shell', zsh: 'Shell',
  yml: 'YAML', md: 'Markdown',
  tf: 'Terraform',
  html: 'HTML', css: 'CSS', scss: 'SCSS', less: 'LESS',
  json: 'JSON', xml: 'XML', sql: 'SQL',
  graphql: 'GraphQL', php: 'PHP',
  plaintext: 'Text', text: 'Text',
}

/** 获取语言显示名称，未匹配的自动首字母大写 */
export function getDisplayName(lang: string): string {
  if (!lang) return 'Code'
  const key = lang.toLowerCase()
  return DISPLAY_NAMES[key] ?? key.charAt(0).toUpperCase() + key.slice(1)
}

/**
 * 归一化语言标识：小写、去空格、展开常见别名。
 *
 * 这里故意不判断「是否为 Shiki 已知语言」——那需要 bundledLanguages（shiki 运行时）。
 * 调用方拿到结果后自行与 bundledLanguages 比对，未知语言统一退回 'text'。
 */
export function resolveLanguageAlias(lang: string): string {
  const normalized = lang.toLowerCase().trim()
  return LANGUAGE_ALIASES[normalized] ?? normalized
}

// ===== 对外 API 类型 =====

/** 高亮选项 */
export interface HighlightOptions {
  /** 代码内容 */
  code: string
  /** 语言标识（如 'typescript'、'py'、'bash'） */
  language: string
  /** Shiki 主题名，默认 'github-dark' */
  theme?: string
}

/** 高亮结果（HTML 字符串） */
export interface HighlightResult {
  /** Shiki 渲染的 HTML 字符串 */
  html: string
  /** 实际使用的语言（经过别名解析和 fallback） */
  language: string
}

/** 单个高亮 token */
export interface HighlightToken {
  /** 文本内容 */
  content: string
  /** CSS 颜色值 */
  color?: string
}

/** 按行组织的 token 高亮结果（适合 React 逐行渲染） */
export interface HighlightTokensResult {
  /** 每行的 token 列表 */
  lines: HighlightToken[][]
  /** 代码区域背景色 */
  bgColor: string
  /** 代码区域前景色 */
  fgColor: string
  /** 实际使用的语言（别名解析 + fallback 之后） */
  language: string
}

/**
 * 增量高亮结果：只包含发生变化的行。
 *
 * 流式场景下如果每次 postMessage 都克隆整份 token 数组，主线程会被结构化克隆拖住，
 * 因此 worker 只回传 [startLine, ...] 区间，调用方用「保留前 startLine 行 + 追加新行」合并。
 */
export interface HighlightIncrementalResult {
  /** 首个发生变化的行号（0 起）；小于它的行与上一次结果完全一致，可直接复用 */
  startLine: number
  /** 从 startLine 开始的所有行 token */
  lines: HighlightToken[][]
  /** 当前总行数 */
  totalLines: number
  /** 代码区域背景色 */
  bgColor: string
  /** 代码区域前景色 */
  fgColor: string
  /** 实际使用的语言 */
  language: string
}

// ===== worker 消息协议 =====

/**
 * worker 支持的操作：
 * - tokens：全量高亮一个代码块（无状态、可按内容缓存）
 * - incremental：按 blockId 增量高亮（同一 blockId 表示同一代码块在流式增长）
 * - html：输出 HTML 字符串（highlightCode 使用）
 * - release：释放某个 blockId 的增量状态，避免长会话下内存持续增长
 */
export type ShikiWorkerOp = 'tokens' | 'incremental' | 'html' | 'release'

/** 主线程 → worker */
export interface ShikiWorkerRequest {
  /** 自增请求 id，worker 原样回传用于关联 promise */
  id: number
  op: ShikiWorkerOp
  /** 代码文本（release 时忽略） */
  code?: string
  /** 原始语言标识（release 时忽略） */
  language?: string
  /** 主题名（release 时忽略） */
  theme?: string
  /** incremental 必填：同一代码块的稳定标识 */
  blockId?: string
}

/** token 类操作的统一返回结构（startLine=0 表示全量） */
export interface ShikiTokenPayload {
  startLine: number
  lines: HighlightToken[][]
  totalLines: number
  bgColor: string
  fgColor: string
  language: string
}

/** worker → 主线程 */
export type ShikiWorkerResponse =
  /** 高亮器已就绪（worker 内首次 createHighlighter 完成） */
  | { type: 'ready' }
  | { id: number; ok: true; result: ShikiTokenPayload | HighlightResult | null }
  | { id: number; ok: false; error: string }

/** 判断响应载荷是否为 token 结构（与 HighlightResult 的 html 区分） */
export function isTokenPayload(value: ShikiTokenPayload | HighlightResult | null): value is ShikiTokenPayload {
  return !!value && typeof value === 'object' && 'lines' in value
}
