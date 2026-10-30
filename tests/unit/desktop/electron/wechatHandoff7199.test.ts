// #7199 升级交接:桌面第一版在本机连过的微信交给管家,交成功(或管家已有)才删本机那份;交不出去留着下次再交。
import { describe, expect, it, vi } from 'vitest'
import { CloudComputerError } from '@gugu/core/cloud/cloudComputer'
import type { ChatChannelsClient } from '@gugu/core/cloud/chatChannels'
import { handOffLegacyWechat } from '../../../../apps/desktop/electron/wechat/handoff'
import type { LegacyWechatRecord } from '../../../../apps/desktop/electron/wechat/store'

const RECORD: LegacyWechatRecord = {
  version: 1,
  credentials: { botToken: 'tok', botId: 'b@im.bot', baseUrl: 'https://ilinkai.weixin.qq.com', userId: 'u@im.wechat' },
  agentId: 'agent-1',
  connectedAt: 1_792_000_000_000,
  cursor: { updatesBuf: 'buf', contextToken: 'ctx' },
}

function setup(opts: { record?: LegacyWechatRecord | null | Error; importResult?: 'imported' | 'already_connected' | Error; noClient?: boolean }) {
  const remove = vi.fn()
  const read = vi.fn(() => {
    if (opts.record instanceof Error) throw opts.record
    return opts.record ?? null
  })
  const importLegacy = vi.fn(async () => {
    if (opts.importResult instanceof Error) throw opts.importResult
    return opts.importResult ?? 'imported'
  })
  const client = opts.noClient ? null : ({ importLegacy } as unknown as ChatChannelsClient)
  const log = { info: vi.fn(), warn: vi.fn() }
  return { run: () => handOffLegacyWechat({ userId: 'owner-1', store: { read, remove }, client, log }), remove, importLegacy, log }
}

describe('handOffLegacyWechat', () => {
  it('本机没有旧连接:什么都不做', async () => {
    const s = setup({ record: null })
    await expect(s.run()).resolves.toBe('none')
    expect(s.importLegacy).not.toHaveBeenCalled()
  })

  it('交给管家(凭据 + 游标 + 原来的 agent 与连接时刻),交完删本机那份', async () => {
    const s = setup({ record: RECORD })
    await expect(s.run()).resolves.toBe('handed_off')
    expect(s.importLegacy).toHaveBeenCalledWith('wechat', {
      legacy: { credentials: RECORD.credentials, cursor: RECORD.cursor },
      agentId: 'agent-1',
      connectedAt: RECORD.connectedAt,
    })
    expect(s.remove).toHaveBeenCalledWith('owner-1')
  })

  it('管家已经有微信连接:也删本机那份(管家那份更新)', async () => {
    const s = setup({ record: RECORD, importResult: 'already_connected' })
    await expect(s.run()).resolves.toBe('handed_off')
    expect(s.remove).toHaveBeenCalled()
  })

  it('交不出去(没开放 / 网络断了 / 没有管家地址 / 文件解不开):留着,❌ 删', async () => {
    for (const s of [
      setup({ record: RECORD, importResult: new CloudComputerError(503, 'unavailable', 'Channel service signing key is not configured.') }),
      setup({ record: RECORD, importResult: new CloudComputerError(0, 'network', 'ECONNRESET') }),
      setup({ record: RECORD, noClient: true }),
      setup({ record: new Error('decrypt failed') }),
    ]) {
      await expect(s.run()).resolves.toBe('kept')
      expect(s.remove).not.toHaveBeenCalled()
    }
  })
})
