// @vitest-environment jsdom
//
// @@@6386 「X 加入了群聊」这行灰字:服务端落的系统消息怎么认、名字怎么画、点了插什么。
// 服务端那一半(谁进群发、发成什么样、不唤醒 agent)的判官在 gugu-supabase 的
// tests/integration/service/groupMemberJoinNotice6386.test.ts。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberProfileCardModel } from '../../../apps/desktop/src/components/MemberProfileCard'
import { MemberJoinNotice } from '../../../apps/desktop/src/components/groups/MemberJoinNotice'
import { parseMemberJoinNotice } from '@gugu/core/shared/ui/memberJoinNotice'
import { clickElement, createNode, createReactHarness, message, renderWithAppProviders } from '../../support/testHarness'

function profile(id: string, displayName: string, overrides: Partial<MemberProfileCardModel> = {}): MemberProfileCardModel {
  return { id, displayName, avatar: null, email: null, type: 'human', role: 'member', membership: 'current', ...overrides }
}

describe('parseMemberJoinNotice:只认服务端写的那种', () => {
  const notice = message({ id: 'm-1', content_type: 'system', sender_user_id: null, client_message_id: 'member-joined:m-1:u-a,u-b' })

  it('系统消息 + 无发送者 + 中段是本条 id → 入群者 id', () => {
    expect(parseMemberJoinNotice(notice)).toEqual(['u-a', 'u-b'])
  })

  it('别的系统消息、有人发的、中段不是本条 id、没有 id —— 都不算', () => {
    expect(parseMemberJoinNotice({ ...notice, client_message_id: 'agent-flood:m-1' })).toBeNull()
    expect(parseMemberJoinNotice({ ...notice, sender_user_id: 'u-x' })).toBeNull()
    expect(parseMemberJoinNotice({ ...notice, content_type: 'text' })).toBeNull()
    expect(parseMemberJoinNotice({ ...notice, client_message_id: 'member-joined:m-2:u-a' })).toBeNull()
    expect(parseMemberJoinNotice({ ...notice, client_message_id: 'member-joined:m-1:' })).toBeNull()
    expect(parseMemberJoinNotice({ ...notice, client_message_id: null })).toBeNull()
  })
})

describe('MemberJoinNotice', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => { harness = createReactHarness() })
  afterEach(() => { harness.cleanup() })

  const profiles = {
    'u-a': profile('u-a', 'Alice'),
    'u-b': profile('u-b', 'Claude 5', { type: 'agent' }),
    'u-gone': profile('u-gone', 'Carol', { membership: 'former' }),
    'user-1': profile('user-1', '我自己'),
  }

  async function render(userIds: string[], onMention?: (target: { id: string; name: string }) => void) {
    await renderWithAppProviders(harness, createNode(MemberJoinNotice, {
      userIds, content: '服务端写的原文 加入了群聊', memberProfiles: profiles, onMention,
    }))
    return harness.container.querySelector<HTMLElement>('[data-testid="member-join-notice"]')!
  }

  it('按成员当前的名字画,顿号分隔;点名字 → 以这个人的 id 和名字插 @', async () => {
    const onMention = vi.fn()
    const row = await render(['u-a', 'u-b'], onMention)
    expect(row.textContent).toBe('Alice、Claude 5 加入了群聊')
    const buttons = [...row.querySelectorAll<HTMLButtonElement>('[data-testid="member-join-mention"]')]
    expect(buttons.map((button) => button.textContent)).toEqual(['Alice', 'Claude 5'])
    await clickElement(buttons[1]!)
    expect(onMention).toHaveBeenCalledWith({ id: 'u-b', name: 'Claude 5' })
  })

  it('已退群的人和自己不能点(正对照:同一行里在群的那个能点)', async () => {
    const row = await render(['u-gone', 'user-1', 'u-a'], vi.fn())
    expect(row.textContent).toBe('Carol、我自己、Alice 加入了群聊')
    const buttons = [...row.querySelectorAll('[data-testid="member-join-mention"]')]
    expect(buttons.map((button) => button.getAttribute('data-user-id'))).toEqual(['u-a'])
  })

  it('没有输入框的表面(不传 onMention)名字只读', async () => {
    const row = await render(['u-a'])
    expect(row.textContent).toBe('Alice 加入了群聊')
    expect(row.querySelector('[data-testid="member-join-mention"]')).toBeNull()
  })

  it('有一个人的资料解析不出 → 整行退回服务端原文,不拼「未知用户」', async () => {
    const row = await render(['u-a', 'u-unknown'], vi.fn())
    expect(row.textContent).toBe('服务端写的原文 加入了群聊')
    expect(row.querySelector('button')).toBeNull()
  })
})
