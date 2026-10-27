// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentSettingsModal } from '../../../../apps/desktop/src/components/agentsettings/AgentSettingsModal'
import { clearAgentDisplayStatusOverrides } from '../../../support/agentDisplayStatusTestDouble'
import { clickElement, contact, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
const rig = vi.hoisted(() => ({ mobile: false }))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../../support/agentDisplayStatusTestDouble'))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => rig.mobile }))
vi.mock('../../../../apps/desktop/src/lib/agentScheduledTasks', () => ({ agentScheduledTaskService: { list: async () => [] } }))
let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness(); rig.mobile = false })
afterEach(() => { h.cleanup(); clearAgentDisplayStatusOverrides() })
const agent = contact({ id: 'a1', display_name: 'Test Agent', type: 'agent', owner_user_id: 'u1', desired_status: 'online' })
const navButtons = () => [...document.querySelectorAll<HTMLButtonElement>('[data-testid="agent-settings-modal"] nav button')]
const pause = () => document.querySelector<HTMLButtonElement>('[data-testid="agent-profile-pause"] [role="switch"]')!

it.each([false, true])('keeps implemented navigation in order and starts on profile (mobile=%s)', async mobile => {
  rig.mobile = mobile
  await renderWithAppProviders(h, <AgentSettingsModal agent={agent} />, { auth: { id: 'u1' }, contacts: {} })
  expect(navButtons().map(button => button.textContent?.trim())).toEqual(['资料', '分享', '定时任务', '设置', 'AI 模型'])
  expect(navButtons().filter(button => button.classList.contains('gg-as-tab--on')).map(button => button.textContent?.trim())).toEqual(['资料'])
  expect(document.body.textContent).not.toMatch(/即将开放|即将推出|即将支持|敬请期待/)
  if (mobile) await clickElement(navButtons()[0])
  expect(pause()).not.toBeNull()
  expect(pause().getAttribute('aria-checked')).toBe('false')
})

it('pauses and resumes through the original status service from the profile row', async () => {
  const setAgentDesiredStatus = vi.fn(async () => {})
  const render = (desired_status: 'online' | 'offline') => renderWithAppProviders(h, <AgentSettingsModal agent={{ ...agent, desired_status }} />, { auth: { id: 'u1' }, contacts: { setAgentDesiredStatus } })
  await render('online')
  await clickElement(pause())
  expect(setAgentDesiredStatus).toHaveBeenLastCalledWith('a1', 'offline')
  await render('offline')
  expect(pause().getAttribute('aria-checked')).toBe('true')
  await clickElement(pause())
  expect(setAgentDesiredStatus).toHaveBeenLastCalledWith('a1', 'online')
})

it('keeps a failed pause unchanged and allows retry in the same row', async () => {
  const setAgentDesiredStatus = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue(undefined)
  await renderWithAppProviders(h, <AgentSettingsModal agent={agent} />, { auth: { id: 'u1' }, contacts: { setAgentDesiredStatus } })
  await clickElement(pause())
  const row = document.querySelector('[data-testid="agent-profile-pause"]')!
  expect(row.querySelector('[role="alert"]')?.textContent).toContain('没能更改暂停状态')
  expect(pause().getAttribute('aria-checked')).toBe('false')
  expect(pause().disabled).toBe(false)
  await clickElement(pause())
  expect(setAgentDesiredStatus).toHaveBeenCalledTimes(2)
  expect(row.querySelector('[role="alert"]')).toBeNull()
})
