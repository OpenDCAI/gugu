import { createRequire } from 'node:module'

interface ContractDatabase {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => ContractDatabase
}

export async function withContractDatabase<T>(body: (db: ContractDatabase) => Promise<T>): Promise<T> {
  const connectionString = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
  const target = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(target.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) {
    throw new Error('Community contracts require a disposable loopback PostgreSQL database')
  }
  const db = new Client({ connectionString })
  await db.connect()
  try { return await body(db) }
  finally { await db.end() }
}
