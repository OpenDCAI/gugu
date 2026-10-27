import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { ResourceTimeline } from '@renderer/features/settings/components/resource-timeline'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { i18n } from '@/i18n'
import '@/styles/tokens.css'

vi.mock('@renderer/lib/ipc', async original => ({ ...(await original<object>()), rpc: { resourceMonitor: { history: async () => ({ success: true, data: { points: [], count: 0, bytes: 0 } }) } } }))
let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness() })
afterEach(() => h.cleanup())
for (const mobile of [false, true]) it(`only offers floating when the host supplies the action (mobile=${mobile})`, async () => {
  await page.viewport(mobile ? 390 : 1100, mobile ? 844 : 800)
  await i18n.changeLanguage('zh-CN')
  await h.render(<ResourceTimeline />)
  await until('history controls mount', () => h.container.querySelectorAll('button').length > 2)
  const floatButton = () => [...h.container.querySelectorAll('button')].find(button => button.textContent === translateSessionMessage('resourceMonitor.float'))
  expect(floatButton()).toBeUndefined()
  if (mobile) {
    const range = h.container.querySelector('.gg-resource-range')!.getBoundingClientRect()
    const actions = h.container.querySelector('.gg-resource-actions')!.getBoundingClientRect()
    expect(actions.top).toBeGreaterThanOrEqual(range.bottom + 8)
    const buttons = [...h.container.querySelectorAll('.gg-resource-actions button')].map(button => button.getBoundingClientRect())
    expect(buttons).toHaveLength(2)
    expect(buttons[0].top).toBe(buttons[1].top)
  }
  const onFloat = vi.fn()
  await h.render(<ResourceTimeline onFloat={onFloat} />)
  expect(floatButton()?.disabled).toBe(false)
  await page.getByRole('button', { name: translateSessionMessage('resourceMonitor.float'), exact: true }).click()
  expect(onFloat).toHaveBeenCalledOnce()
})
