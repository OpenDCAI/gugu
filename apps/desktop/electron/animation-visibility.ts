import type { BrowserWindow, WebContents } from 'electron'
import { ANIMATION_WINDOW_SEEN_EVENT } from '@gugu/session-shared/animation-visibility'
import { createLogger } from './lib/logger'

/** The same native window signal also reaches portal/layer documents without a preload. */
export function forwardWindowSeen(host: BrowserWindow, contents: WebContents = host.webContents): void {
  const sync = () => {
    if (host.isDestroyed() || contents.isDestroyed()) return
    const seen = host.isVisible() && !host.isMinimized()
    void contents.executeJavaScript(`window.dispatchEvent(new CustomEvent(${JSON.stringify(ANIMATION_WINDOW_SEEN_EVENT)}, { detail: ${seen} }))`)
      .catch((error: unknown) => {
        if (!contents.isDestroyed()) createLogger('ui/animation-visibility').error({ err: error }, 'Window animation visibility could not be delivered')
      })
  }
  host.on('minimize', sync)
  host.on('hide', sync)
  host.on('restore', sync)
  host.on('show', sync)
  contents.on('did-finish-load', sync)
  contents.once('destroyed', () => {
    host.removeListener('minimize', sync)
    host.removeListener('hide', sync)
    host.removeListener('restore', sync)
    host.removeListener('show', sync)
  })
  sync()
}
