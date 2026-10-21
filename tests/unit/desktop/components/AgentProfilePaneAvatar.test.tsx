// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, contact, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { AgentProfilePane } from '../../../../apps/desktop/src/components/agentsettings/AgentProfilePane'
import type { ContactsContextValue } from '../../../../apps/desktop/src/store/contactsContext'

// 资料页在 agent 设置里一直挂着;弹窗给它的 agent 是通讯录里最新的那份。形象页一保存,头像就变了。
const HOST = 'https://db.example/storage/v1/object/public/avatars'
const OWNER = 'owner-1'
const opened = contact({ id: 'agent-1', type: 'agent', display_name: '写周报', owner_user_id: OWNER, avatar: `${HOST}/agent-look/v1/lagoon.webp?rest=shy` })
const lookJustSaved = { ...opened, avatar: `${HOST}/agent-look/v1/sakura.webp?rest=happy` }

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
})

async function show(agent: typeof opened, updateAgentProfile = vi.fn<ContactsContextValue['updateAgentProfile']>(async () => {})) {
  await renderWithAppProviders(harness, createNode(AgentProfilePane, { agent }), {
    auth: { id: OWNER },
    contacts: { updateAgentProfile },
  })
  return updateAgentProfile
}

describe('资料页保存不碰头像', () => {
  it('形象页刚换了形象,回资料页保存:只写名字和简介,❌ 把打开时那份头像写回去', async () => {
    const updateAgentProfile = await show(opened)
    await show(lookJustSaved, updateAgentProfile)
    await clickElement(harness.container.querySelector<HTMLElement>('.gg-as-profile-save')!)
    expect(updateAgentProfile).toHaveBeenCalledTimes(1)
    expect(updateAgentProfile.mock.calls[0][1]).toEqual({ name: '写周报', bio: '' })
  })

  it('头像位跟着库里最新的那份走', async () => {
    const updateAgentProfile = await show(opened)
    await show(lookJustSaved, updateAgentProfile)
    expect(harness.container.querySelector('[data-agent-avatar-color]')?.getAttribute('data-agent-avatar-color')).toBe('sakura')
  })
})
