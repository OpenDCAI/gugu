// Build and release-contract analysis must start from the same product entrypoints.
import { fileURLToPath } from 'node:url'
import { emdashWorkerEntries } from '../../apps/desktop/electron/sessionpage/emdash-aliases.mjs'

export const rendererHtmlEntries: Record<string, string> = {
  index: fileURLToPath(new URL('../../apps/desktop/index.html', import.meta.url)),
  task: fileURLToPath(new URL('../../apps/desktop/session-embedded.html', import.meta.url)),
}
const workers = Object.fromEntries(emdashWorkerEntries.map(({ out, src }) => [out, src]))
export const desktopMainEntries: Record<string, string> = {
  main: 'electron/main.ts',
  // 咕咕 server(product spec):同一份主进程、同一次构建,只是没有窗口 —— 共用 chunk,❌ 另起一套。
  server: 'electron/server-entry.ts',
  'emdash-main-bridge': 'electron/sessionpage/emdash-main-bridge.ts',
  ...workers,
}
export const webHostEntries: Record<string, string> = { 'task-host': 'electron/session-host-entry.ts', ...workers }
export const desktopPreloadEntry = 'electron/preload.ts'
export const extensionPreloadEntry = 'electron/extension-bridge-preload.ts'
