import { describe, expect, it } from 'vitest'
import { quickChatAccelerator, shortcutLabel } from '../../../../apps/desktop/src/lib/quickChatIpc'

// #7199 快速聊天的默认快捷键:避开系统(聚焦搜索、切输入法、窗口菜单)与常见 AI 工具 / 启动器的默认键。
describe('quickChatAccelerator / shortcutLabel', () => {
  it('mac 是 ⌥⇧Space,❌ ⌘Space / ⌃Space / ⌥Space', () => {
    const accelerator = quickChatAccelerator('darwin')
    expect(accelerator).toBe('Alt+Shift+Space')
    expect(['Command+Space', 'Control+Space', 'Alt+Space', 'Control+Alt+Space']).not.toContain(accelerator)
    expect(shortcutLabel(accelerator, 'darwin')).toBe('⌥⇧Space')
  })

  it('Windows / Linux 是 Ctrl+Alt+Space,❌ Alt+Space / Ctrl+Space / Shift+Space', () => {
    for (const platform of ['win32', 'linux']) {
      const accelerator = quickChatAccelerator(platform)
      expect(accelerator).toBe('Control+Alt+Space')
      expect(['Alt+Space', 'Control+Space', 'Shift+Space', 'Super+Space']).not.toContain(accelerator)
      expect(shortcutLabel(accelerator, platform)).toBe('Ctrl+Alt+Space')
    }
  })
})
