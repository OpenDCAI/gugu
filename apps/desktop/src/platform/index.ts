import { Capacitor } from '@capacitor/core'
import { electronPlatform } from './electron'
import { capacitorPlatform } from './capacitor'
import { webPlatform } from './web'

export type { AppPlatform } from './types'
export { PlatformError } from './errors'

// `globalThis.window?.`: this module is imported by every UI primitive that asks for the shell (useMobileShell), and a node
// test imports UI before it puts a JSDOM window in place — there, as on the web, it is the web platform.
const hostPlatform = globalThis.window?.electronAPI
  ? electronPlatform
  : Capacitor.isNativePlatform()
    ? capacitorPlatform
    : webPlatform

// Phase two removes this seam when the phone also owns a local SQLite message database.
export const platform = Object.assign(hostPlatform, {
  localMessages: hostPlatform.kind === 'electron' ? 'sqlite' as const : 'window' as const,
})
