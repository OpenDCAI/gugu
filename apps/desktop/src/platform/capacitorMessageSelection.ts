import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { rendererLogger } from '../lib/log'

interface SelectionAction { key: string; label: string; disabled?: boolean; onSelect?: () => void }
interface SelectionPlugin {
  setContext(options: { contextId: string; actions: Omit<SelectionAction, 'onSelect'>[] }): Promise<void>
  clearContext(options: { contextId: string }): Promise<void>
  addListener(event: 'action', listener: (event: { contextId: string; key: string }) => void): Promise<PluginListenerHandle>
}
const plugin = registerPlugin<SelectionPlugin>('GuguMessageSelection')
const log = rendererLogger('mobile/message-selection')
let current: { id: string; actions: readonly SelectionAction[] } | null = null
let listening: Promise<PluginListenerHandle> | null = null

export function hasNativeMessageSelection(): boolean {
  return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('GuguMessageSelection')
}

export function publishNativeMessageSelection(id: string, actions: readonly SelectionAction[]): void {
  current = { id, actions }
  listening ??= plugin.addListener('action', (event) => {
    if (current?.id !== event.contextId) return
    const item = current.actions.find(action => action.key === event.key)
    if (item && !item.disabled) {
      item.onSelect?.()
      document.getSelection()?.removeAllRanges()
    }
  })
  void listening.then(() => {
    if (current?.id !== id) return
    return plugin.setContext({ contextId: id, actions: actions.map(({ key, label, disabled }) => ({ key, label, disabled })) })
  }).catch((error: unknown) => log.error({ error: String(error) }, 'message selection actions could not be installed'))
}

export function clearNativeMessageSelection(id: string): void {
  if (current?.id === id) current = null
  void plugin.clearContext({ contextId: id }).catch((error: unknown) => log.error({ error: String(error) }, 'message selection actions could not be cleared'))
}
