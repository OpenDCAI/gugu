// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from '../../../../apps/desktop/src/components/chat/MessageBubble'
import { createNode, createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'
vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))

// 聊天搜索时命中的词不能自己占一行。气泡正文外面是引用块那一列(flex 列),搜索时的正文是「文字、<mark>、文字」一串;
// 直接放进那一列,每一段都是一个 flex 项,一句「周末出游：今天的事」就竖着排成三行。整串得是同一段里的行内内容。
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

describe('MessageBubble search hit stays in its sentence', () => {
  it('the hit and the text around it are one inline run, not items of the flex column', async () => {
    await renderWithAppProviders(harness, createNode(MessageBubble, {
      msg: message({ id: 'msg-1', content: '周末出游：今天的事' }),
      highlight: '今天',
      onReaction: vi.fn(),
      memberReadSeqs: {},
      onQuote: vi.fn(),
      onForward: vi.fn(),
      onDelete: vi.fn(),
      isGroup: true,
    }))
    const mark = harness.container.querySelector('mark')
    if (!mark) throw new Error('no search hit rendered')
    expect(mark.textContent).toBe('今天')
    const run = mark.parentElement as HTMLElement
    expect(run.textContent).toBe('周末出游：今天的事')
    expect(run.style.display).not.toBe('flex')
  })
})
