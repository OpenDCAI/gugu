import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText } from '@gugu/core/local/state/paths'

/** Public metadata request bytes survive a lost native/cloud response. No
 * credentials enter this journal; re-reading a changed registry is not retry. */
export function createConnectionAuthorizationRequests(input: { guguHome: string; ownerId: string; deviceId: string; assertCurrent(): Promise<void> }) {
  const key = createHash('sha256').update(JSON.stringify([input.ownerId,input.deviceId])).digest('hex')
  return async function request<T>(operationId: string,identity: unknown,build: () => Promise<T>): Promise<T> {
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(operationId)) throw new Error('CONNECTION_OPERATION_INVALID')
    await input.assertCurrent()
    const path = join(input.guguHome,'connection-operations',key,`authorization-${operationId}.json`)
    const identityHash = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
    let stored: string | undefined
    try { stored = await readFile(path,'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (stored !== undefined) {
      const value = JSON.parse(stored)
      if (value.version !== 1 || value.ownerId !== input.ownerId || value.deviceId !== input.deviceId || value.operationId !== operationId
        || value.identityHash !== identityHash || typeof value.payload !== 'string'
        || value.payloadHash !== createHash('sha256').update(value.payload).digest('hex')) throw new Error('CONNECTION_OPERATION_REUSED')
      await input.assertCurrent()
      return JSON.parse(value.payload) as T
    }
    const payload = JSON.stringify(await build())
    await input.assertCurrent()
    await atomicWriteText(path,JSON.stringify({ version: 1,ownerId: input.ownerId,deviceId: input.deviceId,operationId,identityHash,
      payload,payloadHash: createHash('sha256').update(payload).digest('hex') })+'\n')
    await input.assertCurrent()
    return JSON.parse(payload) as T
  }
}
