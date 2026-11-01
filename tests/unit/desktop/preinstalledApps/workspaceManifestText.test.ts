// 群文件夹 App 的两个读者(App 模型 v2):
// - 人:产品页、设置里的已装列表读 `subtitle`(各语言一句);
// - agent:<gugu_apps> 那一行就是 `contributes.instructions` 原文,工具签名在那里。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { guguAppsBlock } from '../../../../apps/desktop/electron/capability-bundle'
import { localizedManifestText, localizedTabText, matchesExtensionQuery } from '../../../../apps/desktop/src/session/shared/extensions/catalog'
import { declaredContexts, parseExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'

const manifest = parseExtensionManifest(
  JSON.parse(readFileSync(resolve(__dirname, '../../../../apps/desktop/preinstalled-apps/workspace/manifest.json'), 'utf8')),
)
const TOOLS_LINE = '- 文件夹 (workspace): Conversation folders: workspace__list(chat_id), create(chat_id,title,content), read/delete(item_id), edit(item_id,old,new). Edits merge live.'

describe('the folder App: people read its subtitle, agents read its instructions', () => {
  test('the product page and the installed list show people a line in both languages, never the tool signatures', () => {
    expect(localizedManifestText(manifest, 'zh-CN').subtitle).toBe('共享文件：Markdown、JSON 预览与编辑')
    expect(localizedManifestText(manifest, 'en-US').subtitle).toBe('Shared Markdown and JSON files')
    for (const locale of ['zh-CN', 'en-US']) expect(localizedManifestText(manifest, locale).subtitle).not.toContain('workspace__')
  })

  test('task menus and phone headers read localized titles for both folder tabs', () => {
    for (const tab of manifest.contributes.tabs) {
      for (const locale of ['en', 'en-US', 'en-GB']) expect(localizedTabText(manifest, tab, locale).title).toBe('Folder')
      for (const locale of ['zh', 'zh-CN']) expect(localizedTabText(manifest, tab, locale).title).toBe('文件夹')
    }
  })

  test('the installed list\'s search finds it by the words people read, in either language', () => {
    for (const query of ['markdown', 'JSON', '预览', '文件夹', 'workspace__list']) expect(matchesExtensionQuery(manifest, query), query).toBe(true)
    expect(matchesExtensionQuery(manifest, '演示稿')).toBe(false)
  })

  test('<gugu_apps> gives agents the instructions, word for word', () => {
    const block = guguAppsBlock([{ extensionId: manifest.id, name: manifest.name, instructions: manifest.contributes.instructions! }], [])
    expect(block.split('\n')).toContain(TOOLS_LINE)
  })

  test('its line is one English line of at most 160 characters, for agents only (App 模型 v2)', () => {
    const line = manifest.contributes.instructions!
    expect([line.includes('\n'), line.length <= 160, /[\u4e00-\u9fff]/.test(line)]).toEqual([false, true, false])
  })

  // P4: its own page is a task's folder too. A tab that claims files is one a task never keeps of its own
  // (app-placement-sync, F95/F3), so the page claims none; the files it opens open in its `file` tab.
  test('its own page claims no files, so a task keeps it; the .md and .json it opens go to its file tab', () => {
    const tabs = Object.fromEntries(manifest.contributes.tabs.map((tab) => [tab.name, declaredContexts(tab)]))
    expect(tabs).toEqual({ main: [], file: ['chat'] })
  })
})
