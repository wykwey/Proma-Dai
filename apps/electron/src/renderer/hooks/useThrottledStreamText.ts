import * as React from 'react'

/**
 * 流式文本节流
 *
 * 流式输出时上游可能是「每帧一次」（Chat 的 useSmoothStream 用 rAF 驱动，约 60 次/秒）
 * 或「每个 token 一次」。每次都触发 markdown 解析会白烧 CPU，而人眼并不需要 60fps 的
 * 文本更新。
 *
 * 与 useDeferredValue 的区别：deferred 是「低优先级、可被中断」，在有持续紧急更新时
 * 理论上可能长时间不提交；这里需要的是**有上界**的提交频率，因此用时间节流：
 * - 距上次提交已超过 intervalMs → 立即提交；
 * - 否则安排一次尾部提交，保证最终值一定会渲染出来（不会卡在中间状态）。
 *
 * 安全阀：只有「纯追加」才节流。消息切换、回退、编辑等非追加变化立即提交，
 * 避免列表复用组件实例时短暂显示上一条消息的旧内容。
 */

/** 默认节流间隔：25 次/秒，文本观感仍然连续，解析量约为原来的 1/2.4 */
export const STREAM_THROTTLE_MS = 40

export function useThrottledStreamText(text: string, intervalMs: number = STREAM_THROTTLE_MS): string {
  const [throttledText, setThrottledText] = React.useState(text)
  const lastCommitAtRef = React.useRef(0)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const previousTextRef = React.useRef(text)
  const latestTextRef = React.useRef(text)
  latestTextRef.current = text

  React.useEffect(() => {
    const previousText = previousTextRef.current
    previousTextRef.current = text

    // 非追加（消息被替换 / 回退 / 编辑）：立即提交，不能节流
    if (!text.startsWith(previousText)) {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      lastCommitAtRef.current = Date.now()
      setThrottledText(text)
      return
    }

    const elapsed = Date.now() - lastCommitAtRef.current
    if (elapsed >= intervalMs) {
      lastCommitAtRef.current = Date.now()
      setThrottledText(text)
      return
    }

    // 已排好尾部提交就不重复排期：定时器到点会读 latestTextRef，拿到最新值
    if (timerRef.current) return
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      lastCommitAtRef.current = Date.now()
      setThrottledText(latestTextRef.current)
    }, intervalMs - elapsed)
  }, [text, intervalMs])

  React.useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  return throttledText
}
