// 摩擦单 F99(L6,F82 验收):这一轮 agent 先读到 apps-page,那一页把 readFile / writeFile 当成任务文件的正路
// (「Write back IMMEDIATELY on every edit」),它就用了旧动词、整文件覆盖掉了拖卡落下前 14 ms 的外部写入。
// 主人 10-01 22:2x:旧文件动词连根拔掉,任务里的 App 一律用 gugu.files —— 指南里也一个不提。
import { describe, expect, it } from 'vitest'
import { GUIDE_TOPICS } from '../../../../apps/desktop/electron/mcp/gugu-guide-tool'

const all = GUIDE_TOPICS.map((topic) => topic.text).join('\n')
const page = GUIDE_TOPICS.find((topic) => topic.topic === 'apps-page')!.text

describe('F99: one way to edit a session\'s file, whichever guide an agent reads first', () => {
  it('the page guide sends a session\'s files to gugu.files, and no guide names an old file verb', () => {
    expect(page).toMatch(/remove — the one way to open and edit a session's file\./)
    expect(all).not.toMatch(/`(listFiles|readFile|writeFile|onFilesChanged)\(/)
    expect(all).not.toMatch(/Write back IMMEDIATELY/)
  })
})
