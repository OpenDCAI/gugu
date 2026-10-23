/** activity_chat_list against the migrated database: the real MCP handler (callTool) and the real function
 * (chat.activity_metadata_as). The RPC name, its parameter names, the result shape and the typed ids the agent
 * sees are checked on both sides here. restRpc runs as the owner (authenticated + JWT sub) on the same
 * connection, with PostgREST's scalar-function semantics: the jsonb value itself is the response body.
 * Every case runs inside BEGIN...ROLLBACK; the loopback guard keeps it off shared and production databases.
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error -- the injectable MCP server is an untyped ESM module.
import { callTool, RpcHttpError } from '../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
const connectionString = (process.env.GUGU_INTEGRATION_DATABASE_URL ?? '').trim()
let db: DatabaseClient
beforeAll(async () => {
  const target = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
    throw new Error('chatActivityMetadata requires loopback PostgreSQL')
  }
  db = new Client({ connectionString })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => { await db.query('BEGIN') })
afterEach(async () => {
  if (!db) return
  try {
    await db.query('RESET role')
    await db.query('SET CONSTRAINTS ALL IMMEDIATE')
  } finally {
    await db.query('ROLLBACK')
  }
})

const SINCE = '2026-10-20T00:00:00Z'
const UNTIL = '2026-10-21T00:00:00Z'

async function human(name: string): Promise<string> {
  const id = randomUUID()
  await db.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{}','{}',now(),now())`, [id, `${id}@chat-activity.example.invalid`])
  await db.query(`INSERT INTO identity.users (id,type,display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name`, [id, name])
  await db.query(`INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform)
    VALUES ($1,$2,'chat activity','chat activity','darwin')`, [`dev-${id}`, id])
  return id
}
async function agentOf(owner: string, name: string): Promise<string> {
  const id = randomUUID()
  await db.query(`INSERT INTO identity.users (id,type,display_name,owner_user_id,device_id)
    VALUES ($1,'agent',$2,$3,$4)`, [id, name, owner, `dev-${owner}`])
  return id
}
async function groupOf(members: string[]): Promise<string> {
  const id = randomUUID()
  await db.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','activity',$2)`, [id, members[0]])
  for (const [i, user] of members.entries()) {
    await db.query('INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,$3)', [id, user, i === 0 ? 'owner' : 'member'])
  }
  return id
}
async function say(chatId: string, sender: string, hour: number): Promise<string> {
  const id = randomUUID()
  await db.query(`INSERT INTO chat.messages (id, chat_id, sender_user_id, content, content_type, created_at)
    VALUES ($1,$2,$3,'SECRET BODY','text',$4)`, [id, chatId, sender, new Date(Date.parse(SINCE) + hour * 3_600_000).toISOString()])
  return id
}

/** One pg connection; calls are queued so SET LOCAL role and savepoints never interleave. */
let serial: Promise<unknown> = Promise.resolve()
function asOwnerQuery<Row>(owner: string, sql: string, values: unknown[]) {
  const run = serial.then(() => asOwnerQueryNow<Row>(owner, sql, values), () => asOwnerQueryNow<Row>(owner, sql, values))
  serial = run.catch(() => undefined)
  return run
}
async function asOwnerQueryNow<Row>(owner: string, sql: string, values: unknown[]) {
  await db.query('SAVEPOINT as_owner')
  try {
    await db.query('SET LOCAL role TO authenticated')
    await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
    const result = await db.query<Row>(sql, values)
    await db.query('RESET role')
    await db.query('RELEASE SAVEPOINT as_owner')
    return result
  } catch (error) {
    await db.query('ROLLBACK TO SAVEPOINT as_owner')
    await db.query('RESET role')
    throw error
  }
}

function tools(owner: string, self: string) {
  const context = {
    supabaseUrl: '',
    anonKey: '',
    agentId: self,
    threadRootId: null,
    guguHome: '/tmp/gugu-chat-activity-contract',
    getAccessToken: async () => `x.${Buffer.from(JSON.stringify({ sub: owner })).toString('base64url')}.x`,
  }
  const deps = {
    restRpc: async (name: string, body: Record<string, unknown>, profile = 'chat') => {
      if (!/^[a-z_]+$/.test(name) || !/^[a-z_]+$/.test(profile)) throw new Error(`bad rpc name ${profile}.${name}`)
      const keys = Object.keys(body)
      for (const key of keys) if (!/^p_[a-z_]+$/.test(key)) throw new Error(`bad rpc argument ${key}`)
      try {
        const result = await asOwnerQuery<{ value: unknown }>(owner,
          `SELECT ${profile}.${name}(${keys.map((key, index) => `${key} => $${index + 1}`).join(', ')}) AS value`,
          keys.map((key) => body[key]))
        return result.rows[0]?.value ?? null
      } catch (error) {
        throw new RpcHttpError(400, { detail: String((error as Error).message) })
      }
    },
    restGet: async (path: string) => { throw new Error(`activity_chat_list must not read tables directly: ${path}`) },
  }
  return async (args: Record<string, unknown>) => JSON.parse(String(await callTool(context, 'activity_chat_list', args, deps)))
}

describe('activity_chat_list against the migrated database', () => {
  it("returns the agent's visible messages as typed ids and times, pages with an actor-bound cursor, and refuses unseen chats", async () => {
    const owner = await human('Owner')
    const peer = await human('Peer')
    const self = await agentOf(owner, 'Assistant')
    const other = await agentOf(owner, 'Other agent')
    const group = await groupOf([owner, self, peer])
    const elsewhere = await groupOf([peer, owner])
    const first = await say(group, peer, 1)
    const second = await say(group, owner, 2)
    await say(elsewhere, peer, 3)

    const call = tools(owner, self)
    const page = await call({ since: SINCE, until: UNTIL, limit: 1 })
    expect(page.events).toEqual([{
      revision: expect.any(Number), kind: 'message_created', occurred_at: expect.any(String),
      chat_id: group, message_id: `msg:${first}`, sender_user_id: `user:${peer}`,
    }])
    expect(page.coverage).toMatchObject({ scope: 'actor_visible_chat_messages', actor_user_id: `user:${self}` })
    expect(page.next_cursor).toEqual(expect.any(String))
    expect(page.next_revision).toBeUndefined()
    expect(JSON.stringify(page)).not.toContain('SECRET')

    const next = await call({ since: SINCE, until: UNTIL, limit: 1, cursor: page.next_cursor })
    expect(next.events.map((event: { message_id: string }) => event.message_id)).toEqual([`msg:${second}`])
    expect(next.next_cursor).toBeNull()

    // The cursor belongs to this agent and query; another agent of the same owner cannot continue it.
    await expect(tools(owner, other)({ since: SINCE, until: UNTIL, limit: 1, cursor: page.next_cursor })).rejects.toThrow(/actor or query/)
    // The agent is not in `elsewhere`: refused, not an empty page. Control: its own group by id.
    await expect(call({ since: SINCE, until: UNTIL, chat_id: elsewhere })).rejects.toThrow(/Not allowed to read activity of chat/)
    expect((await call({ since: SINCE, until: UNTIL, chat_id: group })).events).toHaveLength(2)
  })
})
