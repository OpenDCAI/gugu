import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { VALID_AGENT_TYPES } from '@gugu/core/agentTypes'

interface QueryResult<Row> {
  rows: Row[]
}

interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>
}

interface DatabaseError extends Error {
  code?: string
  constraint?: string
}

const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
const DATABASE_URL = (
  process.env.GUGU_INTEGRATION_DATABASE_URL
  ?? process.env.GUGU_DATABASE_URL
  ?? ''
).trim()
const RUN = `agent-type-check-${Date.now().toString(36)}`

let database: DatabaseClient

function requireLiveDevDatabase(): void {
  let parsed: URL
  try {
    parsed = new URL(DATABASE_URL)
  } catch {
    throw new Error('GUGU_INTEGRATION_DATABASE_URL is required')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`agentProfileAgentTypeConstraint.test requires PostgreSQL, got ${parsed.protocol}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`agentProfileAgentTypeConstraint.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
}

beforeAll(async () => {
  requireLiveDevDatabase()
  database = new Client({ connectionString: DATABASE_URL })
  await database.connect()
})

afterAll(async () => {
  await database?.end()
})

describe('identity.agent_profiles agent_type CHECK', () => {
  it('accepts every VALID_AGENT_TYPES value and rejects an unknown engine', async () => {
    const constraint = await database.query<{ definition: string }>(`
      SELECT pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'identity'
        AND t.relname = 'agent_profiles'
        AND c.conname = 'agent_profiles_agent_type_chk'
        AND c.contype = 'c'
    `)
    expect(constraint.rows).toHaveLength(1)

    await database.query('BEGIN')
    try {
      await database.query(`
        CREATE TEMP TABLE agent_profile_type_probe
          (LIKE identity.agent_profiles INCLUDING DEFAULTS INCLUDING CONSTRAINTS)
        ON COMMIT DROP
      `)

      for (const agentType of VALID_AGENT_TYPES) {
        await expect(database.query(`
          INSERT INTO agent_profile_type_probe (owner_id, display_name, avatar, agent_type)
          VALUES ($1, $2, $3, $4)
        `, [randomUUID(), `${RUN}-valid`, null, agentType]))
          .resolves.toBeDefined()
      }

      let rejection: DatabaseError | undefined
      try {
        await database.query(`
          INSERT INTO agent_profile_type_probe (owner_id, display_name, avatar, agent_type)
          VALUES ($1, $2, $3, $4)
        `, [randomUUID(), `${RUN}-invalid`, null, 'not-a-real-engine'])
      } catch (error) {
        rejection = error as DatabaseError
      }
      expect(rejection?.code).toBe('23514')
      expect(rejection?.constraint).toBe('agent_profiles_agent_type_chk')
    } finally {
      await database.query('ROLLBACK')
    }
  })
})
