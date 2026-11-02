import { describe, expect, it, vi } from 'vitest'
import { readComputerForegroundWindow } from '../../../../apps/desktop/electron/device-actions/computer-control-foreground'

const signal = new AbortController().signal
const bounds = { x: 100, y: 100, width: 600, height: 400 }

describe('foreground attachment for an unresolved Computer Use App', () => {
  it('reads the active App and its frontmost normal window without dispatching input', async () => {
    const callTool = vi.fn(async (name: string) => ({ structuredContent: name === 'list_apps'
      ? { apps: [{ pid: 8 }, { pid: 7, active: true }] }
      : { windows: [
          { pid: 7, window_id: 10, is_on_screen: true, layer: 1, bounds },
          { pid: 7, window_id: 12, is_on_screen: true, on_current_space: false, bounds },
          { pid: 7, window_id: 11, is_on_screen: true, bounds },
          { pid: 7, window_id: 13, is_on_screen: true, bounds },
        ] } }))
    expect(await readComputerForegroundWindow({ callTool }, signal)).toEqual({ pid: 7, windowId: 11, bounds })
    expect(callTool.mock.calls.map(([name]) => name)).toEqual(['list_apps', 'list_windows'])
    expect(callTool).toHaveBeenLastCalledWith('list_windows', { pid: 7, on_screen_only: true }, expect.objectContaining({ signal, timeoutMs: 2_000 }))
  })

  it('does not invent a window when foreground lookup is unavailable or has no valid visible window', async () => {
    for (const response of [{ isError: true }, { structuredContent: { apps: [] } }, { structuredContent: { apps: [{ pid: 7, active: true }], windows: [{ pid: 7, window_id: 11, is_on_screen: false, bounds }] } }]) {
      const callTool = vi.fn(async () => response)
      expect(await readComputerForegroundWindow({ callTool }, signal)).toBeNull()
    }
  })
})
