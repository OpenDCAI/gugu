import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyAccountEnv, killAccountTmuxServer } from '../../../../apps/desktop/electron/server/server-layout'

// #6264 账号被主人从「设置 → 设备」移除:这个账号留在 tmux 里的 agent / 终端要一并结束。
// 只结束这个账号自己的 tmux 服务端 —— 同一个 Linux 用户下别的账号、用户自己的 tmux、桌面版的都不碰。
describe('killAccountTmuxServer', () => {
  // applyAccountEnv 顺带算这个账号的目录,要知道 server 的根目录(server 入口会设)。
  const home = process.env.GUGU_SERVER_HOME
  beforeAll(() => { process.env.GUGU_SERVER_HOME = '/srv/gugu-server-home' })
  afterAll(() => { if (home === undefined) delete process.env.GUGU_SERVER_HOME; else process.env.GUGU_SERVER_HOME = home })
  const calls = () => {
    const seen: Array<[string, string[]]> = []
    return { seen, run: async (command: string, args: string[]) => { seen.push([command, args]) } }
  }

  it('结束的正是 applyAccountEnv 给这个账号定的那个 socket,用包里带的 tmux', async () => {
    const env: NodeJS.ProcessEnv = { GUGU_TMUX_BIN: '/srv/gugu/tmux-bundle/tmux' }
    applyAccountEnv('0123456789abcdef', env)
    const { seen, run } = calls()
    await expect(killAccountTmuxServer(env, run)).resolves.toBe(true)
    expect(seen).toEqual([['/srv/gugu/tmux-bundle/tmux', ['-L', 'gugu-server-01234567', 'kill-server']]])
  })

  it('不是 server 账号进程(桌面版的 gugu socket、没设 socket)就什么都不动', async () => {
    for (const env of [{ GUGU_TMUX_SOCKET_LABEL: 'gugu' }, { GUGU_TMUX_SOCKET_LABEL: 'gugu-beta' }, {}]) {
      const { seen, run } = calls()
      await expect(killAccountTmuxServer(env, run)).resolves.toBe(false)
      expect(seen).toEqual([])
    }
  })

  it('那边本来就没有 tmux 服务端在跑(kill-server 失败)不算失败,移除流程照常往下走', async () => {
    const env: NodeJS.ProcessEnv = {}
    applyAccountEnv('fedcba9876543210', env)
    await expect(killAccountTmuxServer(env, async () => { throw new Error('no server running on /tmp/tmux-0/gugu-server-fedcba98') }))
      .resolves.toBe(true)
  })
})
