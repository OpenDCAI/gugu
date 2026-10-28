import { afterAll, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n'
import { translateSessionMessage } from '@renderer/localization/locale-store'

// 任务词表里带数字的英文计数:走 i18next 的 _one / _other,❌「1 folders」「1 lines added」。
// 中文不分单复数,拆出来的两条与原文逐字相同 —— 这里同时钉住中文渲染不变。

type Values = Record<string, string | number>

async function render(lng: 'en-US' | 'zh-CN', draw: () => string): Promise<string> {
  await i18n.changeLanguage(lng)
  return draw()
}

afterAll(async () => {
  await i18n.changeLanguage('zh-CN')
})

/** 单个键:count 0 / 1 / 2 的英文,以及中文 1 / 2(与改前原文一致)。 */
const single: ReadonlyArray<{
  key: string
  extra?: Values
  en: readonly [string, string, string]
  zh: readonly [string, string]
}> = [
  { key: 'projects.folders.folderCount', en: ['0 folders', '1 folder', '2 folders'], zh: ['1 个文件夹', '2 个文件夹'] },
  { key: 'projects.folders.sessionCount', en: ['0 sessions', '1 session', '2 sessions'], zh: ['1 个会话', '2 个会话'] },
  {
    key: 'projects.folders.agentTotal',
    en: ['0 agents in total', '1 agent in total', '2 agents in total'],
    zh: ['共 1 个 Agent', '共 2 个 Agent'],
  },
  {
    key: 'projects.folders.agentMore',
    en: ['0 more agents', '1 more agent', '2 more agents'],
    zh: ['另有 1 个 Agent', '另有 2 个 Agent'],
  },
  { key: 'projects.folders.sessionsHere', en: ['0 sessions', '1 session', '2 sessions'], zh: ['1 个会话', '2 个会话'] },
  {
    key: 'projects.folders.hintClosed',
    en: [
      'Click the card to spread its 0 folders · pick one and the new task starts there',
      'Click the card to spread its 1 folder · pick it and the new task starts there',
      'Click the card to spread its 2 folders · pick one and the new task starts there',
    ],
    zh: [
      '点卡片摊开这个项目挂的 1 个文件夹 · 点其中一张，新任务就从那儿开工',
      '点卡片摊开这个项目挂的 2 个文件夹 · 点其中一张，新任务就从那儿开工',
    ],
  },
  {
    key: 'projects.folders.mergeDescription',
    extra: { name: 'gugu', machine: 'MBP', projectName: 'Home' },
    en: [
      'gugu on MBP already has 0 sessions. Their agents will join the Home project group; its old group stays as history.',
      'gugu on MBP already has 1 session. That session’s agent will join the Home project group; its old group stays as history.',
      'gugu on MBP already has 2 sessions. Their agents will join the Home project group; its old group stays as history.',
    ],
    zh: [
      'MBP 上的项目「gugu」已经有 1 个会话。并进来以后，这些会话的 agent 会进「Home」的项目群；它原来的群不删，留作历史。',
      'MBP 上的项目「gugu」已经有 2 个会话。并进来以后，这些会话的 agent 会进「Home」的项目群；它原来的群不删，留作历史。',
    ],
  },
  {
    key: 'browserSettings.importedToast',
    extra: { browser: 'Chrome', profile: 'Work' },
    en: [
      'Imported 0 logins from Chrome into "Work"',
      'Imported 1 login from Chrome into "Work"',
      'Imported 2 logins from Chrome into "Work"',
    ],
    zh: ['已从 Chrome 导入 1 条登录信息到「Work」', '已从 Chrome 导入 2 条登录信息到「Work」'],
  },
  {
    key: 'browserSettings.importedSkipped',
    en: [
      '0 could not be imported and were skipped.',
      '1 could not be imported and was skipped.',
      '2 could not be imported and were skipped.',
    ],
    zh: ['另有 1 条导不进来，已跳过。', '另有 2 条导不进来，已跳过。'],
  },
  { key: 'mcpLibrary.tools', en: ['0 tools', '1 tool', '2 tools'], zh: ['1 个工具', '2 个工具'] },
  { key: 'integrations.accountCount', en: ['0 accounts', '1 account', '2 accounts'], zh: ['1 个账号', '2 个账号'] },
  {
    key: 'subscriptions.connections.count',
    en: ['This device · 0 connections', 'This device · 1 connection', 'This device · 2 connections'],
    zh: ['当前设备 · 1 个连接', '当前设备 · 2 个连接'],
  },
  { key: 'subscriptions.window.hours', en: ['0 hours', '1 hour', '2 hours'], zh: ['1 小时', '2 小时'] },
  { key: 'subscriptions.window.days', en: ['0 days', '1 day', '2 days'], zh: ['1 天', '2 天'] },
  {
    key: 'extensions.permissionsWithdrawn',
    extra: { revoked: 1 },
    en: ['1 of 0 permissions withdrawn', '1 of 1 permission withdrawn', '1 of 2 permissions withdrawn'],
    zh: ['1 项里收回了 1 项', '2 项里收回了 1 项'],
  },
  {
    key: 'extensions.forkBehind',
    extra: { version: '1.2.0' },
    en: [
      'Upstream 1.2.0 · Your fork is 0 releases behind',
      'Upstream 1.2.0 · Your fork is 1 release behind',
      'Upstream 1.2.0 · Your fork is 2 releases behind',
    ],
    zh: ['上游 1.2.0 · 你的 fork 落后 1 版', '上游 1.2.0 · 你的 fork 落后 2 版'],
  },
  {
    key: 'extensions.rowRevoked',
    en: ['0 permissions taken back', '1 permission taken back', '2 permissions taken back'],
    zh: ['收回了 1 项权限', '收回了 2 项权限'],
  },
  {
    key: 'task.closeSessionWithTabsDescription',
    extra: { kinds: 'Browser' },
    en: [
      'This session still has 0 tabs open: Browser.',
      'This session still has 1 tab open: Browser.',
      'This session still has 2 tabs open: Browser.',
    ],
    zh: ['这个会话还开着 1 个页签：Browser。', '这个会话还开着 2 个页签：Browser。'],
  },
  { key: 'changes.linesAdded', en: ['0 lines added', '1 line added', '2 lines added'], zh: ['新增 1 行', '新增 2 行'] },
  {
    key: 'changes.linesRemoved',
    en: ['0 lines removed', '1 line removed', '2 lines removed'],
    zh: ['删除 1 行', '删除 2 行'],
  },
  {
    key: 'changes.selectedFiles',
    en: ['0 files selected', '1 file selected', '2 files selected'],
    zh: ['已选 1 个文件', '已选 2 个文件'],
  },
]

describe('任务词表按 count 取单复数', () => {
  it.each(single)('$key', async ({ key, extra, en, zh }) => {
    const at = (lng: 'en-US' | 'zh-CN', count: number) =>
      render(lng, () => translateSessionMessage(key, { ...extra, count }))
    expect([await at('en-US', 0), await at('en-US', 1), await at('en-US', 2)]).toEqual(en)
    expect([await at('zh-CN', 1), await at('zh-CN', 2)]).toEqual(zh)
  })
})

describe('一句里两个数:各自取单复数再拼', () => {
  // 与 project-folder-card.tsx 的拼法相同。
  const meta = (folders: number, sessions: number) =>
    translateSessionMessage('projects.folders.meta', {
      folders: translateSessionMessage('projects.folders.folderCount', { count: folders }),
      sessions: translateSessionMessage('projects.folders.sessionCount', { count: sessions }),
    })

  it('项目卡片头「N 个文件夹 · N 个会话」', async () => {
    expect(await render('en-US', () => meta(1, 0))).toBe('1 folder · 0 sessions')
    expect(await render('en-US', () => meta(2, 1))).toBe('2 folders · 1 session')
    expect(await render('en-US', () => meta(0, 2))).toBe('0 folders · 2 sessions')
    expect(await render('zh-CN', () => meta(1, 0))).toBe('1 个文件夹 · 0 个会话')
    expect(await render('zh-CN', () => meta(2, 1))).toBe('2 个文件夹 · 1 个会话')
  })

  // 与 changes-list-item.tsx / session-git-diff-stats.tsx 的拼法相同。
  const lineDelta = (additions: number, deletions: number) =>
    translateSessionMessage('changes.lineDelta', {
      additions: translateSessionMessage('changes.linesAdded', { count: additions }),
      deletions: translateSessionMessage('changes.linesRemoved', { count: deletions }),
    })

  it('变更行的读屏说法「新增 N 行，删除 N 行」', async () => {
    expect(await render('en-US', () => lineDelta(1, 0))).toBe('1 line added, 0 lines removed')
    expect(await render('en-US', () => lineDelta(2, 1))).toBe('2 lines added, 1 line removed')
    expect(await render('en-US', () => lineDelta(0, 2))).toBe('0 lines added, 2 lines removed')
    expect(await render('zh-CN', () => lineDelta(1, 0))).toBe('新增 1 行，删除 0 行')
    expect(await render('zh-CN', () => lineDelta(2, 1))).toBe('新增 2 行，删除 1 行')
  })
})

describe('从代码里挪进词表的固定说法', () => {
  it('变更面板未选文件时', async () => {
    expect(await render('en-US', () => translateSessionMessage('changes.allFiles'))).toBe('All files')
    expect(await render('zh-CN', () => translateSessionMessage('changes.allFiles'))).toBe('全部文件')
  })
})
