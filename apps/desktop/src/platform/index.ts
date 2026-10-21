import { Capacitor } from '@capacitor/core'
import { electronPlatform } from './electron'
import { capacitorPlatform } from './capacitor'
import { webPlatform } from './web'

export type { AppPlatform } from './types'
export { PlatformError } from './errors'

// `globalThis.window?.`: this module is imported by every UI primitive that asks for the shell (useMobileShell), and a node
// test imports UI before it puts a JSDOM window in place — there, as on the web, it is the web platform.
export const platform = globalThis.window?.electronAPI
  ? electronPlatform
  : Capacitor.isNativePlatform()
    ? capacitorPlatform
    : webPlatform
