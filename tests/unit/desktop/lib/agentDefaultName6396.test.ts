import { describe, expect, it, vi } from 'vitest'
import { agentNameSerial, nextAgentDefaultName, resolveAgentDefaultName } from '@gugu/core/shared/agentDefaultName'

const owned = (...names: string[]) => names.map((display_name) => ({ display_name }))

describe('#6396 默认序号 = 用过的最大号 + 1', () => {
  it('不填空:现存 4 / 28 ⇒ 29(旧规则「数量 + 1」给 3)', () => {
    expect(nextAgentDefaultName(owned('Claude 4', 'Claude 28', '压页数'), 'Claude')).toBe('Claude 29')
  })

  it('服务端账本比现存名字高 ⇒ 从账本 + 1 起;账本低于现存名字 ⇒ 名字说了算', () => {
    expect(nextAgentDefaultName(owned('Claude 28'), 'Claude', { floor: 40 })).toBe('Claude 41')
    expect(nextAgentDefaultName(owned('Claude 28'), 'Claude', { floor: 3 })).toBe('Claude 29')
  })

  it('云端那一份名字也算用过的号', () => {
    expect(nextAgentDefaultName(owned('Claude 2'), 'Claude', { reservedNames: ['Claude 9'] })).toBe('Claude 10')
  })

  it('每个前缀各数各的;「Claude Code 5」不是「Claude」的 5 号', () => {
    expect(nextAgentDefaultName(owned('Codex 12', 'Claude Code 5', 'Claude 2'), 'Claude')).toBe('Claude 3')
    expect(nextAgentDefaultName(owned('Codex 12'), 'Codex')).toBe('Codex 13')
  })

  it('解析口径与服务端一致:末尾空白 + 最多 9 位数字', () => {
    expect(agentNameSerial('Claude 28', 'Claude')).toBe(28)
    expect(agentNameSerial('  Claude 7 ', 'Claude')).toBe(7)
    expect(agentNameSerial('Claude28', 'Claude')).toBeNull()
    expect(agentNameSerial('Claude 1234567890', 'Claude')).toBeNull()
    expect(agentNameSerial('Gemini CLI 3', 'Gemini CLI')).toBe(3)
  })

  it('建号前两路取数任何一路失败都不挡建号:名单退回快照、账本退回 0', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      await expect(resolveAgentDefaultName(
        async () => { throw new Error('offline') },
        owned('Claude 5'),
        async () => 30,
        'Claude',
      )).resolves.toBe('Claude 31')
      await expect(resolveAgentDefaultName(
        async () => owned('Claude 5', 'Claude 6'),
        owned(),
        async () => { throw new Error('no table yet') },
        'Claude',
      )).resolves.toBe('Claude 7')
    } finally {
      warn.mockRestore()
    }
  })
})
