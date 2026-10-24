import { revealSessionpage } from '../../hooks/useSessionpageReveal'
import { rendererLogger } from '../../lib/log'
import { UI_EVENTS } from '../../lib/uiEvents'
import { platform } from '../../platform'
import { rpc } from '../../session/renderer/lib/ipc'
import { appState } from '../../session/renderer/lib/stores/app-state'
import type { AppOpenWithDetail } from '../../session/shared/extensions/app-runtime-protocol'
import type { ExtensionInstallConsentOutcome } from '../../session/shared/extensions/host-actions'
import type { InstallConsentAsk } from '../../session/renderer/features/extensions/install-consent'
import type { ExtensionManifest } from '../../session/shared/extensions/manifest'
import { appChatFile, groupFileOpener, groupFilesOpenedBy, phoneRuns } from './phoneAppHost'
import { grantableBy, type AttachmentInstallRefused, type AttachmentPackage } from '../../session/shared/extensions/attachment-install'
import { PHONE_CAPABILITIES, phoneApps } from './phoneApps'
import { setExtensionEnabled } from '../../session/renderer/features/extensions/set-extension-enabled'
import type { HandedConsent } from '../../session/shared/extensions/install-consent-flow'

const log = rendererLogger('app-slot/apps-here')

/** An answer as main's RPC gives it (the phone's are the same shape): `data` when it succeeded, `error` when not. */
type Answer<T> = { success: boolean; data?: T; error?: string }

/** An install from a card, as either side answers it (`installAttachment`). */
export type AppInstallAnswer =
  /** E-05: what is here did not come from a chat — said to the person (`refusedLine`). */
  | AttachmentInstallRefused
  | { installed: boolean; outcome: string; id: string; name: string; version: string; updatedFrom?: string }
  /** Nobody clicked, and its publisher published nothing here (摩擦单 F66): not even downloaded. */
  | { installed: false; outcome: 'held' }

/** An install from the market, as either side answers it (main's installExtensionFromMarket, the phone's own). */
export type AppMarketAnswer =
  | { installed: true; outcome: 'confirmed'; id: string; name: string; version: string; updatedFrom?: string }
  /** `consent: return`: what it would ask, handed back (`asks` false: nothing to agree to — installed at once with `given`). */
  | { installed: false; outcome: 'ask'; id: string; name: string; version: string; ask: InstallConsentAsk; asks: boolean }
  | { installed: false; outcome: Exclude<ExtensionInstallConsentOutcome, 'confirmed'>; id: string; name: string; version: string }

/** Which market App to install, and who asks the person (installExtensionFromMarket's `consent`). */
export interface AppMarketInstall {
  ref: { extensionId: string; version?: string }
  chatId?: string
  consent?: HandedConsent
}

/**
 * This device's Apps (L9): who installs them from a chat, who says which App opens a group file, where 「始终用它」 is
 * kept — main on the desktop (`rpc.extensions`), the phone's own App store in this page (phoneApps.ts). The card and the
 * group's panel ask here, never which platform they are on; what is installed they read from `installedExtensionsStore`,
 * which both fill. None on the web, where Apps do not run.
 */
export interface AppsHere {
  /** Whether this device can use the App at all — by what it can do (app-redesign §5): the desktop every App, the phone `phoneRuns`. */
  runs(manifest: ExtensionManifest): boolean
  /**
   * The App as this device can grant it (`grantableBy`, 125 10-06): what its consent asks, and what its card says it asks
   * for — the desktop the whole of it, the phone only what a phone has.
   */
  grantable(manifest: ExtensionManifest): ExtensionManifest
  installAttachment(args: AttachmentPackage & { unasked?: boolean; chatId?: string }): Promise<Answer<AppInstallAnswer>>
  /** An App from the market, installed the one way (161 10-15): main on the desktop, the phone's own store on the phone. */
  installFromMarket(args: AppMarketInstall): Promise<Answer<AppMarketAnswer>>
  /** The market's Apps this device can install, each its version for here: what a group's 「用 X 打开」 offer looks among. */
  marketOffers(): Promise<Answer<{ manifest: ExtensionManifest; version: string }[]>>
  /** `at`: the place a pill points at — the App that opens the file gets it as a `link` event (desktop: main; phone: its host). */
  groupFileOpener(args: { chatId: string; itemId: string; at?: Record<string, string> }): Promise<Answer<AppOpenWithDetail>>
  groupFilesOpenedBy(args: { chatId: string; extensionId: string }): Promise<Answer<{ itemId: string; name: string; displayName: string }[]>>
  /** API 14: the file an App names for this chat (`chatFile`), found or made, as that file opened with the App. */
  appChatFile(args: { chatId: string; extensionId: string }): Promise<Answer<AppOpenWithDetail>>
  setOpenWithDefault(args: { key: string; tabKind: string | null }): Promise<unknown>
  /** An installed App switched on or off (161 10-16, every App has its switch): the Apps page's own switch on the desktop, the phone's store on the phone. */
  setEnabled(args: { manifest: ExtensionManifest; enabled: boolean }): Promise<Answer<unknown>>
  /** This device's App page, where its Apps are managed: the far-left rail's 「App」 on the desktop, settings' 「App」 on the phone. */
  openAppsPage(): void
}

const desktop: AppsHere = {
  runs: () => true,
  grantable: (manifest) => manifest,
  installAttachment: (args) => rpc.extensions.installAttachment(args),
  installFromMarket: (args) => rpc.extensions.installFromMarket(args),
  marketOffers: () => rpc.extensions.marketOffers(),
  groupFileOpener: (args) => rpc.extensions.groupFileOpener(args),
  groupFilesOpenedBy: (args) => rpc.extensions.groupFilesOpenedBy(args),
  appChatFile: (args) => rpc.extensions.appChatFile(args),
  setOpenWithDefault: (args) => rpc.extensions.setOpenWithDefault(args),
  setEnabled: async ({ manifest, enabled }) => {
    try {
      await setExtensionEnabled(manifest, enabled)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },
  openAppsPage: () => {
    revealSessionpage()
    appState.navigation.navigate('apps')
  },
}

const phone: AppsHere = {
  runs: phoneRuns,
  grantable: (manifest) => grantableBy(manifest, PHONE_CAPABILITIES),
  installAttachment: (args) => phoneApps.installAttachment(args),
  installFromMarket: (args) => phoneApps.installFromMarket(args),
  marketOffers: async () => {
    try {
      const entries = await phoneApps.market.entries()
      // Only what this phone can use at all (app-redesign §5), as its card's install would say.
      const offers = entries.filter((entry) => entry.compat === null && !entry.deprecated && phoneRuns(entry.manifest))
      return { success: true, data: offers.map((entry) => ({ manifest: entry.manifest, version: entry.version })) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  },
  groupFileOpener: async (args) => {
    await phoneApps.ready()
    return groupFileOpener(args)
  },
  groupFilesOpenedBy,
  appChatFile: async (args) => {
    await phoneApps.ready()
    return appChatFile(args)
  },
  setOpenWithDefault: async (args) => phoneApps.setOpenWithDefault(args),
  setEnabled: ({ manifest, enabled }) => phoneApps.setEnabled(manifest.id, enabled),
  openAppsPage: () => window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section: 'apps' } })),
}

export const appsHere: AppsHere | null = platform.kind === 'electron' ? desktop : platform.kind === 'capacitor' ? phone : null

// The phone reads what it has installed once the page is up, so the cards and the panel know it from the start.
if (appsHere === phone) {
  void phoneApps.ready().catch((error: unknown) => log.error({ error: error instanceof Error ? error.message : String(error) }, 'the phone App store could not be read'))
}
