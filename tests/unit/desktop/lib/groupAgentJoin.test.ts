import { describe, expect, it } from 'vitest'
import {
  groupJoinDenialKey,
  latestAgentJoinRequestStatus,
  parseGroupAgentJoinOutcome,
  summarizeAgentJoinResults,
} from '../../../../apps/desktop/src/lib/groupAgentJoin'
import zhMessaging from '../../../../apps/desktop/src/i18n/locales/zh-CN/messaging'
import enMessaging from '../../../../apps/desktop/src/i18n/locales/en-US/messaging'

function lookup(catalog: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], catalog)
}

describe('「Agent 加入需审批」的结果与拒绝原因', () => {
  it('库里的稳定标识 → 文案 key;认不出的交给通用失败文案(返回 null)', () => {
    expect(groupJoinDenialKey('ERROR: member_limit_reached')).toBe('group.join.denied.memberLimit')
    expect(groupJoinDenialKey('join_request_requester_left')).toBe('group.join.denied.requesterLeft')
    expect(groupJoinDenialKey('connection lost')).toBeNull()
    expect(groupJoinDenialKey(undefined)).toBeNull()
  })

  it('每个拒绝原因在两套语言里都有文案(i18next 认不出键时会原样显示键名)', () => {
    const codes = ['member_limit_reached', 'cloud_agent', 'agent_not_owned', 'actor_not_member', 'group_archived',
      'join_request_requester_left', 'join_request_agent_owner_left', 'Join request already decided']
    const keys = [...codes.map((code) => groupJoinDenialKey(code)!), 'group.join.denied.generic',
      'group.picker.agentRequestPending', 'group.picker.agentRequestRejected', 'group.picker.pendingApproval_one',
      'group.settings.agentJoinRequestedBy']
    for (const key of keys) {
      expect(key).toBeTruthy()
      for (const [locale, catalog] of [['zh-CN', zhMessaging], ['en-US', enMessaging]] as const) {
        expect(typeof lookup(catalog, key), `${locale} ${key}`).toBe('string')
      }
    }
  })

  it('add_group_agent 只认 joined / pending_approval,别的 fail loud', () => {
    expect(parseGroupAgentJoinOutcome({ status: 'joined' })).toBe('joined')
    expect(parseGroupAgentJoinOutcome({ status: 'pending_approval' })).toBe('pending_approval')
    expect(() => parseGroupAgentJoinOutcome({ status: 'weird' })).toThrow(/unexpected status/)
    expect(() => parseGroupAgentJoinOutcome(null)).toThrow()
  })

  it('发起人那头每个 agent 取最近一条请求的状态', () => {
    const latest = latestAgentJoinRequestStatus([
      { agent_user_id: 'a1', status: 'rejected' },
      { agent_user_id: 'a1', status: 'pending' },
      { agent_user_id: 'a2', status: 'pending' },
    ])
    expect([...latest]).toEqual([['a1', 'rejected'], ['a2', 'pending']])
  })

  it('批量添加的汇总把「已提交审批」与失败分开', () => {
    expect(summarizeAgentJoinResults([
      { status: 'fulfilled', value: 'joined' },
      { status: 'fulfilled', value: 'pending_approval' },
      { status: 'fulfilled', value: undefined },
      { status: 'rejected', reason: new Error('x') },
    ])).toEqual({ joined: 2, pendingApproval: 1, failed: 1 })
  })
})
