// @vitest-environment jsdom
// Network and OS boundaries are controlled; publication, revision dispatch and
// the account message repository use the production implementations.
import { act, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chat, createReactHarness, deferred, displayIdentity } from '../../../support/testHarness'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createAccountRevisionCoordinator, type AccountRevisionCoordinator } from '../../../../apps/desktop/src/lib/accountRevisionCoordinator'
import type { AccountRevisionSource, AccountRevisionOperation } from '../../../../apps/desktop/src/lib/accountRevisionRuntime'
import { createChatListProjectionLedger, useChatProjectionBinding } from '../../../../apps/desktop/src/store/chatListProjection'
import * as notifications from '../../../../apps/desktop/src/store/chatListProjection'

const native = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: { capabilities: { notifications: true }, showNotification: native.show },
}))
vi.mock('../../../../apps/desktop/src/lib/onScreenChat', () => ({ isChatOnScreen: () => false }))

type Response = { data: unknown; error: null }
const cloudRows = new Map<string, unknown[]>()
function builder(key: string): unknown {
  const chain: unknown = new Proxy(function noop() {} as unknown as object, {
    get(_target, property) {
      if (property === 'then') return (resolve: (value: Response) => unknown, reject?: (reason: unknown) => unknown) => {
        return Promise.resolve({ data: cloudRows.get(key) ?? [], error: null }).then(resolve, reject)
      }
      return () => chain
    },
    apply: () => chain,
  })
  return chain
}
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { from: (table: string) => builder(table), rpc: (fn: string) => builder(`rpc:${fn}`) },
  identityDb: { from: (table: string) => builder(table), rpc: (fn: string) => builder(`rpc:${fn}`) },
}))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({
  readDisplayIdentities: async (ids: readonly string[]) => ids.map(id => displayIdentity(id)),
}))

const ACCOUNT = 'notify-viewer'
const GROUP = 'notify-group'
const MESSAGE = 'notify-message-1'
const AT = '2026-01-01T00:00:00.000Z'
const noUnread = () => chat({ id: GROUP, kind: 'group', name: 'Fixture group', member_user_ids: [ACCOUNT] })
const locator = { chat_id: GROUP, stream_id: `main:${GROUP}`, stream_kind: 'main' as const, thread_root_id: null,
  message_id: MESSAGE, message_seq: 1, unread_count: 1, addressed_count: 1, cursor_seq: 0, version: 1, is_marked_unread: false }
const nextRow = (): ChatItem => ({ ...noUnread(), next_message_seq: 2, last_message_at: AT,
  last_message_preview: 'controlled addressed message', unread_count: 1, unread_locator: locator })
const messageRow = { id: MESSAGE, chat_id: GROUP, seq: 1, content: 'controlled addressed message', preview: 'controlled addressed message',
  content_type: 'text', sender_user_id: 'notify-sender', to_user_ids: [ACCOUNT], created_at: AT,
  thread_root_id: null, is_thread_root: false, is_whisper: false, client_message_id: null, deleted_at: null }

let repository: AccountImRepository
let harness: ReturnType<typeof createReactHarness>
let binding: ReturnType<typeof useChatProjectionBinding>
let releaseCommit: ReturnType<typeof deferred<void>>
let holdCommit = false
let coordinator: AccountRevisionCoordinator | null = null
let enabled = true
let wake: (head: string) => void
const pending: AccountRevisionOperation[] = []
const bodyPresentAtNotification: boolean[] = []

function Owner({ notificationsEnabled = true }: { notificationsEnabled?: boolean }) {
  enabled = notificationsEnabled
  const [rows, setRows] = useState<ChatItem[]>([noUnread()])
  const chatsRef = useRef(rows)
  useLayoutEffect(() => { chatsRef.current = rows }, [rows])
  const ledger = useRef(createChatListProjectionLedger())
  const repositoryRef = useRef<AccountImRepository | null>(repository)
  const activeChatIdRef = useRef<string | null>(null)
  const requestSeqRef = useRef(0)
  const getRepository = useCallback(async () => repository, [])
  const onActiveRevoked = useCallback(() => undefined, [])
  binding = useChatProjectionBinding({ ledger: ledger.current, repositoryRef, getRepository, chatsRef,
    activeChatIdRef, requestSeqRef, setChats: setRows, onActiveRevoked,
    notifications: { chatMessages: notificationsEnabled, sound: false } })
  return null
}

beforeEach(async () => {
  bodyPresentAtNotification.length = 0
  cloudRows.clear()
  pending.length = 0
  holdCommit = false; releaseCommit = deferred<void>(); coordinator = null
  const memory = createMemoryLocalSyncDb()
  repository = await openImRepository(ACCOUNT, { adapter: { ...memory, commit: async (operations, claims) => {
    if (holdCommit) await releaseCommit.promise
    return memory.commit(operations, claims)
  } } })
  await repository.transaction(tx => tx.putSyncState('account-revision-cursor', { revision: '0' }))
  native.show.mockReset().mockImplementation(async () => {
    bodyPresentAtNotification.push(repository.snapshot().message.some(row => row.id === MESSAGE))
    return { success: true, displayed: false }
  })
  cloudRows.set('active_members', [{ chat_id: GROUP, user_id: ACCOUNT, last_read_seq: 0, is_marked_unread: false,
    version: 1, notification_level: 'all', is_pinned: false, role: 'member', updated_at: AT, joined_at: AT, inbox_published_at: AT }])
  cloudRows.set('chats', [{ id: GROUP, public_id: null, kind: 'group', status: 'active', name: 'Fixture group', avatar_url: null,
    created_at: AT, last_message_at: null, last_message_preview: null, next_message_seq: 1, pinned_message_id: null }])
  cloudRows.set('messages_view', []); cloudRows.set('rpc:list_unread_locators', []); cloudRows.set('contact_overrides', [])
  harness = createReactHarness()
  await harness.render(<Owner />)
  await act(async () => { await binding.publish([noUnread()], [displayIdentity(ACCOUNT)], { requestSeq: 0, notify: false }) })
  const source: AccountRevisionSource = {
    syncSince: async cursor => ({ operations: pending.filter(operation => BigInt(operation.revision) > BigInt(cursor)), hasMore: false }),
    subscribeWake: (_account, onWake) => { wake = onWake; return () => undefined },
  }
  coordinator = createAccountRevisionCoordinator(ACCOUNT, repository, source, {
    recover: async () => { throw new Error('complete message fixture must not need recovery') },
    notify: async message => notifications.notifyForIngestedMessage(ACCOUNT,
      repository.snapshot().chat.find(row => row.id === GROUP)!.value, message,
      { onScreen: () => false, notificationsEnabled: enabled, soundEnabled: false }),
  })
  coordinator.start()
  await coordinator.whenIdle() // Initial catchup is a silent baseline, not a live arrival.
})

afterEach(() => {
  releaseCommit.resolve()
  coordinator?.stop()
  harness.cleanup()
  repository.close()
})

describe('chat notification ingestion', () => {
  const publish = async (row = nextRow(), requestSeq = 1) => {
    await act(async () => {
      const id = row.unread_locator?.message_id ?? MESSAGE
      pending.push({ revision: String(pending.length + 1), event: 'message_created', payload: {
        chat_id: GROUP, entity_id: id, message: { ...messageRow, id, seq: row.unread_locator?.message_seq ?? 1 },
      } })
      wake(String(pending.length))
      await coordinator!.whenIdle()
      await binding.publish([row], [displayIdentity(ACCOUNT)], { requestSeq, notify: true })
    })
  }

  it('notifies once for one eligible off-screen publication', async () => {
    await publish()
    expect(native.show).toHaveBeenCalledExactlyOnceWith({
      title: 'Fixture group', body: 'controlled addressed message', chatId: GROUP, silent: true,
    })
  })

  it('does not notify again when the same message is replayed after publication settles', async () => {
    await publish()
    await publish(nextRow(), 2)
    expect(native.show).toHaveBeenCalledTimes(1)
  })

  it('still notifies for a different addressed message', async () => {
    await publish()
    await publish({ ...nextRow(), next_message_seq: 3, unread_count: 2,
      unread_locator: { ...locator, message_id: 'notify-message-2', message_seq: 2,
        unread_count: 2, addressed_count: 2, version: 2 } }, 2)
    expect(native.show).toHaveBeenCalledTimes(2)
  })

  it('does not notify when chat message notifications are disabled', async () => {
    await harness.render(<Owner notificationsEnabled={false} />)
    await publish()
    expect(native.show).not.toHaveBeenCalled()
  })

  it('emits one notification for one message when publications overlap before commit', async () => {
    // Actual shared publish boundary used by hydration/refresh and revision attachment;
    // this does not claim three independent network deliveries were reproduced.
    holdCommit = true
    await act(async () => {
      const publications = [1, 2, 3].map(requestSeq => publish(nextRow(), requestSeq))
      releaseCommit.resolve()
      await Promise.all(publications)
    })
    expect(native.show).toHaveBeenCalledTimes(1)
  })

  it('stores the complete revision message before notifying for an unobserved chat', async () => {
    await act(async () => {
      const rows = await binding.hydrate(ACCOUNT)
      expect(rows.map(row => row.id)).toContain(GROUP)
      await binding.publish(rows, binding.identities(ACCOUNT), { requestSeq: 1, notify: false })
    })
    cloudRows.set('messages_view', [messageRow])
    cloudRows.set('rpc:list_unread_locators', [locator])
    const stop = binding.attach(ACCOUNT, coordinator!.subscribe)
    try {
      await act(async () => {
        pending.push({ revision: '1', event: 'message_created', payload: { chat_id: GROUP, entity_id: MESSAGE, message: messageRow } })
        wake('1'); await coordinator!.whenIdle()
      })
      expect(native.show).toHaveBeenCalledTimes(1)
      expect(bodyPresentAtNotification).toEqual([true])
    } finally { stop() }
  })
})
