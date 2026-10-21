// 预置团队目录的测试夹具:库里迁移算出来的「当前行」的快照(真相在 gugu-supabase 的迁移里)。
// 快照与迁移是否一致,由 tests/contract/supabase/presetTeamCatalog.test.ts 在两个仓的 CI 上判;
// ⚠️ 这里只读快照,❌ 别手改 rows.json —— 重新生成见 tests/contract/supabase/presetTeamCatalogRows.ts。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parsePresetTeamCatalogRows,
  type PresetTeamCatalogEntry,
} from '../../apps/desktop/src/lib/presetTeamCatalog'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const ROWS = path.resolve(HERE, '../fixtures/preset-team-catalog/rows.json')

export function loadPresetTeamCatalogFixture(): PresetTeamCatalogEntry[] {
  return parsePresetTeamCatalogRows(JSON.parse(readFileSync(ROWS, 'utf8')))
}
