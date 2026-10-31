// 群文件夹 App 的两个读者(App 模型 v2):
// - 人:产品页、设置里的已装列表读 `subtitle`(各语言一句);
// - agent:<gugu_apps> 那一行就是 `contributes.instructions` 原文,工具签名在那里。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { guguAppsBlock } from '../../../../apps/desktop/electron/capability-bundle'
import { localizedManifestText, matchesExtensionQuery } from '../../../../apps/desktop/src/session/shared/extensions/catalog'
import { parseExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'

const manifest = parseExtensionManifest(
  JSON.parse(readFileSync(resolve(__dirname, '../../../../apps/desktop/preinstalled-apps/workspace/manifest.json'), 'utf8')),
)
const TOOLS_LINE = '- 文件夹 (workspace): workspace__list(chat_id)、create(chat_id,title,content)、read/delete(item_id)、edit(item_id,old,new)。人和 agent 改的是同一份,各自的改动都在。'

describe('the folder App: people read its subtitle, agents read its instructions', () => {
  test('the product page and the installed list show people a line in both languages, never the tool signatures', () => {
    expect(localizedManifestText(manifest, 'zh-CN').subtitle).toBe('共享文件：Markdown、JSON 预览与编辑')
    expect(localizedManifestText(manifest, 'en-US').subtitle).toBe('Shared Markdown and JSON files')
    for (const locale of ['zh-CN', 'en-US']) expect(localizedManifestText(manifest, locale).subtitle).not.toContain('workspace__')
  })

  test('the installed list\'s search finds it by the words people read, in either language', () => {
    for (const query of ['markdown', 'JSON', '预览', '文件夹', 'workspace__list']) expect(matchesExtensionQuery(manifest, query), query).toBe(true)
    expect(matchesExtensionQuery(manifest, '演示稿')).toBe(false)
  })

  test('<gugu_apps> gives agents the instructions, word for word', () => {
    const block = guguAppsBlock([{ extensionId: manifest.id, name: manifest.name, instructions: manifest.contributes.instructions! }], [])
    expect(block.split('\n')).toContain(TOOLS_LINE)
  })
})
