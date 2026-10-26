import { installedExtensionsStore } from '../../session/renderer/features/extensions/installed-extensions-store'
import { localizedManifestText } from '../../session/shared/extensions/catalog'
import type { FileOpenerCandidate } from '../../session/shared/extensions/file-openers'

/** An App as the panel names it to the person: in the interface language, as its manifest says it there. */
export const appNameOf = (candidate: Pick<FileOpenerCandidate, 'app'>) => localizedManifestText(candidate.app, installedExtensionsStore.locale).name

/** The Apps on this device that may open something: main's list on the desktop, the phone's App store on the phone. */
export const enabledApps = () => installedExtensionsStore.manifests.filter((manifest) => installedExtensionsStore.isEnabled(manifest.id))

/**
 * The App kept to open this kind of file (「Always」, 摩擦单 F73), as this window knows it — kept by main on the desktop, by
 * the phone's App store on the phone (`appsHere.setOpenWithDefault`); the store holds this window's copy of either.
 */
export function rememberedOpener(key: string): string | null {
  return installedExtensionsStore.openWithDefaults[key] ?? null
}
