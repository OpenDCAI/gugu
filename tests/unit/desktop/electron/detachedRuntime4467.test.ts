import { describe, expect, it } from 'vitest'
import { liveTmuxSessionIds } from '../../../../apps/desktop/electron/sessionpage/detached-runtime'

// #4467:「没有 tmux 服务器」是一个读数(没有活会话);「tmux 调用失败」不是 —— 当成空集会让结清撤掉仍在跑的进程的票。
const sessionName = (projectId: string, sessionId: string) =>
  `gugu-${Buffer.from(`${projectId}:${sessionId}:${sessionId}`, 'utf8').toString('base64url')}`

function ctx(exec: () => Promise<{ stdout: string; stderr: string }>) {
  return { supportsLocalSpawn: true, exec } as never
}

describe('#4467 仍在 tmux 里跑的会话', () => {
  it('decodes our engine session names to conversation ids and ignores terminals and foreign sessions', async () => {
    const terminal = `gugu-${Buffer.from('p1:conv-a:term-1', 'utf8').toString('base64url')}`
    const oldPrefix = `emdash-${Buffer.from('p1:conv-c:conv-c', 'utf8').toString('base64url')}`
    const stdout = [sessionName('p1', 'conv-a'), 'someone-elses-session', terminal, oldPrefix, sessionName('p1', 'conv-b'), ''].join('\n')
    await expect(liveTmuxSessionIds(ctx(async () => ({ stdout, stderr: '' }))))
      .resolves.toEqual(new Set(['conv-a', 'conv-b']))
  })

  it('reads "no server running" as no live sessions', async () => {
    const noServer = Object.assign(new Error('Command failed: tmux list-sessions'), {
      stderr: 'no server running on /private/tmp/tmux-501/gugu',
    })
    await expect(liveTmuxSessionIds(ctx(async () => { throw noServer }))).resolves.toEqual(new Set())
  })

  it('throws on any other tmux failure instead of reporting nothing running', async () => {
    const broken = Object.assign(new Error('spawn tmux ENOENT'), { stderr: '' })
    await expect(liveTmuxSessionIds(ctx(async () => { throw broken }))).rejects.toThrow(/cannot list tmux sessions/)
  })
})
