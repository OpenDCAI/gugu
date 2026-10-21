/**
 * #7016 一台远程 SSH 机器一条 `gugu-server link`:主进程(agent 的 session_* 跨机器)挂在窗口那条连接上(ssh-link-ipc 的 tap)。
 * link manager 主动收掉不报 onClosed —— 窗口那头关、机器被移除时,挂着的那几位要由 ssh-link-ipc 告诉,否则主进程那条管道
 * 以为线还在,之后每次调用都报「ssh link is not open」,直到重启。
 * 可见域:registerSshLinkIpc 的 close 包装(返回值的 close / closeAll、IPC 的 close 通道);不起真 ssh。
 */
import { describe, expect, it, vi } from 'vitest'
import { registerSshLinkIpc } from '../../../../apps/desktop/electron/server/ssh-link-ipc'
import { SSH_LINK_CHANNELS } from '../../../../apps/desktop/src/lib/sshLink'

function register() {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipcMain = { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, fn) }
  const links = registerSshLinkIpc({
    ipcMain: ipcMain as unknown as Electron.IpcMain,
    getWindow: () => null,
    store: { list: () => [], onChange: () => () => undefined } as never,
    currentUserId: async () => 'owner-1',
  })
  return { links, handlers }
}

describe('ssh-link-ipc tap: an active close reaches whoever listens on that link', () => {
  it('the returned close tells every tap on that machine, and only that machine', () => {
    const { links } = register()
    const closedB = vi.fn()
    const closedC = vi.fn()
    links.tap('dev-b', { onMessage: () => undefined, onClosed: closedB })
    links.tap('dev-c', { onMessage: () => undefined, onClosed: closedC })
    links.close('dev-b')
    expect(closedB).toHaveBeenCalledWith('closed')
    expect(closedC).not.toHaveBeenCalled()
  })

  it('the window closing the link over IPC tells the taps too', async () => {
    const { links, handlers } = register()
    const closed = vi.fn()
    links.tap('dev-b', { onMessage: () => undefined, onClosed: closed })
    await handlers.get(SSH_LINK_CHANNELS.close)!({}, 'dev-b')
    expect(closed).toHaveBeenCalledWith('closed')
  })

  it('an untapped listener hears nothing', () => {
    const { links } = register()
    const closed = vi.fn()
    const untap = links.tap('dev-b', { onMessage: () => undefined, onClosed: closed })
    untap()
    links.close('dev-b')
    expect(closed).not.toHaveBeenCalled()
  })
})
