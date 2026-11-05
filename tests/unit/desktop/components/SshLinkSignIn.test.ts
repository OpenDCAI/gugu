// #6264 远程 SSH 的机器连不上时「怎么修」只在一处说:一次挂一条、按设备列表的顺序;纯连不上不挂(各模块自己说「问不到」);
// 收起之后同一台同一种原因不再出现,原因变了再出现。
import { describe, expect, it } from 'vitest'
import { pickSshLinkNotice } from '@/lib/sshLinkNotice'
import type { SshLinkFailure } from '@/lib/sshLink'

const machines = [
  { device_id: 'a', label: 'Linux 1' },
  { device_id: 'b', label: 'Linux 2' },
]

describe('pickSshLinkNotice', () => {
  it('要登录 / 指纹变了 / 太旧 / 被拒绝 / 没登 / 没装 才挂;纯连不上、没映射不挂', () => {
    const pick = (reason: SshLinkFailure) =>
      pickSshLinkNotice({ problems: new Map([['a', reason]]), machines, dismissed: new Map() })?.reason ?? null
    expect(pick('signInRequired')).toBe('signInRequired')
    expect(pick('hostKeyChanged')).toBe('hostKeyChanged')
    expect(pick('outdated')).toBe('outdated')
    // 被拒绝照实挂出来(说「拒绝了连接」),❌ 冒充「版本太旧」。
    expect(pick('refused')).toBe('refused')
    expect(pick('notSignedIn')).toBe('notSignedIn')
    expect(pick('notInstalled')).toBe('notInstalled')
    expect(pick('unreachable')).toBeNull()
    expect(pick('unmapped')).toBeNull()
  })

  it('一次一条,按设备列表顺序;收起的那条(同一种原因)跳过,原因变了再出现;不在列表里的机器不挂', () => {
    const problems = new Map<string, SshLinkFailure>([
      ['b', 'signInRequired'],
      ['a', 'outdated'],
      ['gone', 'signInRequired'],
    ])
    expect(pickSshLinkNotice({ problems, machines, dismissed: new Map() })).toEqual({ deviceId: 'a', name: 'Linux 1', reason: 'outdated' })
    const dismissed = new Map<string, SshLinkFailure>([['a', 'outdated']])
    expect(pickSshLinkNotice({ problems, machines, dismissed })?.deviceId).toBe('b')
    problems.set('a', 'signInRequired')
    expect(pickSshLinkNotice({ problems, machines, dismissed })?.deviceId).toBe('a')
    expect(pickSshLinkNotice({ problems: new Map([['gone', 'signInRequired']]), machines, dismissed: new Map() })).toBeNull()
  })
})
