import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@gugu/core/cloud/config', async (original) => ({
  ...(await original<object>()),
  getSupabaseUrl: () => 'http://supabase.test.local',
  getSupabaseAnonKey: () => 'test-anon-key',
}))
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))

const { MessageBubble } = await import('@/components/chat/MessageBubble')

let harness: ReturnType<typeof createReactHarness>
afterEach(() => harness?.cleanup())

const TABLE_MESSAGE = [
  '你记得没错，之前确实跑过这些类别。我已核对实验文件。',
  '',
  '| 实验 | 旧文件核对结果 |',
  '| --- | --- |',
  '| 参数强度、步数曲线 | P0 的 36 组、P1 的 16 组都存在，JSON、12220 张 PNG 路径和 drift 检查通过 |',
  '| 存活率校准 | T=50/150/200 都有旧结果，当前文件已完整复核 |',
  '| 防御评估 E5 | 完整 9000 条，9 组各 1000 条记录齐全且有限 |',
  '| 开销表 E6 | 已有 Ours、ADA、MIM、DIM、TIM 数据和显存探针 |',
  '',
  '所以，旧开销表和旧参数曲线现在就能看。',
].join('\n')

it('keeps a wide markdown table inside a phone message bubble', async () => {
  const viewportWidth = 390
  await page.viewport(viewportWidth, 844)
  harness = createReactHarness()
  harness.container.className = 'gugu-skin emlight'
  harness.container.style.cssText = `position:fixed;inset:0 auto auto 0;width:${viewportWidth}px`
  await renderWithAppProviders(harness, <MessageBubble
    msg={message({ id: 'wide-table', is_mine: false, content: TABLE_MESSAGE })}
    isGroup
    compactMobile
    onReaction={vi.fn()}
    onQuote={vi.fn()}
    onForward={vi.fn()}
    onDelete={vi.fn()}
  />)

  await until('markdown table rendered', () => !!harness.container.querySelector('.gg-md table'))
  const bubble = harness.container.querySelector<HTMLElement>('[data-testid="message-bubble-action-target"]')!
  const tableScroller = harness.container.querySelector<HTMLElement>("[data-streamdown='table-wrapper'] > div")!
  const viewportRight = harness.container.getBoundingClientRect().right

  expect(bubble.getBoundingClientRect().right, 'the bubble escaped the phone viewport').toBeLessThanOrEqual(viewportRight)
  expect(tableScroller.getBoundingClientRect().right, 'the table scroll box escaped the bubble').toBeLessThanOrEqual(bubble.getBoundingClientRect().right)
  expect(getComputedStyle(tableScroller).overflowX).toBe('auto')
  expect(tableScroller.scrollWidth, 'the table was squeezed instead of scrolling locally').toBeGreaterThan(tableScroller.clientWidth)
  expect(harness.container.scrollWidth, 'the message row made the phone page scroll sideways').toBeLessThanOrEqual(viewportWidth)
})

it('keeps a short phone message fitted to its text', async () => {
  await page.viewport(390, 844)
  harness = createReactHarness()
  harness.container.className = 'gugu-skin emlight'
  harness.container.style.cssText = 'position:fixed;inset:0 auto auto 0;width:390px'
  await renderWithAppProviders(harness, <MessageBubble
    msg={message({ id: 'short', is_mine: false, content: '短消息' })}
    isGroup
    compactMobile
    onReaction={vi.fn()}
    onQuote={vi.fn()}
    onForward={vi.fn()}
    onDelete={vi.fn()}
  />)

  const bubble = harness.container.querySelector<HTMLElement>('[data-testid="message-bubble-action-target"]')!
  const column = harness.container.querySelector<HTMLElement>('[data-message-bubble-column="true"]')!
  expect(bubble.getBoundingClientRect().width, 'the width guard stretched a short bubble').toBeLessThan(column.getBoundingClientRect().width)
})
