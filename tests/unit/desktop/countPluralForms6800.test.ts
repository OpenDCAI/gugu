import { describe, expect, it } from 'vitest'
import { i18n } from '@/i18n'
import '@/i18n/registerMainCatalog'
import { translateSessionMessage } from '@renderer/localization/locale-store'

// #6800:带 count 的英文文案要有 _one / _other 两种形式,否则单数也写成「1 sessions」。中文不分单复数。
describe('main 词表里按 count 取词的英文单复数 (#6800)', () => {
  const en = i18n.getFixedT('en-US', 'main')
  const zh = i18n.getFixedT('zh-CN', 'main')

  it('手机任务页机器行的会话数', () => {
    expect(en('agentWatch.machines.sessionCount', { count: 1 })).toBe('1 task')
    expect(en('agentWatch.machines.sessionCount', { count: 2 })).toBe('2 tasks')
    expect(en('agentWatch.machines.sessionCount', { count: 0 })).toBe('0 tasks')
    expect(zh('agentWatch.machines.sessionCount', { count: 1 })).toBe('1 个会话')
  })

  it('手机过程折叠里工具分组的调用次数', () => {
    expect(en('assistantUi.tool.groupCount', { count: 1 })).toBe('1 tool call')
    expect(en('assistantUi.tool.groupCount', { count: 3 })).toBe('3 tool calls')
    expect(zh('assistantUi.tool.groupCount', { count: 1 })).toBe('1 次工具调用')
  })
})

// 任务词表走同一个 i18next(translateSessionMessage),中英文 key 对齐,所以中文也拆成两条相同的内容。
describe('任务词表里按 count 取词的英文单复数 (#6800)', () => {
  async function both(key: string, count: number) {
    await i18n.changeLanguage('en-US')
    const en = translateSessionMessage(key, { count })
    await i18n.changeLanguage('zh-CN')
    return { en, zh: translateSessionMessage(key, { count }) }
  }

  it('侧栏项目行「有会话在等你」', async () => {
    expect(await both('sidebar.sessionsNeedYou', 1)).toEqual({ en: '1 task needs you', zh: '1 个会话需要你' })
    expect(await both('sidebar.sessionsNeedYou', 2)).toEqual({ en: '2 tasks need you', zh: '2 个会话需要你' })
  })
})
