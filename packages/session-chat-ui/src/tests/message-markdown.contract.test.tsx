/** @jsxImportSource solid-js */
/**
 * Real-rendered DOM geometry contracts for message roots and every markdown
 * BlockFrame leaf. These inspect the content inside an engine-sized root;
 * `measure() === offsetHeight` alone only compares two height formulas.
 *
 * The leaf list is closed by the compiler, not by hand: `markdownCases` is an
 * exhaustive switch over `Block['kind']`, so a new block kind cannot be added
 * to the registry without also being answered for here.
 */

import { codeLine, codeWrapper } from '@session-chat/components/rows/markdown/code/code.css'
import { codeBlockDef } from '@session-chat/components/rows/markdown/code/code.def'
import { htmlBlockDef } from '@session-chat/components/rows/markdown/html/html.def'
import { mathBlockDef } from '@session-chat/components/rows/markdown/math/math.def'
import { mermaidBlockDef } from '@session-chat/components/rows/markdown/mermaid/mermaid.def'
import { messageUnitDef } from '@session-chat/components/rows/message/message.def'
import { srOnly } from '@session-chat/components/rows/message/message.css'
import { resourceLinkUnitDef } from '@session-chat/components/rows/resource-link/resource-link.def'
import type { Block, HtmlBlock } from '@session-chat/core/markdown/document'
import { parseMarkdownToBlocks } from '@session-chat/core/markdown/parse'
import type { ChatMessage, ChatResourceLink } from '@session-chat/model'
import { afterAll, describe, expect, it } from 'vitest'
import {
  makeContractCtx,
  renderAndMeasureBlock,
  renderAndMeasureUnit,
  type ContractInspector,
  type HeightContractReading
} from './contract'

const WIDTH = 420

let measuredRoots = 0
let renderedElements = 0

function px(value: string): number {
  return Number.parseFloat(value) || 0
}

function expectHeightMatch(layer: string, reading: HeightContractReading): void {
  const delta = reading.dom - reading.computed
  expect(
    reading.dom,
    `${layer} height mismatch: engine=${reading.computed}px DOM=${reading.dom}px delta=${delta}px`
  ).toBe(reading.computed)
}

function rootOf(host: HTMLElement): HTMLElement | null {
  return host.firstElementChild as HTMLElement | null
}

const inspectMessageRoot: ContractInspector = (host) => {
  const root = rootOf(host)
  if (!root) {
    return { rootFound: 0, contentCount: 0, rootBox: 0, clientBox: 0, contentExtent: 0, occupiedBox: 0 }
  }

  const style = getComputedStyle(root)
  const content = Array.from(root.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && !child.classList.contains(srOnly)
  )
  const chrome =
    px(style.paddingTop) +
    px(style.paddingBottom) +
    px(style.borderTopWidth) +
    px(style.borderBottomWidth)

  return {
    rootFound: 1,
    contentCount: content.length,
    rootBox: root.offsetHeight,
    clientBox: root.clientHeight,
    contentExtent: root.scrollHeight,
    occupiedBox: content.reduce((sum, child) => sum + child.offsetHeight, chrome)
  }
}

const assistantMessage: ChatMessage = {
  kind: 'message',
  id: 'inner-message-assistant',
  role: 'assistant',
  text: 'First rendered line.\n\nSecond rendered line.'
}

const thoughtMessage: ChatMessage = {
  kind: 'message',
  id: 'inner-message-thought',
  role: 'thought',
  text: 'A measured thought with enough words to wrap at the contract width.'
}

const userMessage: ChatMessage = {
  kind: 'message',
  id: 'inner-message-user',
  role: 'user',
  text: 'A user message whose card content stays below the clamp.',
  attachments: [{ id: 'missing-image', name: 'missing.png' }]
}

/**
 * 非图片附件是一枚**整行**的 chip(#5269)。这条钉的是它的**盒模型**:chip 声明的高度是
 * `attachThumb`,而 `attachStripHeight` 报的也是这个数 —— 边框或内距只要有一格没算进去,
 * 这里就会红(content-box 下每行会悄悄高 2px)。名字故意取得很长,顺带钉住「宽了要省略号
 * 截断」:撑成两行同样破契约。
 *
 * ⚠️ 只放**一件**。两件就越过折叠阈值,那时卡片本来就该夹住并多渲一层渐隐罩,红的是 clamp
 * 不是测量(实测 scroll 132 / client 118,那 14px 正是罩子)。行数的算术归 `metrics.test.ts`,
 * 那儿不受阈值影响。
 */
const userMessageWithFiles: ChatMessage = {
  kind: 'message',
  id: 'inner-message-user-files',
  role: 'user',
  text: 'One file.',
  attachments: [
    {
      id: 'path:/u/very-long.csv',
      name: 'a-file-name-long-enough-to-need-truncating-inside-the-chip.csv',
      kind: 'file'
    }
  ]
}

describe('message roots hold the real-rendered content the engine reserved', () => {
  it.each([
    { label: 'assistant message', item: assistantMessage, width: WIDTH },
    { label: 'thought message', item: thoughtMessage, width: 180 },
    { label: 'user message', item: userMessage, width: WIDTH },
    { label: 'user message with file chips', item: userMessageWithFiles, width: WIDTH }
  ])('$label', async ({ label, item, width }) => {
    const reading = await renderAndMeasureUnit(
      messageUnitDef,
      item,
      makeContractCtx({ width }),
      inspectMessageRoot
    )
    measuredRoots += 1
    renderedElements += reading.renderedElements
    expectHeightMatch(label, reading)

    const { rootFound, contentCount, rootBox, clientBox, contentExtent, occupiedBox } = reading.inspected
    expect(rootFound, `${label}: inspector found no rendered message root`).toBe(1)
    expect(contentCount, `${label}: rendered root had no visible content boxes`).toBeGreaterThan(0)
    expect(
      contentExtent,
      `${label}: content laid out ${contentExtent}px inside a ${clientBox}px client box`
    ).toBe(clientBox)
    expect(
      occupiedBox,
      `${label}: rendered content and chrome occupy ${occupiedBox}px inside a ${rootBox}px root`
    ).toBe(rootBox)
  })
})

const overflowingResourceLink: ChatResourceLink = {
  kind: 'resource-link',
  id: 'inner-resource-link',
  uri: `file:///repo/${'deeply-nested-directory/'.repeat(8)}component.tsx`,
  name: `${'extremely-long-resource-name-'.repeat(4)}component.tsx`,
  target: {
    kind: 'workspace-file',
    path: `${'deeply-nested-directory/'.repeat(8)}component.tsx`
  }
}

const inspectLeafRoot: ContractInspector = (host) => {
  const root = rootOf(host)
  const child = root?.firstElementChild as HTMLElement | null
  return {
    rootFound: root ? 1 : 0,
    contentCount: child ? 1 : 0,
    rootBox: root?.clientHeight ?? 0,
    occupiedBox: child?.offsetHeight ?? 0,
    contentExtent: root?.scrollHeight ?? 0
  }
}

describe('resource-link leaf stays inside its engine-sized row', () => {
  it('does not wrap beyond the fixed row height', async () => {
    const reading = await renderAndMeasureUnit(
      resourceLinkUnitDef,
      overflowingResourceLink,
      makeContractCtx({ width: 180 }),
      inspectLeafRoot
    )
    measuredRoots += 1
    renderedElements += reading.renderedElements
    expectHeightMatch('resource-link leaf', reading)

    const { rootFound, contentCount, rootBox, occupiedBox, contentExtent } = reading.inspected
    expect(rootFound, 'resource-link inspector found no rendered root').toBe(1)
    expect(contentCount, 'resource-link inspector found no rendered leaf').toBeGreaterThan(0)
    expect(
      contentExtent,
      `resource-link content laid out ${contentExtent}px inside a ${rootBox}px row`
    ).toBe(rootBox)
    expect(
      occupiedBox,
      `resource-link leaf occupies ${occupiedBox}px inside a ${rootBox}px row`
    ).toBe(rootBox)
  })
})

function textRun(id: string, markdown: string): HtmlBlock {
  const [block] = parseMarkdownToBlocks(id, markdown)
  if (block?.kind !== 'html') throw new Error(`expected one text run for ${id}`)
  return block
}

const blocks = [
  {
    label: 'text run',
    block: textRun('inner-text', 'Enough prose to wrap onto multiple real-rendered lines at this width.')
  },
  {
    label: 'code block',
    block: {
      kind: 'code',
      id: 'inner-block#1',
      lang: 'typescript',
      code: 'const reserved = measure();\nexpect(rendered).toBe(reserved);'
    }
  },
  {
    label: 'mermaid block',
    block: {
      kind: 'mermaid',
      id: 'inner-block#2',
      source: 'graph TD; A-->B;'
    }
  },
  {
    label: 'text run with a rule',
    block: textRun('inner-rule', 'Above.\n\n---\n\nBelow.')
  },
  {
    label: 'text run with a table',
    block: textRun('inner-table', '| Layer | Reading |\n| --- | --- |\n| engine | reserved |\n| browser | rendered |')
  },
  {
    // A fraction over a radical: the shape whose height no formula predicts,
    // which is why this block is measured by really typesetting it.
    label: 'math block',
    block: {
      kind: 'math',
      id: 'inner-block#5',
      tex: '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}'
    }
  }
] satisfies Array<{ label: string; block: Block }>

const inspectHtml: ContractInspector = (host) => {
  const root = rootOf(host)
  const run = root?.querySelector<HTMLElement>('.gg-md')
  return {
    rootFound: root ? 1 : 0,
    contentCount: run?.children.length ?? 0,
    rootBox: root?.clientHeight ?? 0,
    // Rounded up as `measure()` rounds: a table's borders leave a fractional box.
    occupiedBox: run ? Math.ceil(run.getBoundingClientRect().height) : 0,
    contentExtent: root?.scrollHeight ?? 0
  }
}

const inspectCode: ContractInspector = (host) => {
  const root = rootOf(host)
  const wrapper = host.querySelector<HTMLElement>(`.${codeWrapper}`)
  const lines = Array.from(host.querySelectorAll<HTMLElement>(`.${codeLine}`))
  const wrapperStyle = wrapper ? getComputedStyle(wrapper) : null
  const minTop = lines.length > 0 ? Math.min(...lines.map((line) => line.offsetTop)) : 0
  const maxBottom = lines.length > 0 ? Math.max(...lines.map((line) => line.offsetTop + line.offsetHeight)) : 0
  const border = wrapperStyle
    ? px(wrapperStyle.borderTopWidth) + px(wrapperStyle.borderBottomWidth)
    : 0

  return {
    rootFound: root ? 1 : 0,
    contentCount: lines.length,
    rootBox: root?.clientHeight ?? 0,
    occupiedBox: border + 2 * minTop + (maxBottom - minTop),
    contentExtent: wrapper?.scrollHeight ?? 0,
    clientBox: wrapper?.clientHeight ?? 0
  }
}

const inspectFillBlock: ContractInspector = (host) => {
  const root = rootOf(host)
  const child = root?.firstElementChild as HTMLElement | null
  return {
    rootFound: root ? 1 : 0,
    contentCount: child ? 1 : 0,
    rootBox: root?.clientHeight ?? 0,
    occupiedBox: child?.offsetHeight ?? 0,
    contentExtent: root?.scrollHeight ?? 0
  }
}

const inspectMermaid: ContractInspector = (host) => {
  const reading = inspectFillBlock(host)
  const root = rootOf(host)
  return {
    ...reading,
    aspectHeight: root ? Math.round((root.offsetWidth * 9) / 21) : 0
  }
}

const inspectMath: ContractInspector = (host) => {
  const reading = inspectFillBlock(host)
  return {
    ...reading,
    // Liveness: the fill box could satisfy every geometry reading above while
    // holding no typeset output at all.
    katexRoots: host.querySelectorAll('.katex').length
  }
}

type MarkdownCase = {
  label: string
  block: Block
  inspect: ContractInspector
}

const markdownCases: MarkdownCase[] = blocks.map(({ label, block }) => {
  switch (block.kind) {
    case 'html':
      return { label, block, inspect: inspectHtml }
    case 'code':
      return { label, block, inspect: inspectCode }
    case 'mermaid':
      return { label, block, inspect: inspectMermaid }
    case 'math':
      return { label, block, inspect: inspectMath }
  }
})

describe('markdown BlockFrames hold their real-rendered leaf geometry', () => {
  it.each(markdownCases)('$label', async ({ label, block, inspect }) => {
    const ctx = makeContractCtx({ width: WIDTH })
    let reading: HeightContractReading
    switch (block.kind) {
      case 'html':
        reading = await renderAndMeasureBlock(htmlBlockDef, block, ctx, inspect)
        break
      case 'code':
        reading = await renderAndMeasureBlock(codeBlockDef, block, ctx, inspect)
        break
      case 'mermaid':
        reading = await renderAndMeasureBlock(mermaidBlockDef, block, ctx, inspect)
        break
      case 'math':
        reading = await renderAndMeasureBlock(mathBlockDef, block, ctx, inspect)
        break
      default:
        throw new Error(`Unsupported markdown contract block: ${block satisfies never}`)
    }

    measuredRoots += 1
    renderedElements += reading.renderedElements
    expectHeightMatch(label, reading)

    const { rootFound, contentCount, rootBox, occupiedBox, contentExtent } = reading.inspected
    const contentBox = reading.inspected.clientBox ?? rootBox
    expect(rootFound, `${label}: inspector found no rendered BlockFrame`).toBe(1)
    expect(contentCount, `${label}: inspector found no rendered leaf content`).toBeGreaterThan(0)
    expect(
      contentExtent,
      `${label}: content laid out ${contentExtent}px inside a ${contentBox}px content box`
    ).toBe(contentBox)
    expect(
      occupiedBox,
      `${label}: real-rendered leaf geometry occupies ${occupiedBox}px inside a ${rootBox}px BlockFrame`
    ).toBe(rootBox)
    if (block.kind === 'mermaid') {
      expect(
        reading.inspected.aspectHeight,
        `${label}: rendered 21:9 width resolves to ${reading.inspected.aspectHeight}px, root is ${rootBox}px`
      ).toBe(rootBox)
    }
  })
})

afterAll(() => {
  expect(measuredRoots, 'message/markdown contract measured zero roots').toBeGreaterThan(0)
  expect(renderedElements, 'message/markdown contract rendered zero DOM elements').toBeGreaterThan(0)
})
