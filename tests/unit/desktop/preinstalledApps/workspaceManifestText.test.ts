// 群文件夹 App 的 description 有两个读者(PR-2 评审,gugu-base b93ee3dab2 notes/reviews/2026-10-13-workspace-tools-to-app-pr2-rebuild-97ad5af.md):
// - 人:App 产品页、设置里的已装列表经 localizedManifestText 显示简介 —— 给人看的那句放在 localized 的 zh / en;
// - agent:<gugu_apps> 那一行只读原始 description 的第一句(embedded-boot 的 emdashExtensionAgentContributions 原样带它),
//   原始 description 留给 agent 的工具签名。
// 父提交上原始 description 就是工具签名、没有 localized:产品页给人看的是一串签名,第一格红。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { guguAppsBlock } from '../../../../apps/desktop/electron/capability-bundle'
import { localizedManifestText, matchesExtensionQuery } from '../../../../apps/desktop/src/session/shared/extensions/catalog'
import { parseExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'

const manifest = parseExtensionManifest(
  JSON.parse(readFileSync(resolve(__dirname, '../../../../apps/desktop/preinstalled-apps/workspace/manifest.json'), 'utf8')),
)
const TOOLS_LINE = '- 文件夹 (workspace): workspace__list(chat_id)、create(chat_id,title,content)、read/delete(item_id)、edit(item_id,old,new)。'

describe('the folder App\'s description: people read a sentence, agents read the tools', () => {
  test('the product page and the installed list show people the sentence, in both languages', () => {
    expect(localizedManifestText(manifest, 'zh-CN').description).toBe(
      '这个对话(群、话题、私聊)文件夹里的文件:列表、markdown 源码编辑与预览、JSON 的查看与修改。几个人和 agent 同时改同一个文件,各自的改动都在。',
    )
    expect(localizedManifestText(manifest, 'en-US').description).toMatch(/^The files in this chat's folder /)
    for (const locale of ['zh-CN', 'en-US']) expect(localizedManifestText(manifest, locale).description).not.toContain('workspace__')
  })

  // PR-2 评审 b8e3c7b1c2:人话挪进 localized 以后,已装列表按「markdown」「JSON」搜不到文件夹了 —— 搜索也要读 localized。
  test('the installed list\'s search finds it by the words people read, in either language', () => {
    for (const query of ['markdown', 'JSON', '预览', 'preview', '文件夹']) expect(matchesExtensionQuery(manifest, query), query).toBe(true)
    expect(matchesExtensionQuery(manifest, '演示稿')).toBe(false)
  })

  test('<gugu_apps> gives agents the tools line, word for word, from the description as the session gets it', () => {
    const block = guguAppsBlock([{ extensionId: manifest.id, name: manifest.name, description: manifest.description }], [])
    expect(block.split('\n')).toContain(TOOLS_LINE)
  })
})
