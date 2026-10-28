import { describe, expect, it } from 'vitest'
import { i18n } from '@/i18n'
import '@/i18n/registerMainCatalog'
import '@/i18n/registerMessagingCatalog'
import '@/i18n/registerContactsCatalog'

// 主界面词表(messaging / contacts / main)里带数字的英文文案走 _one / _other,❌「1 invitations」「1 people」。
// 中文不分单复数,拆键后渲染必须与原文逐字相同。
type Case = {
  ns: 'messaging' | 'contacts' | 'main'
  key: string
  vars?: Record<string, unknown>
  en: [string, string, string] // count 0 / 1 / 2
  zh: [string, string] // count 1 / 2,即原文
}

const POST_BODY_OTHER = (n: number) => `${n} community points are taken from your balance now. They go to the answers you accept; if nobody ever answers by the deadline, they come back to you; if there were answers but you accept none, they are gone.`
const POST_BODY_ZH = (n: number) => `发布后从你的社区积分中扣除 ${n} 积分。采纳后发给被采纳的回答者；截止时从未有人回答，全额退还；有过回答但未采纳，积分作废。`
const INVITATION_SENT_ZH = (n: number) => `已发送 ${n} 个邀请，等待本人或 Agent 主人接受后入群`
const INVITES_FAILED_ZH = (n: number) => `群已创建，但 ${n} 个邀请未发出。请在群成员面板重试邀请。`

const CASES: Case[] = [
  {
    ns: 'messaging', key: 'chatArea.appEnable.members',
    en: ['0 people', '1 person', '2 people'],
    zh: ['1 人', '2 人'],
  },
  {
    ns: 'messaging', key: 'group.picker.invitationSent',
    en: [
      'Sent 0 invitations; members join after they or their Agent owner accept',
      'Sent 1 invitation; the member joins after they or their Agent owner accepts',
      'Sent 2 invitations; members join after they or their Agent owner accept',
    ],
    zh: [INVITATION_SENT_ZH(1), INVITATION_SENT_ZH(2)],
  },
  {
    ns: 'messaging', key: 'history.topicPeople',
    en: ['0 people', '1 person', '2 people'],
    zh: ['1 人', '2 人'],
  },
  {
    ns: 'messaging', key: 'history.topicMessages',
    en: ['0 messages', '1 message', '2 messages'],
    zh: ['1 条', '2 条'],
  },
  {
    ns: 'messaging', key: 'forum.consent.reward',
    en: ['Bounty: 0 points', 'Bounty: 1 point', 'Bounty: 2 points'],
    zh: ['赏金 1 积分', '赏金 2 积分'],
  },
  {
    ns: 'messaging', key: 'forum.consent.awardLine', vars: { name: 'Ada' },
    en: ['Ada · 0 points', 'Ada · 1 point', 'Ada · 2 points'],
    zh: ['Ada · 1 积分', 'Ada · 2 积分'],
  },
  {
    ns: 'messaging', key: 'forum.consent.postBody',
    en: [
      POST_BODY_OTHER(0),
      '1 community point is taken from your balance now. It goes to the answer you accept; if nobody ever answers by the deadline, it comes back to you; if there were answers but you accept none, it is gone.',
      POST_BODY_OTHER(2),
    ],
    zh: [POST_BODY_ZH(1), POST_BODY_ZH(2)],
  },
  {
    ns: 'contacts', key: 'createGroup.invitesSent',
    en: [
      'Group created; 0 invitations are awaiting acceptance.',
      'Group created; 1 invitation is awaiting acceptance.',
      'Group created; 2 invitations are awaiting acceptance.',
    ],
    zh: ['群已创建，1 个邀请等待对方接受。', '群已创建，2 个邀请等待对方接受。'],
  },
  {
    ns: 'contacts', key: 'createGroup.invitesFailed',
    en: [
      'Group created, but 0 invitations failed. Retry them from the group members panel.',
      'Group created, but 1 invitation failed. Retry it from the group members panel.',
      'Group created, but 2 invitations failed. Retry them from the group members panel.',
    ],
    zh: [INVITES_FAILED_ZH(1), INVITES_FAILED_ZH(2)],
  },
  {
    ns: 'main', key: 'agentWatch.timeline.outputTrimmed',
    en: [
      '… 0 chars omitted from this preview',
      '… 1 char omitted from this preview',
      '… 2 chars omitted from this preview',
    ],
    zh: ['… 此预览省略了 1 字', '… 此预览省略了 2 字'],
  },
]

describe('主界面词表带数字的英文单复数', () => {
  it.each(CASES)('$ns:$key', ({ ns, key, vars, en, zh }) => {
    const tEn = i18n.getFixedT('en-US', ns)
    const tZh = i18n.getFixedT('zh-CN', ns)
    expect([0, 1, 2].map((count) => tEn(key, { ...vars, count }))).toEqual(en)
    expect([1, 2].map((count) => tZh(key, { ...vars, count }))).toEqual(zh)
  })

  // 话题历史一行原是「{{participantCount}} people · {{messageCount}} messages · {{date}}」两个数一条文案;
  // 拆成两对复数键,再由 topicMeta 拼起来。
  it('history.topicMeta 由两段已译好的计数拼成,中文与原文逐字相同', () => {
    const meta = (lang: string, people: number, messages: number) => {
      const t = i18n.getFixedT(lang, 'messaging')
      return t('history.topicMeta', {
        people: t('history.topicPeople', { count: people }),
        messages: t('history.topicMessages', { count: messages }),
        date: '10/28',
      })
    }
    expect(meta('en-US', 1, 1)).toBe('1 person · 1 message · 10/28')
    expect(meta('en-US', 2, 5)).toBe('2 people · 5 messages · 10/28')
    expect(meta('en-US', 0, 0)).toBe('0 people · 0 messages · 10/28')
    expect(meta('zh-CN', 1, 1)).toBe('1 人 · 1 条 · 10/28')
    expect(meta('zh-CN', 3, 12)).toBe('3 人 · 12 条 · 10/28')
  })
})
