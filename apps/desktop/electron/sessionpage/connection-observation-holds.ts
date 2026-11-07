import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText } from '@gugu/core/local/state/paths'

/** A failed or interrupted explicit authorization cannot be republished as an
 * ordinary observation after restart. Only that provider is held. */
export function createConnectionObservationHolds(input: { guguHome: string; ownerId: string; deviceId: string; assertCurrent(): Promise<void> }) {
  const key = createHash('sha256').update(JSON.stringify([input.ownerId,input.deviceId])).digest('hex')
  const path = join(input.guguHome,'connection-operations',`${key}.observations.json`)
  let holds: Record<string,string> | undefined
  async function load() {
    await input.assertCurrent()
    if (holds) return holds
    let text: string
    try { text = await readFile(path,'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return holds = {}; throw error }
    const value = JSON.parse(text)
    if (value.version !== 1 || value.ownerId !== input.ownerId || value.deviceId !== input.deviceId || !value.holds || typeof value.holds !== 'object'
      || Array.isArray(value.holds) || Object.entries(value.holds).some(([provider,id]) => !provider || typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)))
      throw new Error('CONNECTION_OBSERVATION_HOLD_INVALID')
    await input.assertCurrent()
    return holds = value.holds as Record<string,string>
  }
  async function save() {
    await input.assertCurrent()
    await atomicWriteText(path,JSON.stringify({ version: 1,ownerId: input.ownerId,deviceId: input.deviceId,holds })+'\n')
    await input.assertCurrent()
  }
  return { load,async begin(provider: string,operationId: string) { const value = await load(); value[provider] = operationId; await save() },
    async release(provider: string,operationId: string) { const value = await load(); if (value[provider] !== operationId) return; delete value[provider]; await save() },
  }
}
