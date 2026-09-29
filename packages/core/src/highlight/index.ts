/**
 * 语法高亮模块
 *
 * 基于 Shiki 的代码语法高亮服务，运行在 Web Worker 中，支持懒加载、按需加载语言和按行增量 tokenize。
 * 无 Worker 的环境（Bun/Node 测试、主进程）会自动降级到进程内实现。
 */

export {
  getDisplayName,
  highlightCode,
  highlightToTokens,
  highlightToTokensIncremental,
  isHighlighterReady,
  onHighlighterReady,
  releaseHighlightBlock,
} from './shiki-service.ts'
export type {
  HighlightIncrementalResult,
  HighlightOptions,
  HighlightResult,
  HighlightToken,
  HighlightTokensResult,
} from './shiki-config.ts'
export { detectLanguage } from './language-detector.ts'
