import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText } from '@gugu/core/local/state/paths'
import type { ConnectionEffectLedger } from './connection-operation-application'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Host-owned receipts survive both restarts and assistant removal. Only UUIDs,
 * hashes and outcomes are stored here, never connection or credential bodies. */
export function createConnectionOperationLedger(input: { guguHome: string; ownerId: string; deviceId: string; assertCurrent(): Promise<void> }) {
  const key = createHash('sha256').update(JSON.stringify([input.ownerId, input.deviceId])).digest('hex')
  const path = join(input.guguHome, 'connection-operations', `${key}.json`)
  function parse(value: unknown): ConnectionEffectLedger {
    if (!object(value) || value.version !== 1 || value.ownerId !== input.ownerId || value.deviceId !== input.deviceId || !object(value.operations))
      throw new Error('CONNECTION_LEDGER_INVALID')
    for (const [operationId, receipt] of Object.entries(value.operations)) {
      if (!uuid.test(operationId) || !object(receipt) || !['started', 'applied', 'refused'].includes(String(receipt.state))
        || typeof receipt.admissionId !== 'string' || !uuid.test(receipt.admissionId)
        || typeof receipt.requestHash !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.requestHash)
        || receipt.authorityMode !== undefined && receipt.authorityMode !== 'owner'
        || receipt.authorityEpoch !== undefined && (typeof receipt.authorityEpoch !== 'string' || !/^\d+$/.test(receipt.authorityEpoch))
        || receipt.state === 'refused' && (typeof receipt.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(receipt.errorCode)))
        throw new Error('CONNECTION_LEDGER_INVALID')
    }
    return value.operations as ConnectionEffectLedger
  }
  return {
    path,
    async load(): Promise<ConnectionEffectLedger> {
      await input.assertCurrent()
      let text: string
      try { text = await readFile(path, 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
      await input.assertCurrent()
      return parse(JSON.parse(text))
    },
    async save(operations: ConnectionEffectLedger) {
      await input.assertCurrent()
      const value = { version: 1, ownerId: input.ownerId, deviceId: input.deviceId, operations }
      parse(value)
      await atomicWriteText(path, JSON.stringify(value) + '\n')
      await input.assertCurrent()
    },
  }
}
