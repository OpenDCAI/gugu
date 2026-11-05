// @vitest-environment node
import { execFileSync } from 'node:child_process'
import { expect, it } from 'vitest'

const root = process.cwd()
const matches = (pattern: string, ...paths: string[]) => {
  // The contract's rg expressions over tracked source, without requiring an extra rg installation in CI.
  try { return execFileSync('git', ['grep', '-n', '-E', pattern, '--', ...paths], { cwd: root, encoding: 'utf8' }).trim().split('\n') }
  catch (error) { if ((error as { status: number }).status === 1) return []; throw error }
}

it('e3 keeps message SQL and renderer writes at their sole boundaries', () => {
  const tables = matches('im_messages\\b|im_messages_text|im_message_(ranges|tombstones|chats|accounts)', 'apps', 'packages')
    .filter(line => !/\.test\.[^:]+:|\/tests\//.test(line))
    // Generated schema snapshots describe tables; they cannot execute writes.
    .filter(line => !/\/drizzle\/meta\/\d{4}_snapshot\.json:/.test(line))
  const allowed = [
    'apps/desktop/electron/session/drizzle/0046_persistent_im_messages.sql:',
    'apps/desktop/electron/session/main/db/schema.ts:',
    'apps/desktop/electron/session/main/core/im-messages/',
  ]
  // The migration journal registers the SQL tag; it contains no executable table access.
  const journal = tables.filter(line => line.startsWith('apps/desktop/electron/session/drizzle/meta/_journal.json:'))
  expect(journal).toHaveLength(1)
  expect(journal[0]).toContain('"tag": "0046_persistent_im_messages"')
  expect(tables.filter(line => !journal.includes(line)).every(line => allowed.some(path => line.startsWith(path)))).toBe(true)
  expect(matches('imMessages\\.(ingest|clearAccount)', 'apps/desktop/src').every(line => line.startsWith('apps/desktop/src/lib/messageIngest.ts:'))).toBe(true)
  expect(matches('collectMessageStoreBatch|omitMessages|replayMessagePage|putChatAccess', 'apps')).toEqual([])
})

it('e8 confines the temporary phone seam to its adapter sites', () => {
  const sites = matches('platform\\.localMessages', 'apps/desktop/src').map(line => line.split(':')[0])
  expect([...new Set(sites)].sort()).toEqual([
    'apps/desktop/src/lib/imRepository.ts',
    'apps/desktop/src/lib/messageIngest.ts',
    'apps/desktop/src/session/renderer/features/global-search/use-global-search.ts',
  ])
})
