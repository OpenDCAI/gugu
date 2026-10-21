import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText, resolveGuguHome } from '@gugu/core/local/state/paths'

const DIRECTORY = 'runtime-fork-ownership'
const VERSION = 1

export type RuntimeForkOwnershipStatus = 'active' | 'closed'

export type RuntimeForkOwnership = {
  version: 1
  kind: 'runtime-only-fork'
  runtimeSessionId: string
  sourceSessionId: string
  /** Gugu-owned parent relation; kept alongside sourceConversationId for explicit fork reads. */
  forkedFromSessionId?: string
  provider: string
  providerSessionId: string
  workspaceId: string
  cwd: string
  status: RuntimeForkOwnershipStatus
  updatedAt: string
}

export type RuntimeForkOwnershipInput = Omit<
  RuntimeForkOwnership,
  'version' | 'kind' | 'status' | 'updatedAt'
>

function ownershipDirectory(env: NodeJS.ProcessEnv): string {
  return join(resolveGuguHome(env), DIRECTORY)
}

function safeFilePart(value: string): string {
  return encodeURIComponent(value)
}

function ownershipPath(runtimeSessionId: string, env: NodeJS.ProcessEnv): string {
  return join(ownershipDirectory(env), `${safeFilePart(runtimeSessionId)}.json`)
}

type OwnershipEntry = { record: RuntimeForkOwnership; path: string }

function isOwnership(value: unknown): value is RuntimeForkOwnership {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.version === VERSION &&
    record.kind === 'runtime-only-fork' &&
    typeof record.runtimeSessionId === 'string' &&
    typeof record.sourceSessionId === 'string' &&
    typeof record.provider === 'string' &&
    typeof record.providerSessionId === 'string' &&
    typeof record.workspaceId === 'string' &&
    typeof record.cwd === 'string' &&
    (record.status === 'active' || record.status === 'closed') &&
    typeof record.updatedAt === 'string'
  )
}

export async function recordRuntimeForkOwnership(
  input: RuntimeForkOwnershipInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  for (const [name, value] of Object.entries(input)) {
    if (name === 'forkedFromSessionId' && value === undefined) continue
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`Runtime fork ownership requires a non-empty ${name}`)
    }
  }
  const record: RuntimeForkOwnership = {
    ...input,
    forkedFromSessionId: input.forkedFromSessionId ?? input.sourceSessionId,
    version: VERSION,
    kind: 'runtime-only-fork',
    status: 'active',
    updatedAt: new Date().toISOString(),
  }
  await atomicWriteText(ownershipPath(input.runtimeSessionId, env), `${JSON.stringify(record)}\n`)
}

export async function closeRuntimeForkOwnership(
  providerSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const current = (await readRuntimeForkOwnershipEntries(env)).filter(
    ({ record }) => record.providerSessionId === providerSessionId && record.status === 'active',
  )
  await Promise.all(
    current.map(({ record, path }) =>
      atomicWriteText(
        path,
        `${JSON.stringify({ ...record, status: 'closed', updatedAt: new Date().toISOString() })}\n`,
      ),
    ),
  )
}

export async function closeRuntimeForkOwnershipForRuntimeSession(
  runtimeSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const current = (await readRuntimeForkOwnershipEntries(env)).find(
    ({ record }) => record.runtimeSessionId === runtimeSessionId && record.status === 'active',
  )
  if (!current) return
  await atomicWriteText(
    current.path,
    `${JSON.stringify({ ...current.record, status: 'closed', updatedAt: new Date().toISOString() })}\n`,
  )
}

async function readRuntimeForkOwnershipEntries(
  env: NodeJS.ProcessEnv = process.env,
): Promise<OwnershipEntry[]> {
  const directory = ownershipDirectory(env)
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const records: OwnershipEntry[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const filePath = join(directory, entry.name)
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(filePath, 'utf8'))
    } catch (error) {
      throw new Error(`Invalid runtime fork ownership marker ${filePath}: ${String(error)}`)
    }
    if (!isOwnership(parsed)) {
      throw new Error(`Invalid runtime fork ownership marker ${filePath}`)
    }
    records.push({ record: parsed, path: filePath })
  }
  return records
}

export async function readRuntimeForkOwnership(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeForkOwnership[]> {
  return (await readRuntimeForkOwnershipEntries(env)).map(({ record }) => record)
}
