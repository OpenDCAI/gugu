// @vitest-environment jsdom
/**
 * #7199 远程隧道上的设备连接连不上 / 断了:原因由远程隧道自己报,❌ 记成远程 SSH 的「要先登录」卡片。
 * 主进程在应答与断开事件上标 via: 'tunnel';渲染层只认这个标,❌ 靠远程 SSH 清单加载先后去猜(清单没到时
 * 远程 SSH 机器的问题照样要记,替它升级的进度也是)。
 */
import { afterAll, describe, expect, it } from 'vitest'
import { SSH_LINK_CHANNELS, type SshLinkFailure } from '../../../../apps/desktop/src/lib/sshLink'

const events = new Map<string, (data: unknown) => void>()
const openResults: Record<string, unknown> = {
  tun1: { ok: false, reason: 'signInRequired', via: 'tunnel' },
  ssh1: { ok: false, reason: 'signInRequired' },
}
const bridge = {
  invoke: async (channel: string, arg: unknown) => (channel === SSH_LINK_CHANNELS.open ? openResults[arg as string] : null),
  eventOn: (channel: string, cb: (data: unknown) => void) => {
    events.set(channel, cb)
    return () => events.delete(channel)
  },
}
;(window as unknown as { electronAPI?: unknown }).electronAPI = bridge

afterAll(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('远程隧道上的设备连接:原因 ❌ 进远程 SSH 那张卡', () => {
  it('打开失败与断开都按主进程标的 via 分;没标的(远程 SSH)照记,与清单到没到无关', async () => {
    const { openSshLink, subscribeSshLinkProblems } = await import('../../../../apps/desktop/src/lib/sshLinkChannel')
    let problems: ReadonlyMap<string, SshLinkFailure> = new Map()
    const off = subscribeSshLinkProblems((next) => (problems = next))
    const closed: string[] = []
    const handlers = (id: string) => ({ onMessage: () => undefined, onClosed: (reason: SshLinkFailure) => closed.push(`${id}:${reason}`) })

    await expect(openSshLink('tun1', handlers('tun1')).ready).rejects.toMatchObject({ reason: 'signInRequired' })
    await expect(openSshLink('ssh1', handlers('ssh1')).ready).rejects.toMatchObject({ reason: 'signInRequired' })
    expect(problems.has('tun1')).toBe(false)
    expect(problems.get('ssh1')).toBe('signInRequired')

    const onClosed = events.get(SSH_LINK_CHANNELS.closed)!
    onClosed({ deviceId: 'tun1', reason: 'unreachable', via: 'tunnel' })
    onClosed({ deviceId: 'ssh1', reason: 'unreachable' })
    expect(problems.has('tun1')).toBe(false)
    expect(problems.get('ssh1')).toBe('unreachable')
    // 断开照样告诉开着它的那一方(设备 RPC 据此重开 / 换管道)。
    expect(closed).toEqual(['tun1:unreachable', 'ssh1:unreachable'])
    off()
  })
})
