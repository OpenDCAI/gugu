import { describe, expect, it } from 'vitest'
import { hostCatalog, updateRestartCopy } from '../../../../apps/desktop/shared/host-localization'

describe('desktop restart confirmation copy', () => {
  it.each([
    ['en-US', 1, '1 running task will be interrupted.'],
    ['en-US', 5, '5 running tasks will be interrupted.'],
    ['zh-CN', 1, '1 个正在运行的任务会被中断。'],
    ['zh-CN', 5, '5 个正在运行的任务会被中断。'],
  ] as const)('%s count %i', (locale, count, expected) => {
    const copy = updateRestartCopy(hostCatalog(locale), count)
    expect(copy.detail).toBe(expected)
    expect(copy.restart).toBe(locale === 'en-US' ? 'Restart now' : '现在重启')
    expect(copy.later).toBe(locale === 'en-US' ? 'Later' : '稍后')
  })
})
