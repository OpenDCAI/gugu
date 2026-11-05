// #6264 不问人的一次性 SSH 命令(`gugu-server link` / `status --json`)的参数。
import { describe, expect, it } from 'vitest'
import { sshBatchArgs } from '../../../../apps/desktop/electron/server/ssh-batch'

describe('ssh 参数', () => {
  it('不问人要密码(BatchMode),复用终端那条连接,目的地前有 --', () => {
    const args = sshBatchArgs({ destination: 'alice@host', port: 2222, display: 'alice@host:2222' }, 'CMD', '/tmp/cm-%C')
    expect(args).toContain('BatchMode=yes')
    expect(args).toContain('ControlPath=/tmp/cm-%C')
    expect(args.slice(-3)).toEqual(['--', 'alice@host', 'CMD'])
    expect(args[args.indexOf('-p') + 1]).toBe('2222')
  })

  it('添加机器时给的额外选项(-i / -J)照样带上,且在 -- 之前', () => {
    const args = sshBatchArgs(
      { destination: 'alice@host', display: 'alice@host', options: ['-i', '/Users/a/.ssh/id_x', '-J', 'jump@bastion'] },
      'CMD',
      null,
    )
    const dash = args.indexOf('--')
    expect(args.indexOf('-i')).toBeGreaterThan(-1)
    expect(args.indexOf('-i')).toBeLessThan(dash)
    expect(args[args.indexOf('-i') + 1]).toBe('/Users/a/.ssh/id_x')
    expect(args[args.indexOf('-J') + 1]).toBe('jump@bastion')
    expect(args.slice(-3)).toEqual(['--', 'alice@host', 'CMD'])
  })
})
