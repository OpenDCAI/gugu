// @vitest-environment jsdom
//
// @@@6524 分享结果 → 用户看到的话。判据:发出邀请 ≠ 已进群(文案分开说);拒绝过的不重试、失败的才留着重试;
// 只有「一位好友且已在小群里」才直接打开群;失败原因只在用户能据此行动时(断网)说出来。
import { describe, expect, it } from 'vitest'
import { describeAgentShare, type AgentShareOutcome } from '../../../../apps/desktop/src/lib/agentShare'

const NAMES: Record<string, string> = { a: '张三', b: '李四', c: '王五' }
const nameOf = (id: string) => NAMES[id]
// 把 key 与插值原样摊开,断言读的是「说了哪句、对谁说」,不依赖词条文本。
const t = (key: string, options?: Record<string, unknown>) =>
  `${String(options?.ns)}:${key}(${String(options?.names)}${options?.reason ? `|${String(options.reason)}` : ''})`

function describeZh(outcomes: AgentShareOutcome[]) {
  return describeAgentShare(outcomes, nameOf, t, 'zh-CN')
}

describe('#6524 describeAgentShare', () => {
  it('一位好友、已发邀请 ⇒ 说「已发出邀请」,不打开群、没有问题、不留重试', () => {
    expect(describeZh([{ friendUserId: 'a', status: 'pending' }])).toEqual({
      done: ['contacts:inviteAgent.sent(张三)'],
      problem: null,
      retryIds: [],
      openGroup: null,
    })
  })

  it('一位好友、已在小群里 ⇒ 直接打开那个群', () => {
    const report = describeZh([{ friendUserId: 'a', status: 'already_member', chatId: 'chat-a', name: 'Claude 2、张三' }])
    expect(report.done).toEqual(['contacts:inviteAgent.alreadyInGroup(张三)'])
    expect(report.openGroup).toEqual({ id: 'chat-a', name: 'Claude 2、张三' })
  })

  it('多位好友 ⇒ 同类的人名按当前语言连起来;不止一位时不替用户打开任何群', () => {
    const report = describeZh([
      { friendUserId: 'a', status: 'pending' },
      { friendUserId: 'b', status: 'pending' },
      { friendUserId: 'c', status: 'already_member', chatId: 'chat-c', name: 'Claude 2、王五' },
    ])
    expect(report.done).toEqual(['contacts:inviteAgent.sent(张三和李四)', 'contacts:inviteAgent.alreadyInGroup(王五)'])
    expect(report.openGroup).toBeNull()
    expect(report.problem).toBeNull()
  })

  it('拒绝过的 ⇒ 说出来,但不留在重试里(RPC 对拒绝过的只回 rejected,重发也发不出去)', () => {
    const report = describeZh([
      { friendUserId: 'a', status: 'rejected' },
      { friendUserId: 'b', status: 'pending' },
    ])
    expect(report.problem).toBe('contacts:inviteAgent.rejected(张三)')
    expect(report.retryIds).toEqual([])
    expect(report.done).toEqual(['contacts:inviteAgent.sent(李四)'])
  })

  it('失败的 ⇒ 只说谁没成(原文不给用户),并留着等重试', () => {
    const report = describeZh([
      { friendUserId: 'a', status: 'failed', error: { message: 'Selected person is not an owner friend', code: 'P0001' } },
      { friendUserId: 'b', status: 'failed', error: new Error('non-archived group chat x must have exactly 1 human owner') },
    ])
    expect(report.problem).toBe('contacts:inviteAgent.failedFor(张三和李四)')
    expect(report.problem).not.toMatch(/owner friend|human owner/)
    expect(report.retryIds).toEqual(['a', 'b'])
    expect(report.done).toEqual([])
  })

  it('断网 ⇒ 另起一句带上「检查网络」这类用户能据此行动的提示', () => {
    const report = describeZh([{ friendUserId: 'a', status: 'failed', error: new TypeError('Failed to fetch') }])
    expect(report.problem).toMatch(/^contacts:inviteAgent\.failedFor\(张三\) \S.*$/)
  })

  it('拒绝过与失败同时出现 ⇒ 两句都说', () => {
    const report = describeZh([
      { friendUserId: 'a', status: 'rejected' },
      { friendUserId: 'b', status: 'failed', error: new Error('boom') },
    ])
    expect(report.problem).toBe('contacts:inviteAgent.rejected(张三) contacts:inviteAgent.failedFor(李四)')
    expect(report.retryIds).toEqual(['b'])
  })
})
