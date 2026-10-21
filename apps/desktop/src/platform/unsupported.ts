import type { AppPlatform } from './types'
import { unavailableCapability } from './errors'

export function createUnsupportedPlatform(
  kind: AppPlatform['kind'],
  label: string,
): AppPlatform {
  const unsupported = (capability: string): Error => unavailableCapability(capability, label)

  return {
    kind,
    documentTitle: '咕咕',
    systemPermissions: [],
    capabilities: {
      directoryPicker: false,
      appVersion: false,
      appUpdates: false,
      agentRuntime: false,
      badge: false,
      clipboard: false,
      notifications: false,
      rendererCommandBridge: false,
      localHumanAuthSession: false,
      barcodeScan: false,
      sessionHost: false,
      externalFileOpen: false,
      appRelaunch: false,
    logTail: false,
      backgroundWatch: false,
      shareToApps: false,
    },
    syncResolvedLocale: async () => {},
    subscribeAppForeground: () => () => {},
    selectDirectory: async () => { throw unsupported('Directory picker') },
    checkForUpdates: async () => { throw unsupported('Updates') },
    downloadUpdate: async () => { throw unsupported('Updates') },
    installUpdate: async () => { throw unsupported('Updates') },
    getAppVersion: async () => { throw unsupported('App version') },
    readLogTail: async () => { throw unsupported('Log tail') },
    openAgentRuntime: async () => { throw unsupported('Agent runtime') },
    openRemoteFile: async () => { throw unsupported('External file open') },
    saveFile: async () => { throw unsupported('Save file') },
    writeClipboardText: async () => { throw unsupported('Clipboard') },
    setBadge: () => { throw unsupported('Badge updates') },
    setTrayBadgeEnabled: () => { throw unsupported('Badge updates') },
    scanQrCode: async () => { throw unsupported('QR scan') },
    showNotification: async () => { throw unsupported('Notifications') },
    checkSystemPermission: async () => { throw unsupported('System permissions') },
    requestSystemPermission: async () => { throw unsupported('System permissions') },
    openSystemPermissionSettings: async () => { throw unsupported('System permissions') },
    setBackgroundWatch: async () => { throw unsupported('Background watch') },
    shareToApps: async () => { throw unsupported('Share to other apps') },
    writeHumanAuthSession: async () => { throw unsupported('Local human auth session') },
    clearHumanAuthSession: async () => { throw unsupported('Local human auth session') },
    relaunchApp: async () => { throw unsupported('App relaunch') },
    sendRendererCommandReady: () => { throw unsupported('Renderer command bridge') },
    sendRendererCommandResult: () => { throw unsupported('Renderer command bridge') },
  }
}
