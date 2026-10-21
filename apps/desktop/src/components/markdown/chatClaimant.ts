import { claimantOf, type FileOpenerCandidate } from '@shared/extensions/file-openers'
import { installedExtensionsStore } from '@/session/renderer/features/extensions/installed-extensions-store'

/** The App on this device that opens a chat's file of this name — a tap's answer (`claimantOf`) — or null. */
export function chatClaimantHere(name: string): FileOpenerCandidate | null {
  const store = installedExtensionsStore
  const apps = store.manifests.filter((manifest) => store.isEnabled(manifest.id))
  return claimantOf(name, apps, 'chat', (key) => store.openWithDefaults[key] ?? null)
}
