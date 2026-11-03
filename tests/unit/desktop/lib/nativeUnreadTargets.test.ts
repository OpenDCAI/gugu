import { expect, it } from 'vitest'
import { nativeUnreadTargets } from '../../../../apps/desktop/src/lib/nativeUnreadTargets'
import type { SessionDirectoryRow } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { chat } from '../../../support/testHarness'

function row(deviceId: string, conversationId: string, agentId?: string, itemIds: string[] = ['reply']): SessionDirectoryRow {
  return { deviceId, session: { conversationId, nativeUnreadKeys: itemIds, ...(agentId ? { agent: { userId: agentId } } : {}) } as SessionDirectoryRow['session'] }
}

it('includes native-only tasks globally and keeps their device identity', () => {
  const targets = nativeUnreadTargets([row('host-a', 'same'), row('host-b', 'same'), row('host-a', 'read', undefined, [])], [], true)
  expect(targets).toEqual([
    { deviceId: 'host-a', conversationId: 'same', itemIds: ['reply'] },
    { deviceId: 'host-b', conversationId: 'same', itemIds: ['reply'] },
  ])
})

it('limits a scoped personal read to that peer, including its existing tasks on different hosts', () => {
  const rows = [row('one', 'first', 'mine'), row('two', 'second', 'mine'), row('one', 'other', 'other'), row('one', 'unbound')]
  const chats = [chat({ id: 'dm', kind: 'ai', peer_user_id: 'mine' })]
  expect(nativeUnreadTargets(rows, chats, false)).toEqual([
    { deviceId: 'one', conversationId: 'first', itemIds: ['reply'], chatId: 'dm' },
    { deviceId: 'two', conversationId: 'second', itemIds: ['reply'], chatId: 'dm' },
  ])
  expect(nativeUnreadTargets(rows, [chat({ id: 'group', kind: 'group', peer_user_id: 'mine' })], false)).toEqual([])
})

it('copies the captured keys instead of retaining a mutable summary array', () => {
  const source = row('host', 'session')
  const captured = nativeUnreadTargets([source], [], true)
  source.session.nativeUnreadKeys!.push('later')
  expect(captured[0].itemIds).toEqual(['reply'])
})

it('uses the existing local IPC address only when the caller identifies that account device as this desktop', () => {
  const rows = [row('desktop', 'local'), row('remote', 'other')]
  expect(nativeUnreadTargets(rows, [], true, 'desktop').map(target => target.deviceId)).toEqual([null, 'remote'])
  expect(nativeUnreadTargets(rows, [], true).map(target => target.deviceId)).toEqual(['desktop', 'remote'])
})
