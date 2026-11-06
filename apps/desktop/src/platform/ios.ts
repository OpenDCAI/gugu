import { App } from '@capacitor/app'
import { Clipboard } from '@capacitor/clipboard'
import type { AppPlatform } from './types'
import { createUnsupportedPlatform } from './unsupported'
import { rendererLogger } from '../lib/log'

const base = createUnsupportedPlatform('capacitor', 'iOS')
const lifecycleError = (error: unknown) => rendererLogger('ios/lifecycle').error({ error }, 'Cannot observe application lifecycle')

/** Foreground client only. Missing Android plugins never become advertised iOS capabilities. */
export const iosPlatform: AppPlatform = {
  ...base,
  capabilities: { ...base.capabilities, appVersion: true, clipboard: true },
  getAppVersion: async () => (await App.getInfo()).version,
  writeClipboardText: async (string) => { await Clipboard.write({ string }) },
  subscribeAppForeground(listener, onError) {
    let active = true
    let remove: (() => Promise<void>) | undefined
    void App.addListener('resume', () => { if (active) listener() }).then((handle) => {
      if (active) remove = () => handle.remove()
      else void handle.remove().catch(onError)
    }, onError)
    return () => {
      active = false
      if (remove) void remove().catch(onError)
    }
  },
  subscribeAppActive(listener) {
    let active = true
    let changed = false
    let remove: (() => Promise<void>) | undefined
    void App.addListener('appStateChange', (state) => {
      changed = true
      if (active) listener(state.isActive)
    }).then((handle) => {
      if (active) remove = () => handle.remove()
      else void handle.remove().catch(lifecycleError)
    }, lifecycleError)
    // Do not let a delayed initial read overwrite a newer lifecycle event.
    void App.getState().then((state) => { if (active && !changed) listener(state.isActive) }, lifecycleError)
    return () => {
      active = false
      if (remove) void remove().catch(lifecycleError)
    }
  },
}
