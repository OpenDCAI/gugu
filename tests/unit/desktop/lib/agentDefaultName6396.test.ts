import { describe, expect, it, vi } from 'vitest'
import { AGENT_NAMING_WINDOW_MS, agentNamingUntil, agentNameSerial, isAgentDefaultName, nextAgentDefaultName, resolveAgentDefaultName } from '@gugu/core/shared/agentDefaultName'
import { VALID_AGENT_TYPES } from '@gugu/core/agentTypes'
import { getAgentTypeLabel } from '@gugu/core/shared/enums/agentTypeModels'

const owned = (...names: string[]) => names.map((display_name) => ({ display_name }))

it('shares the identity default-name definition across naming and presentation', () => {
  expect(isAgentDefaultName('Codex 158', 'codex')).toBe(true)
  expect(isAgentDefaultName('Claude 28', 'cc')).toBe(true)
  expect(isAgentDefaultName('Claude 28', null)).toBe(true)
  expect(isAgentDefaultName('Gemini CLI 3', 'gemini-cli')).toBe(true)
  expect(isAgentDefaultName('Named at spawn', 'codex')).toBe(false)
  expect(isAgentDefaultName('Claude (3)', 'claude-code')).toBe(false)
  expect(isAgentDefaultName('Codex 158', 'claude-code')).toBe(false)
})

describe('the identity naming display window', () => {
  const createdAt = '2026-11-02T08:00:00.000Z'
  const created = Date.parse(createdAt)
  const until = created + AGENT_NAMING_WINDOW_MS
  const deadline = (name: string, elapsed = 0) => agentNamingUntil(name, 'codex', createdAt, created + elapsed)

  it('shows an explicit spawn name immediately', () => {
    expect(deadline('Research assistant')).toBeNull()
  })
  it('stops the placeholder as soon as automatic naming succeeds', () => {
    expect(deadline('Codex 158')).toBe(until)
    expect(deadline('Lunar Eclipse Cause', 2_000)).toBeNull()
  })
  it.each(['disabled', 'no credits', 'short prompt', 'timeout'])('expires an unchanged default name at 60 seconds when naming has %s', () => {
    expect(deadline('Codex 158', 59_999)).toBe(until)
    expect(deadline('Codex 158', 60_000)).toBeNull()
  })
  it('shows the default before accepting a late harness title', () => {
    expect(deadline('Codex 158', 59_999)).toBe(until)
    expect(deadline('Codex 158', 60_000)).toBeNull()
    expect(deadline('Late harness title', 61_000)).toBeNull()
  })
  it('shows a manual rename immediately during the window', () => {
    expect(deadline('My assistant', 1_000)).toBeNull()
  })
  it('accepts the default-shaped manual name ambiguity only within the window', () => {
    expect(deadline('Codex 5', 1_000)).toBe(until)
    expect(deadline('Codex 5', 60_000)).toBeNull()
  })
  it('leaves older identities unchanged even when they still have default names', () => {
    expect(deadline('Codex 158', 86_400_000)).toBeNull()
    expect(deadline('codex (3)')).toBeNull()
  })
  it('recognizes every registered engine when the identity has no engine type', () => {
    for (const type of VALID_AGENT_TYPES) {
      expect(agentNamingUntil(`${getAgentTypeLabel(type)} 5`, undefined, createdAt, created)).toBe(until)
    }
    expect(agentNamingUntil('Codex 5', null, createdAt, created)).toBe(until)
    expect(agentNamingUntil('Research assistant', undefined, createdAt, created)).toBeNull()
    expect(agentNamingUntil('Codex 5', 'claude-code', createdAt, created)).toBeNull()
  })
  it('uses known creation times, including numeric timestamps and small server clock skew', () => {
    expect(agentNamingUntil('Codex 5', 'codex', created, created)).toBe(until)
    expect(agentNamingUntil('Codex 5', 'codex', created + 150, created)).toBe(until + 150)
    expect(agentNamingUntil('Codex 5', 'codex', undefined, created)).toBeNull()
    expect(agentNamingUntil('Codex 5', 'codex', 'invalid', created)).toBeNull()
  })
})

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
