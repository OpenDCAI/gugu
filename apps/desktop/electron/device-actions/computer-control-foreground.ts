import type { Rectangle } from 'electron'
import type { CuaClient } from './native/cua-client'
import { resolveComputerWindow } from './computer-control-placement'

export interface ComputerForegroundWindow {
  pid: number
  windowId: number
  bounds: Rectangle
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function computerControlWindowReaders(cua: () => Pick<CuaClient, 'callTool'>) {
  return {
    readWindows: (pid: number, signal: AbortSignal) => cua().callTool('list_windows', { pid, on_screen_only: true }, { signal, timeoutMs: 2_000, lane: 'gugu-computer-indicator' }),
    readForegroundWindow: (signal: AbortSignal) => readComputerForegroundWindow(cua(), signal),
  }
}

/** Read-only fallback for an act whose App could not be resolved. list_windows
 * is front-to-back; skip menus and windows outside the current workspace. */
export async function readComputerForegroundWindow(cua: Pick<CuaClient, 'callTool'>, signal: AbortSignal): Promise<ComputerForegroundWindow | null> {
  const options = { signal, timeoutMs: 2_000, lane: 'gugu-computer-indicator' }
  const apps = await cua.callTool('list_apps', {}, options)
  const data = apps.structuredContent
  if (apps.isError || !record(data) || !Array.isArray(data.apps)) return null
  const active = data.apps.find((app) => record(app) && app.active === true)
  if (!record(active) || typeof active.pid !== 'number' || !Number.isSafeInteger(active.pid) || active.pid <= 0) return null
  const windows = await cua.callTool('list_windows', { pid: active.pid, on_screen_only: true }, options)
  const listed = windows.structuredContent
  if (windows.isError || !record(listed) || !Array.isArray(listed.windows)) return null
  const front = listed.windows.find((window) => record(window) && window.pid === active.pid && window.is_on_screen === true && window.on_current_space !== false && (window.layer ?? 0) === 0)
  if (!record(front) || typeof front.window_id !== 'number') return null
  const matched = resolveComputerWindow(listed, { pid: active.pid, windowId: front.window_id })
  return matched ? { pid: active.pid, ...matched } : null
}
