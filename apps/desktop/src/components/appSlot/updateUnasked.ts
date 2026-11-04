import { rendererLogger } from '../../lib/log'
import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import type { AttachmentPackage } from '../../session/shared/extensions/attachment-install'
import { appsHere } from './appsHere'

const log = rendererLogger('app-slot/update-unasked')

let queue: Promise<unknown> = Promise.resolve()

/**
 * 摩擦单 F66 (主人 10-01): an App package found in a chat, offered to this device's install without anyone clicking.
 * Whether it goes in — only an update of an App here, from its publisher, asking nothing new — and whether it is even
 * downloaded is the install's own answer (`attachmentInstallPlan` with `unasked`). Here is only when: never while no
 * App here has a publisher, and one after another (a 0.3.0 right after a 0.2.0 is weighed against the 0.2.0).
 */
export function updateUnasked(pkg: AttachmentPackage): Promise<boolean> {
  const answer = queue.then(() => install(pkg)).catch((error: unknown) => {
    log.warn({ package: `msg:${pkg.messageId}`, error: error instanceof Error ? error.message : String(error) }, 'an App update found in a chat was not installed')
    return false
  })
  queue = answer
  return answer
}

async function install(pkg: AttachmentPackage): Promise<boolean> {
  if (!appsHere || Object.keys(installedExtensionsStore.publishers).length === 0) return false
  const result = await appsHere.installAttachment({ ...pkg, unasked: true })
  const data = result.data
  if (!result.success || !data || !data.installed) return false
  return true
}
