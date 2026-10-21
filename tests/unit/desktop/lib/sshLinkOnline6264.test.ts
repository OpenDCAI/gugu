/**
 * #6264 远程 SSH 的机器,在添加它的电脑上:在不在线只看这台电脑到它的设备连接(侧栏、选择器、设置 → 设备同一个读数)。
 */
import { describe, expect, it } from 'vitest'
import { sshLinkFacts, withSshLinkOnline } from '../../../../apps/desktop/src/lib/sshLinkOnline'

describe('远程 SSH 的机器在不在线只看设备连接(一个读数,各处同一个说法)', () => {
  it('要先登录 / 指纹变了 → 不在线 + 要先登录;没登这个账号 → 不在线;连不上 → 在重连;连着 → 在线', () => {
    expect(sshLinkFacts(true, 'signInRequired', true)).toEqual({ isOnline: false, sshLink: 'signInRequired' })
    expect(sshLinkFacts(true, 'hostKeyChanged', true)).toEqual({ isOnline: false, sshLink: 'signInRequired' })
    expect(sshLinkFacts(true, 'notSignedIn', true)).toEqual({ isOnline: false, sshLink: null })
    expect(sshLinkFacts(true, 'unreachable', false)).toEqual({ isOnline: true, sshLink: 'unreachable' })
    expect(sshLinkFacts(true, null, false)).toEqual({ isOnline: true, sshLink: null })
    expect(sshLinkFacts(false, 'signInRequired', false)).toEqual({ isOnline: false })
  })

  it('版本太旧 / 正在替它更新:说真实状态,❌ 落成「重连中」(unreachable)', () => {
    expect(sshLinkFacts(true, 'outdated', true)).toEqual({ isOnline: true, sshLink: 'outdated' })
    expect(sshLinkFacts(true, 'updating', true)).toEqual({ isOnline: true, sshLink: 'updating' })
  })

  it('被拒绝 / 没在跑:❌ 说成「版本太旧」(升级只因为版本),按连不上、在重连', () => {
    expect(sshLinkFacts(true, 'refused', true)).toEqual({ isOnline: true, sshLink: 'unreachable' })
    expect(sshLinkFacts(true, 'notRunning', true)).toEqual({ isOnline: true, sshLink: 'unreachable' })
  })

  it('设备列表:只改远程 SSH 那几行,❌ 动别的机器(云心跳照旧)', () => {
    const rows = [
      { device_id: 'srv', is_online: true },
      { device_id: 't1', is_online: false },
    ]
    const out = withSshLinkOnline(rows, new Set(['srv']), new Map([['srv', 'signInRequired' as const]]))
    expect(out).toEqual([
      { device_id: 'srv', is_online: false },
      { device_id: 't1', is_online: false },
    ])
    expect(withSshLinkOnline(rows, new Set(['srv']), new Map())[0]).toBe(rows[0])
  })
})
