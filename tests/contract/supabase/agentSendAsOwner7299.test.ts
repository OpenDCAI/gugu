import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MESSAGES_VIEW_SELECT } from '../../../packages/core/src/cloud/messageItem'
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string): Promise<{ rows: Row[]; fields: Array<{ name: string }> }>
}
const { Client } = createRequire(import.meta.url)('pg') as { Client: new (config: { connectionString: string }) => DatabaseClient }
let db: DatabaseClient
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Requires an isolated loopback database')
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })

describe('owner send client/database contract (#7299)', () => {
  it('the authenticated history projection includes the exact fields the client selects', async () => {
    await db.query('BEGIN')
    try {
      await db.query('SET LOCAL role TO authenticated')
      const result = await db.query(`SELECT ${MESSAGES_VIEW_SELECT} FROM chat.messages_view WHERE false`)
      expect(result.fields.map(field => field.name)).toEqual(MESSAGES_VIEW_SELECT.split(', '))
    } finally { await db.query('ROLLBACK') }
  })
  it('exposes the named RPC contract only to authenticated callers', async () => {
    const result = await db.query<{ names: string[]; allowed: boolean; anonymous: boolean }>(`SELECT p.proargnames AS names,
      has_function_privilege('authenticated',p.oid,'EXECUTE') AS allowed,
      has_function_privilege('anon',p.oid,'EXECUTE') AS anonymous
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='chat' AND p.proname='send_friend_message_as_owner'`)
    expect(result.rows).toEqual([{ names: ['p_agent_user_id','p_friend_user_id','p_content','p_request_id','p_content_type','p_storage_bucket_id','p_storage_object_name'], allowed: true, anonymous: false }])
  })
})
