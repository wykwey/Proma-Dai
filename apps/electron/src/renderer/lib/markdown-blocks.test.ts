import { describe, expect, test } from 'bun:test'
import { splitMarkdownBlocks } from './markdown-blocks'

/**
 * 切分必须无损：稳定块（每个都以空行结尾）+ 尾块 拼回原文。
 * 稳定块内容会带上分隔用的尾部空行，这对渲染无影响（remark 忽略块尾空行），
 * 但让「拼接无损」可以严格断言。
 */
function expectLossless(text: string): void {
  const { stableBlocks, tailBlock } = splitMarkdownBlocks(text)
  const rejoined = stableBlocks.length > 0 ? `${stableBlocks.join('\n')}\n${tailBlock}` : tailBlock
  expect(rejoined).toBe(text)
}

describe('markdown 块级切分', () => {
  test('Given 多段落 When 切分 Then 除尾块外全部成为稳定块', () => {
    const text = '第一段\n\n第二段\n\n第三段'
    const { stableBlocks, tailBlock, bailed } = splitMarkdownBlocks(text)

    expect(bailed).toBe(false)
    expect(stableBlocks).toEqual(['第一段\n', '第二段\n'])
    expect(tailBlock).toBe('第三段')
    expectLossless(text)
  })

  test('Given 流式逐行增长 When 每步切分 Then 已出现的稳定块内容与数量只增不改', () => {
    // 这是 memo 能命中的前提：边界只由前缀决定 ⇒ 前缀里的边界不移动、块内容恒定
    const full = [
      '# 标题',
      '',
      '第一段正文，包含 **加粗** 与 `inline code`。',
      '',
      '第二段正文。',
      '',
      '- 列表项一',
      '- 列表项二',
      '',
      '收尾段落。',
    ].join('\n')

    const lines = full.split('\n')
    let previousStable: string[] = []
    for (let end = 1; end <= lines.length; end++) {
      const prefix = lines.slice(0, end).join('\n')
      const { stableBlocks } = splitMarkdownBlocks(prefix)
      expectLossless(prefix)
      // 之前的稳定块必须原样保留在相同位置
      expect(stableBlocks.slice(0, previousStable.length)).toEqual(previousStable)
      previousStable = stableBlocks
    }
    expect(previousStable.length).toBeGreaterThan(1)
  })

  test('Given 已闭合围栏代码块 When 切分 Then 代码块内部空行不切、块整体可成为稳定块', () => {
    const text = '说明文字\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\n后续段落'
    const { stableBlocks, tailBlock } = splitMarkdownBlocks(text)

    expect(stableBlocks).toEqual(['说明文字\n', '```ts\nconst a = 1\n\nconst b = 2\n```\n'])
    expect(tailBlock).toBe('后续段落')
    expectLossless(text)
  })

  test('Given 流式中未闭合围栏 When 分步切分 Then 围栏内部不会切块', () => {
    const prefix = '前言\n\n```python\nprint(1)\n'
    const { stableBlocks, tailBlock } = splitMarkdownBlocks(prefix)

    expect(stableBlocks).toEqual(['前言\n'])
    expect(tailBlock.startsWith('```python')).toBe(true)

    // 围栏内部再出现空行也不能切
    const deeper = '前言\n\n```python\nprint(1)\n\nprint(2)\n'
    expect(splitMarkdownBlocks(deeper).stableBlocks).toEqual(['前言\n'])
  })

  test('Given 表格 When 切分 Then 表格本身不被拆开', () => {
    const text = '表前段落\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n表后段落'
    const { stableBlocks, tailBlock } = splitMarkdownBlocks(text)

    expect(stableBlocks).toEqual(['表前段落\n'])
    // 表格三行与表后段落都在同一个尾块里，表格绝不会被切开
    expect(tailBlock).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n表后段落')
    expectLossless(text)
  })

  test('Given 松散列表 When 列表项之间有空行 Then 不把列表拆成两块', () => {
    const text = '前言\n\n- 项一\n\n- 项二\n\n结尾'
    const { stableBlocks, tailBlock } = splitMarkdownBlocks(text)

    // 两个列表项必须留在同一块。因为「下一行是列表项」都保守地不切，
    // 列表前紧邻的段落也一并并进来；整个列表组作为一整块 memo。
    expect(stableBlocks).toEqual(['前言\n\n- 项一\n\n- 项二\n'])
    expect(tailBlock).toBe('结尾')
    expectLossless(text)
  })

  test('Given 嵌套列表后面接同级列表项 When 中间有空行 Then 不切', () => {
    // 回归：若只判断「上一行是列表项」，嵌套层结束后的空行会被误认为可切，
    // 把「- b」切成一个新列表（同一列表被拆成两个）
    const text = '- a\n      - 深一层\n\n- b'
    expect(splitMarkdownBlocks(text).stableBlocks).toEqual([])
  })

  test('Given 列表项的第二段之后接同级列表项 When 中间有空行 Then 不切', () => {
    // 回归：上一行只是「缩进两格的第二段」（不是列表项也不是 ≥4 空格缩进），
    // 若只看上一行会把「- b」切出去，而它其实是同一个列表的下一项
    const text = '- a\n\n  a 的第二段\n\n- b'
    expect(splitMarkdownBlocks(text).stableBlocks).toEqual([])
  })

  test('Given 列表项带缩进续行 When 续行前有空行 Then 续行必须留在同一块', () => {
    // 回归：列表项的续段只需要 1 个空格缩进。早期用「4 空格才算缩进」判定，
    // 会把这种 2 空格续段切出列表，导致它从 <li> 里的第二段变成独立段落（渲染回归）
    const twoSpaces = '- 项一\n\n  续行段落\n\n结尾'
    expect(splitMarkdownBlocks(twoSpaces).stableBlocks).toEqual(['- 项一\n\n  续行段落\n'])

    // 4 空格续段无法与「缩进代码块」区分，整个块保守地不切
    const fourSpaces = '- 项一\n\n    续行段落\n\n结尾'
    expect(splitMarkdownBlocks(fourSpaces).stableBlocks).toEqual([])
  })

  test('Given 列表后接新段落 When 切分 Then 列表与段落之间可切', () => {
    const text = '- 项一\n- 项二\n\n结尾段落'
    const { stableBlocks, tailBlock } = splitMarkdownBlocks(text)

    expect(stableBlocks).toEqual(['- 项一\n- 项二\n'])
    expect(tailBlock).toBe('结尾段落')
  })

  test('Given 列表项带缩进续行 When 续行前有空行 Then 整段不切', () => {
    const text = '- 项一\n\n  续行段落\n\n结尾'
    const { stableBlocks } = splitMarkdownBlocks(text)

    // 列表项与其续段必须同块；续段之后的普通段落可以切出去
    expect(stableBlocks).toEqual(['- 项一\n\n  续行段落\n'])
  })

  test('Given 引用块 When 引用之间有空行 Then 引用段不被拆开', () => {
    const text = '前言\n\n> 引用一\n\n> 引用二\n\n结尾'
    const { stableBlocks, tailBlock } = splitMarkdownBlocks(text)

    // 「两侧任一侧是引用」都保守不切，因此整段（含前言）留在同一个块
    expect(stableBlocks).toEqual([])
    expect(tailBlock).toBe(text)
  })

  test('Given 引用式链接定义 When 出现 Then 整体放弃切分', () => {
    const text = '见 [文档][ref]\n\n正常段落\n\n[ref]: https://example.com'
    const { stableBlocks, tailBlock, bailed } = splitMarkdownBlocks(text)

    expect(bailed).toBe(true)
    expect(stableBlocks).toEqual([])
    expect(tailBlock).toBe(text)
  })

  test('Given 脚注定义 When 出现 Then 整体放弃切分', () => {
    const text = '正文带脚注[^1]\n\n另一段\n\n[^1]: 脚注内容'
    expect(splitMarkdownBlocks(text).bailed).toBe(true)
  })

  test('Given 块级 HTML When 出现 Then 整体放弃切分', () => {
    expect(splitMarkdownBlocks('前言\n\n<div>\n内容\n</div>\n\n结尾').bailed).toBe(true)
    expect(splitMarkdownBlocks('前言\n\n<!-- 注释 -->\n\n结尾').bailed).toBe(true)
  })

  test('Given 跨行 $$ 公式 When 公式内有空行 Then 不在公式内部切', () => {
    const text = '前言\n\n$$\n\\begin{aligned}\na &= 1\n\nb &= 2\n\\end{aligned}\n$$\n\n结尾'
    const { stableBlocks, tailBlock } = splitMarkdownBlocks(text)

    expect(stableBlocks).toEqual(['前言\n', '$$\n\\begin{aligned}\na &= 1\n\nb &= 2\n\\end{aligned}\n$$\n'])
    expect(tailBlock).toBe('结尾')
    expectLossless(text)
  })

  test('Given 缩进代码块 When 空行后出现 Then 保持保守不切', () => {
    const text = '前言\n\n    缩进代码\n\n结尾'
    expect(splitMarkdownBlocks(text).stableBlocks).toEqual([])
  })

  test('Given 空文本或纯空白 When 切分 Then 不产生稳定块', () => {
    expect(splitMarkdownBlocks('')).toEqual({ stableBlocks: [], tailBlock: '', bailed: false })
    expect(splitMarkdownBlocks('   \n\n  ')).toEqual({ stableBlocks: [], tailBlock: '   \n\n  ', bailed: false })
  })

  test('Given 长文档逐行流式增长 When 按块切分 Then 累计重解析量远低于全量重解析', () => {
    // 这条测试把 P0 的收益变成可验证断言：切分的意义是让「每步要解析的字符数」
    // 只与尾块有关，而不是与整篇长度有关（后者是 O(n²)）。
    const sections: string[] = []
    for (let i = 0; i < 30; i++) {
      sections.push(`## 小节 ${i}\n\n第 ${i} 段正文，含 **加粗**、\`code\` 与 [链接](https://example.com)。`)
    }
    const full = sections.join('\n\n')
    const lines = full.split('\n')

    let incrementalChars = 0
    let naiveChars = 0
    let previousStable = new Set<string>()

    for (let end = 1; end <= lines.length; end++) {
      const text = lines.slice(0, end).join('\n')
      const { stableBlocks, tailBlock } = splitMarkdownBlocks(text)

      // 本步真正需要交给 react-markdown 解析的字符：尾块 + 本步首次冻结的块。
      // 其余稳定块内容未变，被 React.memo 直接跳过。
      const newlyFrozen = stableBlocks.filter((block) => !previousStable.has(block))
      incrementalChars += tailBlock.length + newlyFrozen.reduce((sum, block) => sum + block.length, 0)

      naiveChars += text.length
      previousStable = new Set(stableBlocks)
    }

    // 全量重解析：每步都解析整篇，累计是 O(n²)
    expect(naiveChars).toBeGreaterThan(50_000)
    // 按块切分：累计只相当于「整篇解析一次 + 每步解析一个小尾块」
    expect(incrementalChars).toBeLessThan(naiveChars / 10)
  })

  test('Given 全文只有一块 When 切分 Then 稳定块为空且尾块即原文', () => {
    const text = '只有一段，没有空行分隔'
    const { stableBlocks, tailBlock, bailed } = splitMarkdownBlocks(text)

    expect(bailed).toBe(false)
    expect(stableBlocks).toEqual([])
    expect(tailBlock).toBe(text)
  })

  test('Given 结尾带空行 When 切分 Then 空行归属前一个块且拼接无损', () => {
    const text = '第一段\n\n第二段\n\n'
    const { stableBlocks, tailBlock } = splitMarkdownBlocks(text)

    // 末尾空行后没有非空内容，不构成新边界 → 第二段与其后的空行一起进入尾块
    expect(stableBlocks).toEqual(['第一段\n'])
    expect(tailBlock).toBe('第二段\n\n')
    expectLossless(text)
  })

  test('Given 标题+段落+列表混合 When 切分 Then 受列表保护的部分合并、其余仍能独立成块', () => {
    const text = '## 标题\n\n说明段落\n\n1. 第一步\n2. 第二步\n\n结论段落'
    const { stableBlocks, tailBlock } = splitMarkdownBlocks(text)

    expect(stableBlocks).toEqual(['## 标题\n', '说明段落\n\n1. 第一步\n2. 第二步\n'])
    expect(tailBlock).toBe('结论段落')
    expectLossless(text)
  })

  test('Given 主题分隔线与标题 When 切分 Then 各自能独立成块', () => {
    const text = '前言\n\n---\n\n## 小节\n\n小节正文'
    const { stableBlocks, tailBlock } = splitMarkdownBlocks(text)

    expect(stableBlocks).toEqual(['前言\n', '---\n', '## 小节\n'])
    expect(tailBlock).toBe('小节正文')
    expectLossless(text)
  })

  test('Given 硬换行结尾 When 空行紧随 Then 不切', () => {
    expect(splitMarkdownBlocks('第一行\\\n\n第二段').stableBlocks).toEqual([])
  })

  test('Given 未闭合围栏内的 @@ 公式标记 When 切分 Then 围栏优先、不被公式状态干扰', () => {
    const text = '前言\n\n```ts\nconst s = "$$"\n\nconst t = 1\n'
    expect(splitMarkdownBlocks(text).stableBlocks).toEqual(['前言\n'])
  })
})
