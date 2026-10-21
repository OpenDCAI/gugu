// @vitest-environment jsdom
// #7175 启动时外壳以降级态挂上(刷新令牌已死、断网),渲染层会话还没发布:补落开场任务要「没身份就跳过」,
// 不抛 `Not authenticated`、不发请求、指针原样留着;有身份时照旧落草稿;真失败照旧响亮。
// 身份走真的 sessionPublication(宿主调用时两个默认取法都不传,这里也不传);只替掉那一个网络请求,用来数它。
import type { Session } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getProvisionOperation: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/agentProvision', () => ({ getProvisionOperation: mocks.getProvisionOperation }))

import { publishRendererSession } from '../../../../apps/desktop/src/lib/sessionPublication'
import { landPendingStarters } from '../../../../apps/desktop/src/lib/starterContinuation'

const OWNER = 'owner-7175'
const KEY = `gugu:agent-provision:starter:${OWNER}`
const bound = { version: 1, ownerUserId: OWNER, operationId: 'op-bound', starter: '  开场任务原文  ', groupChatId: 'group-1' }
const unbound = { version: 1, ownerUserId: OWNER, operationId: 'op-unbound', starter: '还没建成群的那条' }
const session = (id: string) => ({ access_token: `access-${id}`, refresh_token: `refresh-${id}`, user: { id } }) as unknown as Session

describe('landPendingStarters without a published identity (#7175)', () => {
  beforeEach(() => {
    window.localStorage.clear()
    mocks.getProvisionOperation.mockReset()
    publishRendererSession('BOOT_RESTORING', null)
  })

  it('skips quietly while no session is published: no throw, no request, the pointers stay', async () => {
    window.localStorage.setItem(KEY, JSON.stringify([bound, unbound]))
    const setDraft = vi.fn()
    await expect(landPendingStarters(setDraft)).resolves.toBe(0)
    expect(setDraft).not.toHaveBeenCalled()
    expect(mocks.getProvisionOperation).not.toHaveBeenCalled()
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? 'null')).toEqual([bound, unbound])
  })

  it('lands the pointers once the session is published, as before', async () => {
    window.localStorage.setItem(KEY, JSON.stringify([bound, unbound]))
    mocks.getProvisionOperation.mockResolvedValue({ phase: 'completed', group_chat_id: 'group-2' })
    publishRendererSession('INITIAL_SESSION', session(OWNER))
    const setDraft = vi.fn()
    await expect(landPendingStarters(setDraft)).resolves.toBe(2)
    expect(setDraft.mock.calls).toEqual([['group-1', '  开场任务原文  '], ['group-2', '还没建成群的那条']])
    expect(mocks.getProvisionOperation).toHaveBeenCalledOnce()
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })

  it('still fails loud on a real failure: a pending starter whose operation is gone keeps its pointer', async () => {
    window.localStorage.setItem(KEY, JSON.stringify([unbound]))
    mocks.getProvisionOperation.mockResolvedValue(null)
    publishRendererSession('INITIAL_SESSION', session(OWNER))
    await expect(landPendingStarters(vi.fn())).rejects.toThrow(/op-unbound is missing\/not found/)
    expect(JSON.parse(window.localStorage.getItem(KEY) ?? 'null')).toEqual([unbound])
  })
})
