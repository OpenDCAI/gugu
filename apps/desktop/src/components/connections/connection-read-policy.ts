import { rendererLogger } from '@/lib/log'

export const connectionReadDelay = (failures: number) => Math.min(30_000,1000 * 2 ** Math.min(failures,5))
/** Read failures never select a different source or replace a successful cache. */
export function retryConnectionRead(failures: number,error: unknown) {
  rendererLogger('connections').warn({ failures,code: (error as { code?: string } | null)?.code },'Connection read will retry')
  return true
}
export const connectionReadOptions = { retry: retryConnectionRead,retryDelay: connectionReadDelay }
