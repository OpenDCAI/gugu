import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { LocalizationProvider, getLocaleSnapshot, setLocalePreference } from '@/i18n'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'

vi.mock('@/lib/supabase', async original => ({ ...(await original<object>()), requeueErroredDeviceCommand: vi.fn(async () => false) }))

const { AgentTurnFailureBar } = await import('@/components/AgentTurnFailureBar')

let root: Root | null = null
let host: HTMLDivElement | null = null
const previousLocale = getLocaleSnapshot().preference

afterEach(() => {
  setLocalePreference(previousLocale)
  root?.unmount()
  host?.remove()
  root = null
  host = null
})

// owner 10-28 手机试用:agent 名是一整条会话标题时,失败条在手机宽度里撑成半屏高、只剩图标和名字的空框。
it.each(['zh-CN', 'en-US'] as const)('%s: a long agent name leaves a readable phone failure card and reachable actions', async (locale) => {
  setLocalePreference(locale)
  await page.viewport(390, 844)
  host = document.body.appendChild(document.createElement('div'))
  host.style.cssText = 'width:390px'
  root = createRoot(host)
  root.render(
    <LocalizationProvider>
      <AgentTurnFailureBar
        failure={{ agentUserId: 'agent-1', commandId: 'command-1', at: 1, rawMessage: 'deliver failed' }}
        displayName="接手 Codex 114：#589 + 钉钉脚本 + 云电脑换版"
        avatar={null}
        onDismiss={() => {}}
      />
    </LocalizationProvider>,
  )
  await until('the failure bar has rendered', () => !!host?.querySelector('[data-testid="agent-turn-failure-retry"]'))
  const bar = host.querySelector<HTMLElement>('[role="status"]')!.getBoundingClientRect()
  const messageElement = host.querySelector<HTMLElement>('.tfc-reason')!
  const message = messageElement.getBoundingClientRect()
  const retry = host.querySelector<HTMLElement>('[data-testid="agent-turn-failure-retry"]')!.getBoundingClientRect()
  const dismiss = host.querySelector<HTMLElement>('[data-testid="agent-turn-failure-dismiss"]')!.getBoundingClientRect()
  const nameElement = host.querySelector<HTMLElement>('.tfc-name')!
  const name = nameElement.getBoundingClientRect()
  const titleElement = host.querySelector<HTMLElement>('.tfc-title')!
  const title = titleElement.getBoundingClientRect()
  const messageStyle = getComputedStyle(messageElement)
  const lineHeight = Number.parseFloat(messageStyle.lineHeight)
  const messageInsets = Number.parseFloat(messageStyle.borderTopWidth) + Number.parseFloat(messageStyle.borderBottomWidth)
    + Number.parseFloat(messageStyle.paddingTop) + Number.parseFloat(messageStyle.paddingBottom)
  expect(nameElement.scrollWidth, 'the long name is shortened').toBeGreaterThan(nameElement.clientWidth)
  expect(Math.abs(name.top + name.height / 2 - (title.top + title.height / 2)), 'name and failure title share the header row').toBeLessThanOrEqual(1)
  const titleText = document.createRange()
  titleText.selectNodeContents(titleElement)
  // 量字本身的宽与它的格子比,不设像素门槛:换字体也成立;差一点点也会被省略号吃掉,所以按亚像素比。
  expect(titleText.getBoundingClientRect().width, 'the failure title is shown whole, whatever the font').toBeLessThanOrEqual(title.width + 0.01)
  expect(message.top, 'the cause occupies its own row').toBeGreaterThanOrEqual(name.bottom - 1)
  expect(message.height - messageInsets, 'the cause text stays on one line').toBeLessThanOrEqual(lineHeight + 1)
  expect(message.width, 'the reason takes the room the name gave up').toBeGreaterThan(name.width)
  expect(message.width, 'the cause has readable horizontal space').toBeGreaterThan(120)
  expect(retry.top, 'the phone action row follows the cause').toBeGreaterThanOrEqual(message.bottom - 1)
  expect(bar.height, 'two text rows and one action row stay a compact notice').toBeLessThanOrEqual(lineHeight * 2 + retry.height + 28)
  const frame = host.getBoundingClientRect()
  expect(bar.left).toBeGreaterThanOrEqual(frame.left)
  expect(bar.right).toBeLessThanOrEqual(frame.right)
  for (const control of [retry, dismiss]) {
    expect(control.left).toBeGreaterThanOrEqual(bar.left)
    expect(control.right).toBeLessThanOrEqual(bar.right)
    expect(control.top).toBeGreaterThanOrEqual(bar.top)
    expect(control.bottom).toBeLessThanOrEqual(bar.bottom)
  }
  await page.getByTestId('agent-turn-failure').screenshot({ path: `turn-failure-bar-phone-${locale}.png` })
})
