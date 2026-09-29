/**
 * Markdown 块级切分（流式渲染用）
 *
 * 目的：流式输出时 react-markdown 会对「整条消息」重新 parse + reconcile，复杂度对流长度
 * 是 O(n²)。Chat 侧还有 useSmoothStream 逐帧驱动（~60fps），等于每秒把整条消息重解析几十次。
 *
 * 做法：把已渲染文本切成若干「已闭合、内容不会再变」的块 + 一个可能仍在增长的尾块。
 * 稳定块交给 React.memo，流式过程中只重解析尾块。
 *
 * 正确性前提（为什么切分不会改变渲染结果）：
 * - 只在「空行」处切分，而空行在 CommonMark 里是块级构造的分隔符；
 * - 若空行两侧任一侧可能属于「可跨空行的构造」（松散列表、列表续行、缩进代码块、
 *   引用块、表格行），一律不切；
 * - 围栏代码块与跨行 $$ 公式内部绝不切分；
 * - 文档级引用构造（引用式链接定义、脚注定义）会让「后文定义影响前文引用」，
 *   一旦出现就整体放弃切分（bailed）。
 *
 * 边界稳定性：边界只由「该空行之前的前缀」决定，因此消息继续增长时，
 * 前缀里的边界不会移动，稳定块内容恒定 —— 这是 memo 能命中的前提。
 */

/** 围栏代码块起始/结束：最多 3 个前导空格，>=3 个反引号或波浪号 */
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/
/** 跨行显示公式 */
const DISPLAY_MATH_PATTERN = /^ {0,3}\$\$/
/** 列表项（无序 / 有序） */
const LIST_ITEM_PATTERN = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/
/** 引用块 */
const BLOCKQUOTE_PATTERN = /^ {0,3}>/
/** 缩进内容（缩进代码块 / 列表续行） */
const INDENTED_PATTERN = /^(?: {4,}|\t)/
/** 引用式链接定义：[label]: url */
const LINK_REFERENCE_PATTERN = /^ {0,3}\[[^\]]+\]:\s*\S/
/** 脚注定义：[^label]: text */
const FOOTNOTE_DEFINITION_PATTERN = /^ {0,3}\[\^[^\]]+\]:/
/**
 * 块级 HTML 起始标签：这类 HTML 块可以跨空行，切分会改变语义，因此整体放弃切分。
 * 只列 HTML block 常见标签，避免把行内 `<code>` / `<b>` 之类误判。
 */
const HTML_BLOCK_PATTERN = /^ {0,3}<(?:\/?)(?:div|table|section|details|summary|figure|iframe|script|style|pre|ul|ol|li|p|h[1-6]|blockquote|dl|form|article|aside|header|footer|main|nav)\b|^ {0,3}<!--|^ {0,3}<\?|^ {0,3}<![A-Z]|^ {0,3}<!\[CDATA\[/i

export interface MarkdownBlocks {
  /** 已闭合的块，按出现顺序；流式增长时内容恒定，可被 React.memo 完全跳过 */
  stableBlocks: string[]
  /** 尾部块，可能仍在增长 */
  tailBlock: string
  /**
   * 是否放弃了切分。
   * true 时 stableBlocks 为空、tailBlock 为原文，调用方按「单块」渲染即可。
   */
  bailed: boolean
}

/** 全文兜底：出现文档级构造就整体不切 */
function shouldBail(lines: string[]): boolean {
  for (const line of lines) {
    if (LINK_REFERENCE_PATTERN.test(line)) return true
    if (FOOTNOTE_DEFINITION_PATTERN.test(line)) return true
    if (HTML_BLOCK_PATTERN.test(line)) return true
  }
  return false
}

/**
 * 把 markdown 文本切分为「稳定块 + 尾块」。
 *
 * @param text 已做过 LaTeX 归一化等预处理、可直接喂给 react-markdown 的文本
 */
export function splitMarkdownBlocks(text: string): MarkdownBlocks {
  if (!text.trim()) {
    return { stableBlocks: [], tailBlock: text, bailed: false }
  }

  const lines = text.split('\n')
  if (shouldBail(lines)) {
    return { stableBlocks: [], tailBlock: text, bailed: true }
  }

  const isBlank = (index: number): boolean => lines[index]!.trim() === ''

  /** 每个稳定块的起始行号；首块恒为 0 */
  const boundaryStarts: number[] = [0]
  let fenceMarker = ''
  let fenceLength = 0
  let inDisplayMath = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    // 围栏代码块：内部空行不是块边界
    const fenceMatch = FENCE_PATTERN.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]!
      if (!fenceMarker) {
        fenceMarker = marker[0]!
        fenceLength = marker.length
      } else if (marker[0] === fenceMarker && marker.length >= fenceLength) {
        fenceMarker = ''
        fenceLength = 0
      }
      continue
    }
    if (fenceMarker) continue

    // 跨行 $$ 公式：内部空行不是块边界
    if (DISPLAY_MATH_PATTERN.test(line)) {
      const dollarPairs = (line.match(/\$\$/g) ?? []).length
      if (inDisplayMath) {
        inDisplayMath = false
      } else if (dollarPairs < 2) {
        inDisplayMath = true
      }
      continue
    }
    if (inDisplayMath) continue

    if (!isBlank(i)) continue

    // 候选边界：空行之后第一个非空行的行号
    let next = i + 1
    while (next < lines.length && isBlank(next)) next++
    // 尾部只有空行，说明后续内容还没到，先不切
    if (next >= lines.length) continue

    let prev = i - 1
    while (prev >= 0 && isBlank(prev)) prev--
    if (prev < 0) continue

    const prevLine = lines[prev]!
    const nextLine = lines[next]!

    // 安全守卫：空行两侧任一侧属于「可跨空行的构造」→ 这个空行不构成分块边界。
    //
    // 这一组规则只依赖「空行前后各一行」，不需要块级状态机，因此可以证明：
    // 任一被允许的边界，其两侧在 CommonMark 里都不可能跨越该空行互相影响。
    //
    // 关键点是列表/缩进必须两侧都防：
    // - 前侧带缩进：可能是缩进代码块内部，或列表项的（≥4 空格）续段；
    // - 后侧是列表项：它可能是更早那个列表的下一项（松散列表可以跨空行），
    //   这在「- a / 空行 / 缩进的第二段 / 空行 / - b」这类输入里真实存在；
    // - 后侧带任意缩进（含 1–3 空格）：可能是上一条列表项的第二个段落。
    //   注意不能只判「4 空格以上」—— 列表项续段只需要 1 个空格缩进。
    if (INDENTED_PATTERN.test(prevLine)) continue
    if (BLOCKQUOTE_PATTERN.test(prevLine) || BLOCKQUOTE_PATTERN.test(nextLine)) continue
    if (prevLine.includes('|')) continue
    if (prevLine.endsWith('\\')) continue
    if (LIST_ITEM_PATTERN.test(nextLine)) continue
    if (/^[ \t]/.test(nextLine)) continue

    boundaryStarts.push(next)
  }

  // 最后一个边界之后的所有内容属于尾块（可能仍在增长）
  const stableEnd = boundaryStarts.length - 1
  if (stableEnd <= 0) {
    return { stableBlocks: [], tailBlock: text, bailed: false }
  }

  const stableBlocks: string[] = []
  for (let k = 0; k < stableEnd; k++) {
    const from = boundaryStarts[k]!
    const to = boundaryStarts[k + 1]!
    stableBlocks.push(lines.slice(from, to).join('\n'))
  }
  const tailBlock = lines.slice(boundaryStarts[stableEnd]!).join('\n')

  return { stableBlocks, tailBlock, bailed: false }
}
