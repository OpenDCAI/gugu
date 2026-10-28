// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { i18n } from '@/i18n'
import '@/i18n/registerSettingsCatalog'
import '@/i18n/registerAssistantCatalog'
import { creditCount, formatCredits } from '@/lib/billing/spendingPowerCopy'

// 设置 / 助理词表里带数的英文文案走 _one / _other:1 的时候不能写成「1 credits」「1 entries」。
// 中文不分单复数,拆成两条相同的,渲染结果与拆之前逐字一致。
type Row = {
  ns: 'settings' | 'assistant'
  key: string
  /** 除 count 以外的插值;显示用的数(格式化过的积分、token)跟着 n 走。 */
  p?: (n: number) => Record<string, unknown>
  en: [string, string, string]
  zh: (n: number) => string
}

const credits = (n: number) => ({ credits: String(n) })

const ROWS: Row[] = [
  // settings
  {
    ns: 'settings', key: 'credits.reservedCopy', p: credits,
    en: [
      '0 credits are reserved for running tasks. They settle against actual usage, and unused credits are returned.',
      '1 credit is reserved for running tasks. It settles against actual usage, and unused credits are returned.',
      '2 credits are reserved for running tasks. They settle against actual usage, and unused credits are returned.',
    ],
    zh: (n) => `其中 ${n} 积分已为进行中的会话预留，按实际用量结算，未用完的部分会退回。`,
  },
  {
    ns: 'settings', key: 'credits.spending.available', p: (n) => ({ ...credits(n), window: 'W' }),
    en: ['you can spend up to 0 credits within W', 'you can spend up to 1 credit within W', 'you can spend up to 2 credits within W'],
    zh: (n) => `W内最多能花 ${n} 积分`,
  },
  {
    ns: 'settings', key: 'credits.spending.sentence', p: (n) => ({ ...credits(n), rate: 'R' }),
    en: ['You can spend 0 credits; R', 'You can spend 1 credit; R', 'You can spend 2 credits; R'],
    zh: (n) => `你还能花 ${n} 积分；R`,
  },
  {
    ns: 'settings', key: 'feedback.attachLog.attached',
    en: ['Attaching 0 lines of logs', 'Attaching 1 line of logs', 'Attaching 2 lines of logs'],
    zh: (n) => `本次将附带 ${n} 行日志`,
  },
  {
    ns: 'settings', key: 'lowBalance.title', p: credits,
    en: ['Low balance (0 credits left)', 'Low balance (1 credit left)', 'Low balance (2 credits left)'],
    zh: (n) => `积分不足（剩 ${n} 积分）`,
  },
  {
    ns: 'settings', key: 'membership.credits', p: credits,
    en: ['0 credits', '1 credit', '2 credits'],
    zh: (n) => `${n} 积分`,
  },
  {
    ns: 'settings', key: 'membership.expiresOn', p: (n) => ({ date: 'D', days: String(n) }),
    en: ['Valid through D (0 days left)', 'Valid through D (1 day left)', 'Valid through D (2 days left)'],
    zh: (n) => `有效期至 D（还剩 ${n} 天）`,
  },
  {
    ns: 'settings', key: 'membership.nonExpiringBalance', p: credits,
    en: ['0 non-expiring credits', '1 non-expiring credit', '2 non-expiring credits'],
    zh: (n) => `不过期积分 ${n}`,
  },
  {
    ns: 'settings', key: 'membership.payFor', p: () => ({ price: '30' }),
    en: ['Pay ¥30 (0 months)', 'Pay ¥30 (1 month)', 'Pay ¥30 (2 months)'],
    zh: (n) => `去支付 ¥30（${n} 个月）`,
  },
  {
    ns: 'settings', key: 'referral.amountCredits', p: credits,
    en: ['0 credits', '1 credit', '2 credits'],
    zh: (n) => `${n} 积分`,
  },
  {
    ns: 'settings', key: 'usage.quip', p: (n) => ({ tokens: '1.2M', book: 'B', times: String(n) }),
    en: [
      'You used 1.2M tokens in this period — roughly B, 0 times over.',
      'You used 1.2M tokens in this period — roughly B, 1 time over.',
      'You used 1.2M tokens in this period — roughly B, 2 times over.',
    ],
    zh: (n) => `这段时间你用掉了 1.2M token —— 大约是把B读了 ${n} 遍。`,
  },
  {
    ns: 'settings', key: 'usage.streaks', p: () => ({ current: 3, longest: 5 }),
    en: ['3-day streak · longest 5 · 0 active days', '3-day streak · longest 5 · 1 active day', '3-day streak · longest 5 · 2 active days'],
    zh: (n) => `连续 3 天 · 最长 5 天 · 活跃 ${n} 天`,
  },
  {
    ns: 'settings', key: 'usage.tiles.tokensUnknown', p: (n) => ({ value: String(n) }),
    en: [
      'Another 0 tokens have no known source (tasks from before sources were recorded)',
      'Another 1 token has no known source (tasks from before sources were recorded)',
      'Another 2 tokens have no known source (tasks from before sources were recorded)',
    ],
    zh: (n) => `另有 ${n} token 分不清来源（记录来源之前的会话）`,
  },
  {
    ns: 'settings', key: 'usage.units.tokens', p: (n) => ({ value: String(n) }),
    en: ['0 tokens', '1 token', '2 tokens'],
    zh: (n) => `${n} token`,
  },
  // assistant
  { ns: 'assistant', key: 'library.items', en: ['0 entries', '1 entry', '2 entries'], zh: (n) => `${n} 条记录` },
  { ns: 'assistant', key: 'library.projectFolderSessions', en: ['0 conversations', '1 conversation', '2 conversations'], zh: (n) => `${n} 个会话` },
  {
    ns: 'assistant', key: 'move.confirmSize', p: () => ({ size: '3 MB' }),
    en: ['0 files, 3 MB in all.', '1 file, 3 MB in all.', '2 files, 3 MB in all.'],
    zh: (n) => `共 ${n} 个文件，3 MB。`,
  },
  { ns: 'assistant', key: 'move.doneAccounts', en: ['0 accounts moved.', '1 account moved.', '2 accounts moved.'], zh: (n) => `${n} 个账号已搬过去。` },
  { ns: 'assistant', key: 'move.doneSchedules', en: ['0 schedules set again.', '1 schedule set again.', '2 schedules set again.'], zh: (n) => `${n} 个定时任务已重排。` },
  { ns: 'assistant', key: 'move.doneFiles', en: ['0 files copied.', '1 file copied.', '2 files copied.'], zh: (n) => `${n} 个文件已拷过去。` },
  { ns: 'assistant', key: 'chat.thoughtCount', en: ['0 thinking steps', '1 thinking step', '2 thinking steps'], zh: (n) => `思考 ${n} 次` },
  { ns: 'assistant', key: 'chat.toolCount', en: ['0 tool calls', '1 tool call', '2 tool calls'], zh: (n) => `调用 ${n} 次工具` },
  { ns: 'assistant', key: 'memory.items', en: ['0 items', '1 item', '2 items'], zh: (n) => `${n} 项` },
  { ns: 'assistant', key: 'health.tileSub', en: ['0 metrics', '1 metric', '2 metrics'], zh: (n) => `${n} 项数据` },
  { ns: 'assistant', key: 'files.uploaded', en: ['Uploaded 0 files', 'Uploaded 1 file', 'Uploaded 2 files'], zh: (n) => `上传成功：${n} 个文件` },
  { ns: 'assistant', key: 'connectors.deviceCount', en: ['0 devices', '1 device', '2 devices'], zh: (n) => `${n} 台设备` },
  {
    ns: 'assistant', key: 'closeDialog.deleteStarted',
    en: ['Also delete the sessions it started (0)', 'Also delete the session it started (1)', 'Also delete the sessions it started (2)'],
    zh: (n) => `一起删掉它开过的会话（${n} 个）`,
  },
]

describe('设置 / 助理词表里按 count 取词的英文单复数', () => {
  it.each(ROWS)('$ns:$key', ({ ns, key, p, en, zh }) => {
    const enT = i18n.getFixedT('en-US', ns)
    const zhT = i18n.getFixedT('zh-CN', ns)
    const at = (n: number) => ({ ...p?.(n), count: n })
    expect([0, 1, 2].map((n) => enT(key, at(n)))).toEqual(en)
    expect(zhT(key, at(1))).toBe(zh(1))
    expect(zhT(key, at(2))).toBe(zh(2))
  })
})

describe('积分按写出来的数取单复数', () => {
  it('0.999 写成「1」就用单数;<0.01 用复数', () => {
    const t = i18n.getFixedT('en-US', 'settings')
    expect(formatCredits(0.999, 'en-US')).toBe('1')
    expect(t('credits.spending.sentence', { credits: formatCredits(0.999, 'en-US'), count: creditCount(0.999), rate: 'R' })).toBe('You can spend 1 credit; R')
    expect(t('lowBalance.title', { credits: formatCredits(1.5, 'en-US'), count: creditCount(1.5) })).toBe('Low balance (1.5 credits left)')
    expect(t('lowBalance.title', { credits: formatCredits(0.004, 'en-US'), count: creditCount(0.004) })).toBe('Low balance (<0.01 credits left)')
  })
})
