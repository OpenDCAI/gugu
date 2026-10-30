import { useEffect, useState } from 'react'
import { UI_EVENTS } from './uiEvents'
import { fileMetadata } from './fileAccess'
import { rendererLogger } from './log'

const log = rendererLogger('file-host')

export type FileHost = { device: string; account: string }

/**
 * A project chat's file kept on the machine that sent this version (uploaded only when someone opens it): which machine
 * and whose account.
 * Null for every other file, and while unknown: it only says where the file is, so a failed read draws nothing.
 */
export function useFileHost(itemId: string | null): FileHost | null {
  const [host, setHost] = useState<FileHost | null>(null)
  useEffect(() => {
    setHost(null)
    if (!itemId) return undefined
    let live = true
    Promise.resolve().then(() => fileMetadata(itemId)).then((file) => {
      if (live && file.status === 'ready' && file.revision.source === 'local' && file.revision.host_device_id && file.revision.host_account_id) {
        setHost({ device: file.revision.host_device_id, account: file.revision.host_account_id })
      }
    }).catch((error: unknown) => log.warn({ itemId, error: String(error) }, 'where the file is kept is unknown'))
    return () => { live = false }
  }, [itemId])
  return host
}

/**
 * After a read failed: whether it is because the machine that keeps this version is offline right now, read afresh from
 * the resolver (never a state remembered from earlier). Its name when it is (`''` when it has none); null otherwise.
 */
export async function offlineHolder(itemId: string, version?: number): Promise<string | null> {
  const file = await fileMetadata(itemId, version).catch(() => null)
  if (file?.status !== 'ready' || file.revision.source !== 'local' || file.revision.host_online !== false) return null
  return file.revision.host_label?.trim() ?? ''
}

export const openFileStorageSettings = () => window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section: 'files' } }))
