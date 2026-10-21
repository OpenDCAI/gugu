// @vitest-environment jsdom
// #5610 §2.3:退群 / 被移出的成员没有成员行,投影闭包不再为他索要身份 —— 消息窗口是他的唯一引用方,由它补齐。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { imSelectors, openImRepository, readMessageWindow } from '../../../../apps/desktop/src/lib/imRepository'
import type { DisplayIdentity } from '../../../../apps/desktop/src/lib/displayIdentity'
import { message as messageFixture } from '../../../support/testHarness'

const mocks = vi.hoisted(() => ({ readDisplayIdentities: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({ readDisplayIdentities: mocks.readDisplayIdentities }))

import { closeImRepository, ensureIdentities, publishMessageWindow, subscribeIdentities } from '../../../../apps/desktop/src/lib/chatMessageWindowPublication'
import { publishIdentityDirectory, readIdentityDirectoryBridge, installIdentityDirectoryBridge } from '../../../../apps/desktop/src/lib/identityDirectoryBridge'

function identity(id: string): DisplayIdentity {
  return {
    id, type: 'human', display_name: id, avatar: null, gugu_number: null, bio: null,
    owner_user_id: null, agent_public: null, desired_status: null, device_id: null,
    category: null, is_official: null, local_path: null,
    created_at: null, updated_at: '2026-09-14T00:00:00.000Z',
  }
}
const msg = (id: string, sender: string | null, seq: number, replyTo: string | null = null) =>
  messageFixture({ id, chat_id: 'chat-1', sender_user_id: sender, seq, content: id, reply_to_sender_user_id: replyTo })

describe('publishMessageWindow', () => {
  beforeEach(() => { mocks.readDisplayIdentities.mockReset() })

  it('writes the window and commits identities for senders (and replied-to senders) not yet in the repository', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb(), storage: window.localStorage })
    await repository.putIdentities([identity('known')])
    mocks.readDisplayIdentities.mockImplementation(async (ids: string[]) => ids.map(identity))

    await publishMessageWindow(repository, 'chat-1', [msg('m1', 'known', 1), msg('m2', 'former', 2, 'quoted'), msg('m3', null, 3)])

    expect(readMessageWindow(repository, 'chat-1')?.messages.map((row) => row.id)).toEqual(['m1', 'm2', 'm3'])
    // 只问缺的:已提交的 known 与注销的 null 都不再读。
    expect(mocks.readDisplayIdentities).toHaveBeenCalledTimes(1)
    expect([...mocks.readDisplayIdentities.mock.calls[0][0]].sort()).toEqual(['former', 'quoted'])
    expect(Object.keys(imSelectors.identitiesById(repository.snapshot())).sort()).toEqual(['former', 'known', 'quoted'])
  })

  it('asks once for a sender the identity table does not have, logs it, and asks again only after the retry window', async () => {
    const repository = await openImRepository('account-b', { adapter: createMemoryLocalSyncDb(), storage: window.localStorage })
    mocks.readDisplayIdentities.mockResolvedValue([])
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await publishMessageWindow(repository, 'chat-1', [msg('m1', 'vanished', 1)])
      await publishMessageWindow(repository, 'chat-1', [msg('m1', 'vanished', 1), msg('m2', 'vanished', 2)])
      expect(mocks.readDisplayIdentities).toHaveBeenCalledTimes(1)
      // 「没读到」可能只是刚建的行短暂读不到:过了重试窗口要再问,❌ 永久拉黑。
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1)
      mocks.readDisplayIdentities.mockResolvedValue([identity('vanished')])
      await publishMessageWindow(repository, 'chat-1', [msg('m1', 'vanished', 1)])
      expect(mocks.readDisplayIdentities).toHaveBeenCalledTimes(2)
      expect(Object.keys(imSelectors.identitiesById(repository.snapshot()))).toEqual(['vanished'])
      // rendererLogger 在非 Electron 环境退化成 console.error(`[scope] msg`, fields)。
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('[chat/message-window] [resolve-fail #1624]'),
        expect.objectContaining({ userId: 'vanished' }),
      )
    } finally {
      vi.useRealTimers()
      consoleError.mockRestore()
    }
  })
})

// #6306 会话页投递卡经身份目录读同一份缓存:同一个 id 不并发补取;本地库其他写入不惊动会话页。
describe('ensureIdentities / identity directory (#6306)', () => {
  beforeEach(() => { mocks.readDisplayIdentities.mockReset() })

  it('asks for an id once while its read is still in flight', async () => {
    const repository = await openImRepository('account-c', { adapter: createMemoryLocalSyncDb(), storage: window.localStorage })
    let release!: (rows: DisplayIdentity[]) => void
    mocks.readDisplayIdentities.mockImplementation(() => new Promise<DisplayIdentity[]>((resolve) => { release = resolve }))
    const first = ensureIdentities(repository, ['stranger'], { source: 'test' })
    const second = ensureIdentities(repository, ['stranger'], { source: 'test' })
    await second
    expect(mocks.readDisplayIdentities).toHaveBeenCalledTimes(1)
    release([identity('stranger')])
    await first
    expect(Object.keys(imSelectors.identitiesById(repository.snapshot()))).toEqual(['stranger'])
    // 读回来之后已提交,再问也不读。
    await ensureIdentities(repository, ['stranger'], { source: 'test' })
    expect(mocks.readDisplayIdentities).toHaveBeenCalledTimes(1)
  })

  it('a failed read releases the id so a later ask can read it again', async () => {
    const repository = await openImRepository('account-d', { adapter: createMemoryLocalSyncDb(), storage: window.localStorage })
    mocks.readDisplayIdentities.mockRejectedValueOnce(new Error('network down'))
    await expect(ensureIdentities(repository, ['stranger'], { source: 'test' })).rejects.toThrow('network down')
    mocks.readDisplayIdentities.mockResolvedValue([identity('stranger')])
    await ensureIdentities(repository, ['stranger'], { source: 'test' })
    expect(mocks.readDisplayIdentities).toHaveBeenCalledTimes(2)
  })

  it('notifies the task page only when identity rows change, not on every repository write', async () => {
    const repository = await openImRepository('account-e', { adapter: createMemoryLocalSyncDb(), storage: window.localStorage })
    await repository.putIdentities([identity('alice')])
    installIdentityDirectoryBridge()
    const bridge = readIdentityDirectoryBridge()!
    let notified = 0
    const off = bridge.subscribe(() => { notified += 1 })
    try {
      publishIdentityDirectory(imSelectors.identitiesById(repository.snapshot()), null)
      const base = notified
      // 一笔与身份无关的写(消息窗口)产出新的快照对象,身份行不变 ⇒ 不通知。
      await publishMessageWindow(repository, 'chat-1', [msg('m1', 'alice', 1)])
      publishIdentityDirectory(imSelectors.identitiesById(repository.snapshot()), null)
      expect(notified).toBe(base)
      // 身份行被改写 ⇒ 通知,且快照里是新值。
      await repository.putIdentities([{ ...identity('alice'), avatar: 'https://example.test/a.png' }])
      publishIdentityDirectory(imSelectors.identitiesById(repository.snapshot()), null)
      expect(notified).toBe(base + 1)
      expect(bridge.getSnapshot()?.alice?.avatar).toBe('https://example.test/a.png')
    } finally {
      off()
      publishIdentityDirectory(null, null)
    }
  })

  it('the chat store subscription feeds the session-page directory, and closing the repository clears it', async () => {
    const repository = await openImRepository('account-f', { adapter: createMemoryLocalSyncDb(), storage: window.localStorage })
    await repository.putIdentities([identity('alice')])
    const bridge = readIdentityDirectoryBridge()!
    let chatState: Record<string, DisplayIdentity> = {}
    subscribeIdentities(repository, (identities) => { chatState = identities })
    // 同一份:聊天页 state 与会话页目录是同一个对象。
    expect(bridge.getSnapshot()).toBe(chatState)
    expect(Object.keys(bridge.getSnapshot() ?? {})).toEqual(['alice'])
    closeImRepository(repository)
    expect(bridge.getSnapshot()).toBeNull()
  })
})

