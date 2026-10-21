/**
 * #7333 输入框上方的引用预览(InputArea 的 quoteContent 条):标题与摘录 = 紧凑界面 14/20,宽度上限 240、省略号、
 * 取消引用的回调照旧。渲染的是真 InputArea(同 input-area-mention-escape 的挂法),判 getComputedStyle。
 * 已发出的引用(气泡里的那一条)是另一个元素,判据在 im-message-meta-7333.test.tsx。
 */
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { InputArea } from '@/components/chat/InputArea'
import { i18n, LocalizationProvider, setLocalePreference } from '@/i18n'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'
import { until } from '../../../../../../../tests/support/awaitCondition'

const COMPACT = { size: 14, leading: 20 } as const
const LONG = '这一段被引用的原话很长很长,长到引用预览一定放不下,只能在末尾收成省略号。'.repeat(2)
const px = (value: string) => Number.parseFloat(value) || 0
const tier = (element: Element | null) => {
  if (!element) return null
  const style = getComputedStyle(element)
  return { size: px(style.fontSize), leading: Math.round(px(style.lineHeight)) }
}

let root: Root | null = null
let host: HTMLDivElement | null = null
afterEach(() => {
  root?.unmount()
  host?.remove()
  root = null
  host = null
})

describe('the composer\'s quote preview in the master\'s tiers (#7333)', () => {
  it('title and excerpt read 14/20; the strip stays within 240 and cuts the long excerpt; cancel still drops the quote', async () => {
    setLocalePreference('zh-CN')
    const onQuoteConsumed = vi.fn()
    host = document.createElement('div')
    host.style.width = '720px'
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(
      <LocalizationProvider>
        <InputArea onSend={vi.fn(async () => {})} quoteContent={{ messageId: 'msg-0', senderName: '林知夏', content: LONG }} onQuoteConsumed={onQuoteConsumed} />
      </LocalizationProvider>,
    )
    const find = (text: string) => [...host!.querySelectorAll<HTMLElement>('div')].filter((el) => el.textContent === text).at(-1) ?? null
    await until('the quote preview rendered', () => find(LONG) !== null)
    const excerpt = find(LONG)!
    const title = find('林知夏')!
    expect(tier(title), 'the preview title').toEqual(COMPACT)
    expect(tier(excerpt), 'the preview excerpt').toEqual(COMPACT)
    expect(excerpt.scrollWidth, 'the long excerpt was not cut: the ellipsis is untested').toBeGreaterThan(excerpt.clientWidth)
    expect(getComputedStyle(excerpt).textOverflow).toBe('ellipsis')
    expect(Math.round(excerpt.parentElement!.getBoundingClientRect().width), 'the preview outgrew its 240 cap').toBeLessThanOrEqual(240)
    await page.getByRole('button', { name: i18n.t('composer.cancelQuote', { ns: 'messaging' }) }).click()
    expect(onQuoteConsumed).toHaveBeenCalledTimes(1)
  })
})
