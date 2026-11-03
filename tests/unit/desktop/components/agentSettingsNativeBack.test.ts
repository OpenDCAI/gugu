// @vitest-environment jsdom
// 2026-09-29 手机巡检:Agent 设置进了详情层,按安卓返回键整个设置都关了;左上箭头却是回 nav 层。返回键要与左上箭头同一件事。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSettingsModal } from '../../../../apps/desktop/src/components/agentsettings/AgentSettingsModal'
import { clearAgentDisplayStatusOverrides } from '../../../support/agentDisplayStatusTestDouble'
import { clickElement, contact, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../../support/agentDisplayStatusTestDouble'))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => true }))

type BackState = Window & { __guguNativeBackHandled?: boolean }
const back = async () => {
  const state = window as BackState
  state.__guguNativeBackHandled = false
  await act(async () => { window.dispatchEvent(new CustomEvent('gugu:native-back')) })
  return state.__guguNativeBackHandled
}
const topLeft = () => document.body.querySelector<HTMLButtonElement>('[data-testid="agent-settings-modal"] button[aria-label]')

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => {
  clearAgentDisplayStatusOverrides()
  harness.cleanup()
})

describe('手机 Agent 设置:返回键与左上箭头同一件事', () => {
  it.each(['native back', 'Escape'])('%s: 详情先回 nav，nav 再关闭', async (key) => {
    const trigger = async () => {
      if (key === 'native back') { expect(await back()).toBe(true); return }
      const popup = document.querySelector<HTMLElement>('[data-testid="agent-settings-modal"]')!
      await act(async () => {
        popup.focus()
        popup.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      })
    }
    const onClose = vi.fn()
    await renderWithAppProviders(
      harness,
      createNode(AgentSettingsModal, { agent: contact({ id: 'agent-1', display_name: 'Pico', type: 'agent', owner_user_id: 'owner-1' }), onClose }),
      { auth: { id: 'owner-1' }, contacts: {} },
    )
    expect(topLeft()?.getAttribute('aria-label')).toBe('关闭')
    await clickElement(document.body.querySelector<HTMLButtonElement>('[data-testid="agent-settings-modal"] nav button')!)
    expect(topLeft()?.getAttribute('aria-label')).toBe('返回')

    await trigger()
    expect(onClose).not.toHaveBeenCalled()
    expect(topLeft()?.getAttribute('aria-label')).toBe('关闭')

    await trigger()
    expect(onClose).toHaveBeenCalledOnce()
  })
})
