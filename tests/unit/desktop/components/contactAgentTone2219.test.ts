import { describe, expect, it } from 'vitest'
import {
  agentContactAvatarBadgeClass,
  agentContactPresentation,
  agentContactRowDotClass,
  agentContactRowStatusClass,
  agentContactTone,
} from '../../../../apps/desktop/src/components/contactAgentTone'
import commonZhCN from '../../../../apps/desktop/src/i18n/locales/zh-CN/common'
import contactsZhCN from '../../../../apps/desktop/src/i18n/locales/zh-CN/contacts'

describe('agentContactTone removed projection (#2219)', () => {
  it('keeps removed distinct from offline', () => {
    expect(agentContactTone('offline')).toEqual({ tone: 'offline', labelKey: 'agentStatus.offline' })
    expect(agentContactTone('archived')).toEqual({ tone: 'archived', labelKey: 'agentStatus.archived' })
    expect(agentContactRowDotClass('archived')).toContain('bg-[var(--agent-tone-muted)]')
    expect(agentContactTone('pending')).toEqual({ tone: 'pending', labelKey: 'agentStatus.pending' })
    expect(agentContactTone('removed')).toEqual({ tone: 'removed', labelKey: 'agentStatus.removed' })
    expect(agentContactRowDotClass('removed')).toContain('bg-[var(--agent-tone-removed)]')
    expect(agentContactRowDotClass('offline')).toContain('bg-[var(--agent-tone-muted)]')
  })

  it('derives removed presentation and action eligibility from one model', () => {
    expect(agentContactPresentation('removed')).toEqual({
      tone: 'removed',
      labelKey: 'agentStatus.removed',
      allowsLiveActions: false,
    })
    expect(agentContactPresentation('offline').allowsLiveActions).toBe(true)
    expect(agentContactRowStatusClass('removed')).not.toContain(' off')
    expect(agentContactRowStatusClass('offline')).toContain(' off')
  })
})

// #6448 owner 2026-09-25 定表:通讯录与头像、聊天头说同一句话、同一个颜色 —— 在跑不再写成「在线」。
describe('contacts speak the one status table (#6448)', () => {
  it('reads its words from common:agentStatus, not a contacts copy', () => {
    expect((contactsZhCN as Record<string, unknown>).agentStatus).toBeUndefined()
    expect(agentContactTone('working').labelKey).toBe('agentStatus.running')
    expect(commonZhCN.agentStatus.running).toBe('运行中')
    expect(agentContactTone('parked').labelKey).toBe('agentStatus.parked')
    expect(agentContactTone('idle').labelKey).toBe('agentStatus.online')
    expect(agentContactTone('needs_user').labelKey).toBe('agentStatus.needsAction')
    expect(agentContactTone('error').labelKey).toBe('agentStatus.error')
  })

  it('paints running orange, needs-you yellow (a glyph) and error red through the shared tokens', () => {
    expect(agentContactRowDotClass('working')).toContain('bg-[var(--agent-tone-running)]')
    expect(agentContactRowDotClass('parked')).toContain('bg-[var(--agent-tone-running)]')
    expect(agentContactRowDotClass('idle')).toContain('bg-[var(--agent-tone-online)]')
    expect(agentContactRowDotClass('error')).toContain('bg-[var(--agent-tone-error)]')
    // needs_user 是 8px 的 Solar 字形(颜色在字形上),不是色点。
    expect(agentContactRowDotClass('needs_user')).toContain('h-[8px]')
    expect(agentContactRowDotClass('needs_user')).not.toContain('bg-[')
    expect(agentContactAvatarBadgeClass('needs_user')).toBe('')
    expect(agentContactRowStatusClass('needs_user')).not.toContain(' off')
  })
})
