import * as React from 'react'
import Markdown from 'react-markdown'
import type { ComponentProps } from 'react'
import { splitMarkdownBlocks } from '@/lib/markdown-blocks'
import { STREAM_THROTTLE_MS, useThrottledStreamText } from '@/hooks/useThrottledStreamText'

/**
 * 流式 markdown 渲染器
 *
 * 解决两个叠加的性能问题：
 *
 * 1. **全量重解析**：react-markdown 每次都会对传入的整段文本重新 parse + reconcile，
 *    流式输出时复杂度是 O(n²)。这里按空行边界把文本切成「已闭合块 + 尾块」，
 *    已闭合块内容恒定，React.memo 直接跳过重渲染，每帧只 parse 还在增长的尾块。
 *    （切分的语义安全性见 lib/markdown-blocks.ts）
 * 2. **按帧重建**：上游可能每帧推送一次（Chat 的 useSmoothStream 由 rAF 驱动，约 60fps），
 *    这里用时间节流把解析频率压到约 25 次/秒，并保证最终值一定提交。
 *
 * 调用方负责预处理（如 LaTeX 归一化），并且必须保证 `components` / `remarkPlugins` /
 * `rehypePlugins` / `urlTransform` 的引用稳定 —— 否则 memo 会失效，退化成原来的全量解析。
 */

type MarkdownOwnProps = ComponentProps<typeof Markdown>

/**
 * 单个 markdown 块。
 *
 * 只在 content 真正变化时重渲染：稳定块的 content 在流式增长过程中恒定，
 * 因此这一步会把「整条消息重解析」降为「只解析尾块」。
 */
const MarkdownBlock = React.memo(function MarkdownBlock({
  content,
  components,
  remarkPlugins,
  rehypePlugins,
  urlTransform,
}: {
  content: string
  components: MarkdownOwnProps['components']
  remarkPlugins: MarkdownOwnProps['remarkPlugins']
  rehypePlugins: MarkdownOwnProps['rehypePlugins']
  urlTransform: MarkdownOwnProps['urlTransform']
}): React.ReactElement {
  return (
    <Markdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      urlTransform={urlTransform}
      components={components}
    >
      {content}
    </Markdown>
  )
})

export interface StreamingMarkdownProps {
  /** 已完成预处理（LaTeX 归一化、注释清理等）的 markdown 文本 */
  children: string
  components?: MarkdownOwnProps['components']
  remarkPlugins?: MarkdownOwnProps['remarkPlugins']
  rehypePlugins?: MarkdownOwnProps['rehypePlugins']
  urlTransform?: MarkdownOwnProps['urlTransform']
  /** 节流间隔；传 0 表示不节流 */
  throttleMs?: number
}

export const StreamingMarkdown = React.memo(function StreamingMarkdown({
  children,
  components,
  remarkPlugins,
  rehypePlugins,
  urlTransform,
  throttleMs = STREAM_THROTTLE_MS,
}: StreamingMarkdownProps): React.ReactElement {
  const throttledText = useThrottledStreamText(children, throttleMs)

  // 切分必须在预处理之后：LaTeX 归一化会把跨行 \[...\] 变成 $$...$$，
  // 若先切分，这种跨行公式会被切到两个块里，语义就变了。
  const { stableBlocks, tailBlock } = React.useMemo(
    () => splitMarkdownBlocks(throttledText),
    [throttledText],
  )

  return (
    <>
      {stableBlocks.map((block, index) => (
        <MarkdownBlock
          key={index}
          content={block}
          components={components}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          urlTransform={urlTransform}
        />
      ))}
      <MarkdownBlock
        content={tailBlock}
        components={components}
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        urlTransform={urlTransform}
      />
    </>
  )
})
