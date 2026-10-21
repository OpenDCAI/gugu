import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { enableOverlayScrollbars, OVERLAY_SCROLLBAR_FEATURE } from '../../../../apps/desktop/electron/windows-overlay-scrollbars'

function recordingCommandLine() {
  const switches: Array<[string, string | undefined]> = []
  return { switches, appendSwitch: (key: string, value?: string) => void switches.push([key, value]) }
}

it('Windows 上在 ready 前打开 Chromium 的 OverlayScrollbar(会话页树的 thin 条才是悬浮式)', () => {
  const commandLine = recordingCommandLine()
  expect(enableOverlayScrollbars(commandLine, 'win32')).toBe(true)
  expect(commandLine.switches).toEqual([['enable-features', 'OverlayScrollbar']])
  expect(OVERLAY_SCROLLBAR_FEATURE).toBe('OverlayScrollbar')
})

it('mac 与 Linux 不追加任何开关', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const commandLine = recordingCommandLine()
    expect(enableOverlayScrollbars(commandLine, platform)).toBe(false)
    expect(commandLine.switches).toEqual([])
  }
})

it('主进程源码里 enable-features 只有这一处写(同名开关追加两次,Chromium 只认最后一个值)', () => {
  const root = join(__dirname, '../../../../apps/desktop/electron')
  const writers: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(ts|mts|cts)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
        if (/appendSwitch\(\s*['"]enable-features['"]/.test(readFileSync(path, 'utf8'))) writers.push(path.slice(root.length + 1))
      }
    }
  }
  walk(root)
  expect(writers).toEqual(['windows-overlay-scrollbars.ts'])
})
