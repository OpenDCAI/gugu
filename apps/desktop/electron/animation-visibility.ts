import { app, webContents, type WebContents } from 'electron'
import { ANIMATION_WINDOW_SEEN_EVENT } from '@gugu/session-shared/animation-visibility'
import { createLogger } from './lib/logger'

/** Install before creating windows; layers and portals use their actual native owner. */
export function forwardWindowSeen(): void {
  const send = (contents: WebContents) => {
    if (contents.isDestroyed()) return
    const host = contents.getOwnerBrowserWindow()
    if (!host || host.isDestroyed()) return
    const seen = host.isVisible() && !host.isMinimized()
    void contents.executeJavaScript(`window.dispatchEvent(new CustomEvent(${JSON.stringify(ANIMATION_WINDOW_SEEN_EVENT)}, { detail: ${seen} }))`)
      .catch((error: unknown) => {
        if (!contents.isDestroyed()) createLogger('ui/animation-visibility').error({ err: error }, 'Window animation visibility could not be delivered')
      })
  }
  app.on('web-contents-created', (_, contents) => contents.on('did-finish-load', () => send(contents)))
  app.on('browser-window-created', (_, host) => {
    const sync = () => {
      for (const contents of webContents.getAllWebContents())
        if (!contents.isDestroyed() && contents.getOwnerBrowserWindow() === host) send(contents)
    }
    for (const event of ['minimize', 'hide', 'restore', 'show'] as const) host.on(event, sync)
  })
}
