// 预装 App 的 manifest 要按产品的读法读得出来:产品启动时用 parseExtensionManifest 校验每个预装 App,不合格的那个只记一条错、
// 整个 App 装不上(preinstalled-apps.ts),别的测试照样全绿。10-13 表格车道实撞:咕咕办公的 description 超过 280 字,
// 产品面 A/B 里 .xlsx 和 .pptx 都「No App opens this file」,单测一条没红。
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { safeParseExtensionManifest } from '../../../../apps/desktop/src/session/shared/extensions/manifest'

const root = resolve(__dirname, '../../../../apps/desktop/preinstalled-apps')
const apps = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
  .map((entry) => ({ dir: entry.name, raw: JSON.parse(readFileSync(join(root, entry.name, 'manifest.json'), 'utf8')) as Record<string, unknown> }))

describe('every preinstalled App\'s manifest reads the way the product installs it', () => {
  it('the check does refuse a manifest the product would not install (control: a description over 280 characters)', () => {
    const workspace = apps.find((app) => app.dir === 'workspace')!
    expect(safeParseExtensionManifest(workspace.raw)).toMatchObject({ ok: true })
    expect(safeParseExtensionManifest({ ...workspace.raw, description: 'x'.repeat(281) })).toMatchObject({ ok: false })
  })

  it.each(apps)('$dir', ({ raw }) => {
    const parsed = safeParseExtensionManifest(raw)
    expect(parsed.ok ? [] : parsed.issues).toEqual([])
  })
})
