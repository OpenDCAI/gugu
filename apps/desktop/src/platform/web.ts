import type { AppPlatform } from './types'
import { createUnsupportedPlatform } from './unsupported'
import { anchorDownload } from './anchorDownload'

const base = createUnsupportedPlatform('web', 'web')

export const webPlatform: AppPlatform = {
  ...base,
  // @@@task-web-host — 网页版有会话页:后端是无头宿主(electron/session/headless),经 WebSocket 接入。
  capabilities: { ...base.capabilities, externalFileOpen: true, sessionHost: true },
  saveFile: anchorDownload,
  async openRemoteFile(file) {
    const opened = window.open(await file.url(), '_blank', 'noopener,noreferrer')
    if (!opened) throw new Error('The browser blocked the external file window')
  },
}
