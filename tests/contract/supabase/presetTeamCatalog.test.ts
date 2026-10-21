// 预置团队目录:客户端解析器吃的是库里迁移种下、又被后续迁移改写与排序过的那一份目录。
// 迁移在 gugu-supabase(#6322);客户端单测用的是它的快照 tests/fixtures/preset-team-catalog/rows.json。
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { parsePresetTeamCatalogRows } from '../../../apps/desktop/src/lib/presetTeamCatalog'
import { PRESET_TEAM_ROWS_SNAPSHOT, presetTeamCatalogRowsFromDatabase } from './presetTeamCatalogRows'

describe('preset team catalog contract', () => {
  let rows: Array<Record<string, unknown>>
  beforeAll(async () => { rows = await presetTeamCatalogRowsFromDatabase() })

  it('客户端单测用的快照与安装后的目录逐字一致', () => {
    expect(JSON.parse(readFileSync(PRESET_TEAM_ROWS_SNAPSHOT, 'utf8'))).toEqual(rows)
  })

  it('accepts every row and icon token in the migration seed', () => {
    const entries = parsePresetTeamCatalogRows(rows)
    expect(entries).toHaveLength(14)
    expect(entries.reduce((count, entry) => count + entry.roles.length, 0)).toBe(45)
    expect(entries.every((entry) => entry.icon != null)).toBe(true)
  })
})
