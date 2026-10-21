import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '@gugu/session-shared/markdown/dialect'
import { normalizeLatexMathDelimiters, normalizeLatexMathDelimitersWithLines, tokenizeMarkdownMath } from '../../../../packages/core/src/shared/markdownMath.mjs'
import {
  dollarRunBoundaryFixtures,
  markdownStructureBoundaryFixtures,
} from './markdownMathDelimiterRunFixtures'
// Run in a child process with a time limit: a hang there fails this test instead of freezing the run.
const MARKDOWN_MATH = fileURLToPath(new URL('../../../../packages/core/src/shared/markdownMath.mjs', import.meta.url))
type MdNode = {
  children?: MdNode[]
  type: string
}
// 复杂度判据量的是本线程真正花掉的 CPU(只计本线程),❌ 墙钟:机器一忙,墙钟里还含着排不上 CPU 的等待,
// 与算法做了多少功无关。运行时是 .node-version 的 node 24;@types/node 仍是 20.x,没有这条声明。
const threadCpuUsage = (process as NodeJS.Process & { threadCpuUsage(previous?: NodeJS.CpuUsage): NodeJS.CpuUsage })
  .threadCpuUsage.bind(process)
function cpuMsOf<T>(work: () => T): { result: T; cpuMs: number } {
  const before = threadCpuUsage()
  const result = work()
  const spent = threadCpuUsage(before)
  return { result, cpuMs: (spent.user + spent.system) / 1000 }
}
// The renderer's grammar is the shared dialect: its boundaries are what every markdown surface paints.
async function rendererBoundaryNodes(markdown: string): Promise<string[]> {
  const tree = parseMarkdown(markdown) as MdNode
  const boundaries: string[] = []
  const visit = (node: MdNode) => {
    if (['code', 'inlineCode', 'inlineMath', 'math'].includes(node.type)) boundaries.push(node.type)
    node.children?.forEach(visit)
  }
  visit(tree)
  return boundaries
}
describe('normalizeLatexMathDelimiters', () => {
  it('normalizes Codex inline and display delimiters for remark-math', () => {
    const markdown = [
      'inline \\(a^2+b^2=c^2\\)',
      '\\[',
      '\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}',
      '\\]'
    ].join('\n')
    const expected = [
      'inline $a^2+b^2=c^2$',
      '$$',
      '\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}',
      '$$'
    ].join('\n')
    expect(normalizeLatexMathDelimiters(markdown)).toBe(expected)
  })
  it('leaves inline and fenced code untouched', () => {
    const markdown = [
      'outside \\(rendered\\) and inline `\\(literal\\)`',
      '',
      '```tex',
      '\\[fenced\\]',
      '```',
      '',
      '~~~md',
      '\\(also_fenced\\)',
      '~~~'
    ].join('\n')
    const expected = [
      'outside $rendered$ and inline `\\(literal\\)`',
      '',
      '```tex',
      '\\[fenced\\]',
      '```',
      '',
      '~~~md',
      '\\(also_fenced\\)',
      '~~~'
    ].join('\n')
    expect(normalizeLatexMathDelimiters(markdown)).toBe(expected)
  })
  it('preserves existing dollar math, escaped delimiters, and unmatched delimiters', () => {
    const markdown = `$already$ $$also$$ ${'\\\\('}escaped${'\\\\)'} ${'\\('}unclosed`
    expect(normalizeLatexMathDelimiters(markdown)).toBe(markdown)
  })
  // @@@4254 会话页 .md 附件预览把 renderer 挂死:container 解析在 markdownContainerAt ↔
  // inheritedMarkdownContainerAt 之间指数级递归(每多一行 list marker 成本约 ×2)。本判据用事故文件的
  // 内容形态(list 行与 code fence 混排)固化。尺寸与阈值是实测标定的:此内容(24 行 list marker)未修复
  // tokenizer 在 M 系 Mac 上要 ~30s(每加一个 block ×~24,事故原文 30 行 list = 天级,整个 renderer 冻死),
  // 修复后 <5ms。阈值 2s(本线程 CPU)给绿侧 ~400 倍余量;回归时同步代码不受 vitest timeout 抢占,靠本断言在有界时间内红。
  it('tokenizes list-heavy documents with interleaved fences without exponential blowup', { timeout: 120_000 }, () => {
    const block = [
      '- 调用时间:紧接上一步',
      '- 工具名:`mcp__example__call`',
      '- 完整参数:',
      '',
      '```json',
      '{ "key": "value" }',
      '```',
      '',
      '- 工具返回错误:',
      '',
      '```text',
      'error: example failure line',
      '```',
      '',
    ]
    const markdown = Array.from({ length: 6 }, () => block).flat().join('\n')
    const { result: segments, cpuMs } = cpuMsOf(() => tokenizeMarkdownMath(markdown))
    // 每个 block:1 个 inline code span + 2 个 fence = 3 段 code × 6 block。
    expect(segments.filter((segment) => segment.kind === 'code').length).toBe(18)
    expect(segments.map((segment) => segment.raw).join('')).toBe(markdown)
    expect(cpuMs).toBeLessThan(2_000)
  })
  it('does not backtrack through every prose backtick in nested containers', () => {
    const markdown = Array.from({ length: 48 }, (_, index) =>
      `> > > routing row ${index} contains \`\`\` an inline fence marker`,
    ).join('\n')
    const { result: segments, cpuMs } = cpuMsOf(() => tokenizeMarkdownMath(markdown))
    expect(segments.map((segment) => segment.raw).join('')).toBe(markdown)
    expect(cpuMs).toBeLessThan(1_000)
  })
  it.each(dollarRunBoundaryFixtures)('$name', async ({ markdown, expectedSegments, rendererNodes, normalized }) => {
    expect(await rendererBoundaryNodes(markdown)).toEqual(rendererNodes)
    expect(tokenizeMarkdownMath(markdown)).toEqual(expectedSegments)
    expect(normalizeLatexMathDelimiters(markdown)).toBe(normalized ?? markdown)
  })
  it.each(markdownStructureBoundaryFixtures)('$name', async ({ markdown, expectedSegments, rendererNodes, normalized }) => {
    expect(await rendererBoundaryNodes(markdown)).toEqual(rendererNodes)
    expect(tokenizeMarkdownMath(markdown)).toEqual(expectedSegments)
    expect(normalizeLatexMathDelimiters(markdown)).toBe(normalized ?? markdown)
  })
  // #6950: `$$…$$` (or `\[…\]`) that is the whole line was set inline in the text line; GitHub sets it as a display.
  it('sets one-line display math that is the whole line as a display block, wherever the line sits', async () => {
    const cases: Array<[string, string]> = [
      ['$$E = mc^2$$', '$$\nE = mc^2\n$$'],
      ['\\[x^2\\]', '$$\nx^2\n$$'],
      ['  $$ a+b $$  ', '  $$\n  a+b\n  $$  '],
      ['> $$x$$', '> $$\n> x\n> $$'],
      ['- $$x$$', '- $$\n  x\n  $$'],
      ['1. $$x$$', '1. $$\n   x\n   $$'],
      ['text\n$$x$$\nmore', 'text\n$$\nx\n$$\nmore'],
    ]
    for (const [markdown, expected] of cases) {
      const normalized = normalizeLatexMathDelimiters(markdown)
      expect(normalized).toBe(expected)
      expect(await rendererBoundaryNodes(normalized)).toEqual(['math'])
    }
  })
  it('leaves display math that shares its line with text, code, or a table inline — and indented code alone', async () => {
    for (const markdown of [
      'area $$x$$ here',
      '$$a$$ and $$b$$',
      '`$$x$$`',
      '    $$x$$',
      '| $$x$$ |\n| - |\n| 1 |',
      '$$$x$$$',
    ]) {
      expect(normalizeLatexMathDelimiters(markdown)).toBe(markdown)
    }
    expect(await rendererBoundaryNodes(normalizeLatexMathDelimiters('area $$x$$ here'))).toEqual(['inlineMath'])
  })
})

// #7238: a page that finds a line's block (gugu.markdown sourceLines) reads positions in the rewritten text back in the
// lines a person wrote — the one-line display set as three is the one rewrite that adds lines.
describe('normalizeLatexMathDelimitersWithLines: each rewritten line says the source line it came from', () => {
  it('a one-line display adds two lines, all three of its one line; the lines after shift back; others add none', () => {
    const source = ['para', '$$a^2$$', 'after', '\\[b\\]', 'end'].join('\n')
    const { text, lineOf } = normalizeLatexMathDelimitersWithLines(source)
    expect(text).toBe(normalizeLatexMathDelimiters(source))
    expect(text.split('\n')).toEqual(['para', '$$', 'a^2', '$$', 'after', '$$', 'b', '$$', 'end'])
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map(lineOf)).toEqual([1, 2, 2, 2, 3, 4, 4, 4, 5])
    // Control: text with no one-line display maps line to line.
    const plain = normalizeLatexMathDelimitersWithLines('a\n$x$ and \\(y\\)\nb')
    expect([1, 2, 3].map(plain.lineOf)).toEqual([1, 2, 3])
  })
})

// 单美元公式照 pandoc(tex_math_dollars)认:开头的 $ 后面不能是空白,结尾的 $ 前面不能是空白、后面不能紧跟数字。
// 不然一句话里的两个价格之间的字被当成公式,渲染成斜体乱码(「…Backpack $29.99、Bike Light $9.99…」)。
// 渲染(共用方言)与 message_send 校验用的分词(tokenizeMarkdownMath)必须一起改、认法一致。
describe('single-dollar math follows pandoc: prices stay prose', () => {
  const prose: string[] = [
    '…Backpack $29.99、Bike Light $9.99、Water Bottle $12.50…',
    'It costs $5 and $10 today.',
    '价格是$29.99和$9.99',
    'US$12 and US$30',
    '$ x $',
    '$x $',
    '$ x$',
    '$a$5',
    'from $5 to $10, roughly $7.5',
    'line one $5\nline two $10',
    'Cost $5 off\n\nx$y',
    '> quote $5 off\n>\n> x$y',
    '| item | price |\n| - | - |\n| a | $5 |\n| b | $10 |',
  ]
  it.each(prose)('%s: no inline math anywhere', async (markdown) => {
    expect(await rendererBoundaryNodes(markdown)).toEqual([])
    expect(tokenizeMarkdownMath(markdown).every((segment) => segment.kind === 'prose')).toBe(true)
  })

  const math: Array<[string, string[]]> = [
    ['$E=mc^2$', ['E=mc^2']],
    ['面积是 $x^2$。', ['x^2']],
    ['$x$, $y$ and $z$', ['x', 'y', 'z']],
    ['$a$-$b$', ['a', 'b']],
    ['($x$)', ['x']],
    ['cost $5 but $x$ is math', ['x']],
    ['$x+1$ then $2$', ['x+1', '2']],
    ['$$a b$$ inline double', ['a b']],
    ['$$ a $$ inline double keeps its spaces', [' a ']],
    ['$x\n+y$ across a line break', ['x\n+y']],
    ['\\$5 escaped, then $x$', ['x']],
    ['> a $x\n>$y$', ['y']],
    ['- a $x\n  $y$', ['y']],
  ]
  it.each(math)('%s: still math', async (markdown, contents) => {
    expect(await rendererBoundaryNodes(markdown)).toEqual(contents.map(() => 'inlineMath'))
    expect(tokenizeMarkdownMath(markdown).filter((segment) => segment.kind === 'math').map((segment) => segment.content)).toEqual(contents)
  })

  it('\\(…\\) rewritten to dollars stays math: spaces inside are trimmed, a digit right after gets double dollars', async () => {
    const cases: Array<[string, string, number]> = [
      ['area \\( x^2 \\) here', 'area $x^2$ here', 1],
      ['\\(x\\)5 times', '$$x$$5 times', 1],
      // A line break at an edge moves outside the dollars (with the next line's container prefix): no line added or
      // lost, and no `$$` at a line start opening a math block that swallows what follows.
      ['see \\(x\n\\) here', 'see $x$\n here', 1],
      ['intro\n\\(x\n\\) tail\n\nnext para with $y$', 'intro\n$x$\n tail\n\nnext para with $y$', 2],
      ['x\n\\(\nx\\) here\n\nnext para', 'x\n\n$x$ here\n\nnext para', 1],
      ['- a \\(x\n  \\) b', '- a $x$\n   b', 1],
      ['> a \\(x\n> \\) b', '> a $x$\n>  b', 1],
    ]
    for (const [markdown, expected, maths] of cases) {
      expect(normalizeLatexMathDelimiters(markdown)).toBe(expected)
      expect(normalizeLatexMathDelimiters(markdown).split('\n').length).toBe(markdown.split('\n').length)
      expect(await rendererBoundaryNodes(expected)).toEqual(Array(maths).fill('inlineMath'))
    }
  })
})

// Text that starts with a line break and has a fence or `$$` from its third line on: finding the line before line 1
// asked `lastIndexOf('\n', -1)`, got line 1 back, and looped forever — message_send validation hung on such a message.
describe('tokenizeMarkdownMath on text starting with a line break', () => {
  it.each(['\n\n```', '\n\n$$x$$', '\nx\n$$y$$', '\n\n- a\n  ```\n  b\n  ```'])('%j finishes', (markdown) => {
    const probe = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `import { tokenizeMarkdownMath } from ${JSON.stringify(MARKDOWN_MATH)}; process.stdout.write(tokenizeMarkdownMath(${JSON.stringify(markdown)}).map((s) => s.raw).join(''))`],
      { timeout: 10_000, encoding: 'utf8' }
    )
    expect(probe.signal).toBeNull()
    expect(probe.stdout).toBe(markdown)
  })
})
