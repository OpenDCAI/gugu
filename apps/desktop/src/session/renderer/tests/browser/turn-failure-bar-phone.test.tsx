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
it.each(['zh-CN', 'en-US'] as const)('%s: a long session title keeps the phone failure bar one row — name shortened, reason fills the rest in at most two lines', async (locale) => {
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
  const bar = host.querySelector<HTMLElement>('.atf-bar')!.getBoundingClientRect()
  const message = host.querySelector<HTMLElement>('.atf-msg')!.getBoundingClientRect()
  const retry = host.querySelector<HTMLElement>('[data-testid="agent-turn-failure-retry"]')!.getBoundingClientRect()
  const dismiss = host.querySelector<HTMLElement>('[data-testid="agent-turn-failure-dismiss"]')!.getBoundingClientRect()
  const name = host.querySelector<HTMLElement>('.atf-nm')!.getBoundingClientRect()
  const lineHeight = Number.parseFloat(getComputedStyle(host.querySelector('.atf-msg')!).lineHeight)
  expect(Math.abs(name.top + name.height / 2 - (message.top + message.height / 2)), 'name and reason share one row').toBeLessThanOrEqual(1)
  expect(message.height, 'the reason takes at most two lines').toBeLessThanOrEqual(lineHeight * 2 + 1)
  expect(message.width, 'the reason takes the room the name gave up').toBeGreaterThan(name.width)
  expect(bar.height, 'the bar stays a short notice').toBeLessThan(80)
  for (const control of [retry, dismiss]) expect(control.right).toBeLessThanOrEqual(bar.right)
  await page.getByTestId('agent-turn-failure').screenshot({ path: `turn-failure-bar-phone-${locale}.png` })
})
