import { describe, expect, it } from 'vitest'
import { sessionpageRenameAnnouncement } from '../../../../apps/desktop/electron/sessionpage/sessionpage-rename-announcement'

// #6396 一条会话的 agent 登记时名字已被占用 ⇒ 递给那条会话的是什么。
describe('#6396 改名告知', () => {
  it('登记时名字已用过:对话里一行,新旧两个名字都在', () => {
    const got = sessionpageRenameAnnouncement({ sessionId: 'conv-1', displayName: 'Claude 30', previousName: 'Claude 29' })
    expect(got.sessionId).toBe('conv-1')
    expect(got.notice).toMatchObject({ code: 'agent-renamed', previousValue: 'Claude 29', effectiveValue: 'Claude 30' })
  })

  // #6490 名字不在 agent 的上下文里(要知道就调 profile_whoami);这条一次性推送推不到终端会话、进程重启就丢,❌ 再拿它给 agent 递身份。
  it('只有给人看的那一行,❌ 夹带给 agent 的上下文', () => {
    const got = sessionpageRenameAnnouncement({ sessionId: 'conv-1', displayName: 'Claude 30', previousName: 'Claude 29' })
    expect(Object.keys(got).sort()).toEqual(['notice', 'sessionId'])
  })
})
