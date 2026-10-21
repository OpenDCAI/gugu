// Compare the installed catalog, without depending on private migration history.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withContractDatabase } from './database'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const PRESET_TEAM_ROWS_SNAPSHOT = path.resolve(HERE, '../../fixtures/preset-team-catalog/rows.json')

export async function presetTeamCatalogRowsFromDatabase(): Promise<Array<Record<string, unknown>>> {
  return withContractDatabase(async (db) => (await db.query('SELECT * FROM public.preset_teams ORDER BY sort_order,id')).rows)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(PRESET_TEAM_ROWS_SNAPSHOT, JSON.stringify(await presetTeamCatalogRowsFromDatabase(), null, 2) + '\n')
  console.log(`wrote ${PRESET_TEAM_ROWS_SNAPSHOT}`)
}
