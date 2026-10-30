import type { AppPlatform } from './types'
import { createUnsupportedPlatform } from './unsupported'
import { anchorDownload } from './anchorDownload'
import { fileBlob } from '@gugu/core/shared/fileResolver'
import { writeBrowserClipboardText } from './browserClipboard'

const base = createUnsupportedPlatform('web', 'web')

export const webPlatform: AppPlatform = {
  ...base,
  // @@@task-web-host — 网页版有会话页:后端是无头宿主(electron/session/headless),经 WebSocket 接入。
  capabilities: { ...base.capabilities, externalFileOpen: true, sessionHost: true, clipboard: true },
  writeClipboardText: writeBrowserClipboardText,
  saveFile: anchorDownload,
  async openRemoteFile(file) {
    const url = URL.createObjectURL(await fileBlob(file))
    const opened = window.open(url, '_blank', 'noopener,noreferrer')
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    if (!opened) throw new Error('The browser blocked the external file window')
  },
}
