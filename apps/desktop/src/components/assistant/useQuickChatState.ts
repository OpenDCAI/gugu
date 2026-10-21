import { useCallback, useEffect, useState } from 'react'
import { QUICK_CHAT_CHANNELS, shortcutLabel, type QuickChatState } from '../../lib/quickChatIpc'
import { rendererLogger } from '../../lib/log'
import { readRendererPlatform } from '../../lib/window-chrome'
import { desktopIpc } from '../../platform/desktopIpc'

const log = rendererLogger('assistant/quick-chat')

/** 快捷键此刻的样子(主进程现读,变了它推一声);不是桌面 = null。齿轮页那一行读它。 */
export function useQuickChatState(): { state: QuickChatState | null; setEnabled: (on: boolean) => void } {
  const [state, setState] = useState<QuickChatState | null>(null)
  const reload = useCallback(() => {
    const ipc = desktopIpc()
    if (!ipc) return
    void ipc.invoke(QUICK_CHAT_CHANNELS.state).then((next) => setState(next as QuickChatState), (error: unknown) => log.warn({ error: String(error) }, '快速聊天的状态没读到'))
  }, [])
  useEffect(() => {
    reload()
    return desktopIpc()?.eventOn(QUICK_CHAT_CHANNELS.changed, reload)
  }, [reload])
  const setEnabled = useCallback((on: boolean) => {
    void desktopIpc()
      ?.invoke(QUICK_CHAT_CHANNELS.setEnabled, on)
      .then((next) => setState(next as QuickChatState), (error: unknown) => log.warn({ error: String(error) }, '快速聊天的开关没改成'))
  }, [])
  return { state, setEnabled }
}

export function quickChatShortcutLabel(state: QuickChatState): string {
  return shortcutLabel(state.accelerator, readRendererPlatform() === 'mac' ? 'darwin' : 'other')
}
