import { beforeEach, describe, expect, it, vi } from 'vitest'

const { chatRpcMock, identityRpcMock, schemaMock } = vi.hoisted(() => ({
  chatRpcMock: vi.fn(),
  identityRpcMock: vi.fn(),
  schemaMock: vi.fn(),
}))

vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  dataClient: { schema: schemaMock },
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      onAuthStateChange: vi.fn(),
    },
  },
  identityDb: { rpc: identityRpcMock },
  chatDb: { rpc: chatRpcMock },
}))

vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({
  subscribeAuthenticatedRealtimeChannel: vi.fn(),
}))

// contacts.ts reaches the archive write through archiveOwnedAgent (session host / phone host / modal);
// that path is not under test here, so its boundary is stubbed instead of booting the whole chain.
vi.mock('../../../../apps/desktop/src/lib/archiveOwnedAgent', () => ({
  archiveOwnedAgent: vi.fn(),
}))

vi.mock('@gugu/core/cloud/supabase', () => ({
  dbPayload: (value: unknown) => value,
}))

import { contactsService } from '../../../../apps/desktop/src/lib/contacts'
import zhContacts from '../../../../apps/desktop/src/i18n/locales/zh-CN/contacts'
import enContacts from '../../../../apps/desktop/src/i18n/locales/en-US/contacts'

/**
 * 「按群号加群」被拒的三种结局 —— 这条链只有在**两端约定同一组标识**时才成立:
 * RPC(迁移 20260906003846)抛稳定 ASCII 标识 → service 翻成可穷举的 reason → UI 选自己的文案。
 *
 * 钉住它的理由:被拒不是故障。若 service 把它当异常抛出去,UI 就只能 catch + 显示 error.message,
 * 那正是 user-copy-leak 守卫拦的写法(内部措辞、不可翻译、服务端改一个字用户就看到裸报错)。
 */
const REFUSALS = ['group_not_found', 'group_self_serve_closed', 'group_invite_only'] as const

function rpcError(message: string) {
  return { data: null, error: { message, code: 'P0001', details: null, hint: null } }
}

beforeEach(() => {
  chatRpcMock.mockReset()
  identityRpcMock.mockReset()
  schemaMock.mockReset()
})

describe('requestGroupJoinByPublicId', () => {
  it.each(REFUSALS)('把 RPC 的 %s 翻成 refused 结果,而不是抛异常', async (reason) => {
    chatRpcMock.mockResolvedValueOnce(rpcError(reason))

    await expect(contactsService.requestGroupJoinByPublicId(204389)).resolves.toEqual({
      status: 'refused',
      reason,
    })
  })

  it('认不出的错误照旧抛出,且原文进 cause —— ❌ 不把未知故障吞成一种「被拒」', async () => {
    chatRpcMock.mockResolvedValueOnce(rpcError('connection to server was lost'))

    await expect(contactsService.requestGroupJoinByPublicId(204389)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'connection to server was lost' }),
    })
  })

  it.each([0, -1, Number.NaN])('群号 %s 不成立时压根不发 RPC', async (publicId) => {
    await expect(contactsService.requestGroupJoinByPublicId(publicId)).rejects.toThrow()
    expect(chatRpcMock).not.toHaveBeenCalled()
  })

  // i18next 认不出键时返回**键名本身**,所以「文案存在」必须单独断言 ——
  // 少一条 key 不会红,只会让用户看到 `joinGroup.refusedInviteOnly` 这行字。
  it.each(REFUSALS)('%s 在两套语言里都有自己的文案', (reason) => {
    const key = {
      group_not_found: 'refusedNotFound',
      group_self_serve_closed: 'refusedSelfServeClosed',
      group_invite_only: 'refusedInviteOnly',
    }[reason]
    for (const [locale, catalog] of [['zh-CN', zhContacts], ['en-US', enContacts]] as const) {
      const copy = (catalog as { joinGroup: Record<string, string> }).joinGroup[key]
      expect(copy, `${locale} joinGroup.${key}`).toBeTruthy()
      // 三条拒绝各说各的事:文案相同等于用户分不出「群主没开自助加入」和「只收邀请」。
      expect(copy, `${locale} joinGroup.${key}`).not.toBe(
        (catalog as { joinGroup: Record<string, string> }).joinGroup.requestFailedFallback,
      )
    }
  })
})

/**
 * 邀请链接直接入群(join_public_group)不再能绕过「需审批 / 仅邀请」(gugu-supabase 迁移 20260923170000)。
 * 服务端按 join_mode 抛稳定标识;service 把它翻成产品结果:需审批 ⇒ 改提申请(界面快照可能过时),
 * 仅邀请 / 自助关闭 ⇒ 可穷举的拒绝类型。
 */
describe('joinPublicGroup 按服务端的 join_mode 判决分流', () => {
  const lookupRow = {
    chat_id: 'g1', public_id: 204389, kind: 'group', name: 'G', member_count: 3,
    is_member: false, is_muted: false, join_mode: 'approval', join_request_status: 'pending',
  }

  it('group_join_requires_approval ⇒ 改走 request_group_join,结果是 pending 而不是报错', async () => {
    chatRpcMock
      .mockResolvedValueOnce(rpcError('group_join_requires_approval'))
      .mockResolvedValueOnce({ data: 'pending', error: null })
      .mockResolvedValueOnce({ data: [lookupRow], error: null })
    await expect(contactsService.joinPublicGroup(204389, 'tok')).resolves.toMatchObject({ status: 'pending' })
    expect(chatRpcMock.mock.calls.map((call) => call[0])).toEqual(['join_public_group', 'request_group_join', 'lookup_public_group'])
    expect(chatRpcMock.mock.calls[1]![1]).toMatchObject({ p_public_id: 204389, p_join_token: 'tok' })
  })

  it.each([
    ['group_invite_only', 'invite_only'],
    ['group_self_serve_closed', 'invite_link_closed'],
  ] as const)('%s ⇒ GroupJoinRefusedError(%s),不发第二个 RPC', async (code, reason) => {
    const { GroupJoinRefusedError } = await import('../../../../apps/desktop/src/lib/contacts')
    chatRpcMock.mockResolvedValueOnce(rpcError(code))
    const error = await contactsService.joinPublicGroup(204389, 'tok').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GroupJoinRefusedError)
    expect(error).toMatchObject({ reason })
    expect(chatRpcMock).toHaveBeenCalledTimes(1)
  })

  it('认不出的错误照旧按用户可读错误抛出(正对照)', async () => {
    chatRpcMock.mockResolvedValueOnce(rpcError('Group member limit reached'))
    await expect(contactsService.joinPublicGroup(204389, 'tok')).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'Group member limit reached' }),
    })
  })
})
