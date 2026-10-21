// @vitest-environment jsdom
// #7199 搬家的设置入口:住哪台 × 会员与否,各自看见什么;点了先列清会带走什么,点「开始搬家」才搬。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, Fragment } from 'react'
import { createNode, createReactHarness } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

const mocks = vi.hoisted(() => ({
  tier: 'plus' as 'free' | 'plus',
  pending: null as unknown,
  previewMove: vi.fn(),
  runAssistantMove: vi.fn(),
  list: vi.fn(async () => [{ id: 'notion', name: 'Notion' }]),
}))

vi.mock('../../../../apps/desktop/src/lib/billing/membership', () => ({
  getMembership: async () => ({ tier: mocks.tier }),
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-move-wire', () => ({
  pendingMove: () => mocks.pending,
  previewMove: (...args: unknown[]) => mocks.previewMove(...args),
  runAssistantMove: (...args: unknown[]) => mocks.runAssistantMove(...args),
}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({
  rpcOn: () => ({ integrations: { list: mocks.list } }),
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-home-sessions', () => ({
  homeTarget: () => null,
}))

import { AssistantMoveGroup } from '../../../../apps/desktop/src/components/assistant/AssistantMoveGroup'
import { AssistantMoveDialog } from '../../../../apps/desktop/src/components/assistant/AssistantMoveDialog'
import { resetMoveForTests } from '../../../../apps/desktop/src/session/renderer/features/assistant/assistant-move-controller'
import type { AssistantHomePlace } from '../../../../apps/desktop/src/lib/assistantHome'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  mocks.tier = 'plus'
  mocks.pending = null
  mocks.previewMove.mockReset()
  mocks.runAssistantMove.mockReset()
  resetMoveForTests()
})
afterEach(() => harness.cleanup())

const computer: AssistantHomePlace = { kind: 'computer', deviceId: 'dev-mac', thisDevice: true, label: 'MacBook', online: true, known: true }
const cloud: AssistantHomePlace = { kind: 'cloud', deviceId: 'dev-cloud' }

const groupProps = (home: AssistantHomePlace, over: Record<string, unknown> = {}) => ({
  ownerUserId: 'owner-1',
  assistantId: 'agent-1',
  assistantName: '小满',
  home,
  localDeviceId: 'dev-mac',
  cloudAvailable: true,
  ...over,
})
// 弹窗挂在壳上(不在搬家那一组里):测试里把两者并排画,与生产一致。
const render = async (home: AssistantHomePlace, over: Record<string, unknown> = {}) => {
  await harness.render(createElement(Fragment, null, createNode(AssistantMoveGroup, groupProps(home, over)), createElement(AssistantMoveDialog)))
  // getMembership 是异步读:等一拍
  await act(async () => {})
}
const q = (id: string) => harness.container.querySelector(`[data-testid="${id}"]`)
const body = () => document.body.textContent ?? ''

describe('搬家入口', () => {
  it('住这台电脑 + 会员:「搬到云上」可点;没有「会员到期」那一行', async () => {
    await render(computer)
    expect(q('assistant-move-to-cloud')).not.toBeNull()
    expect((q('assistant-move-to-cloud') as HTMLButtonElement).disabled).toBe(false)
    expect(q('assistant-move-expired')).toBeNull()
    expect(q('assistant-move-to-computer')).toBeNull()
  })

  it('住这台电脑 + 非会员:不给搬,指向会员', async () => {
    mocks.tier = 'free'
    await render(computer)
    expect(q('assistant-move-to-cloud')).toBeNull()
    expect(q('assistant-move-member')).not.toBeNull()
  })

  it('住云上 + 会员已到期:写「在休息」+ 续费,同时给「搬回这台电脑」', async () => {
    mocks.tier = 'free'
    await render(cloud)
    expect(q('assistant-move-expired')?.textContent).toContain('会员已到期')
    expect(q('assistant-move-renew')).not.toBeNull()
    expect(q('assistant-move-to-computer')).not.toBeNull()
  })

  it('住云上 + 会员在期:只有「搬回这台电脑」', async () => {
    await render(cloud)
    expect(q('assistant-move-expired')).toBeNull()
    expect(q('assistant-move-to-computer')).not.toBeNull()
  })

  it('网页 / 手机(没有这台电脑)不给搬回', async () => {
    await render(cloud, { localDeviceId: null })
    expect(q('assistant-move-to-computer')).toBeNull()
  })

  it('上次没搬完:给「接着搬」', async () => {
    mocks.pending = { direction: 'to-cloud', assistantId: 'agent-1', startedAt: 1, done: [], schedules: null, source: { kind: 'computer', deviceId: 'dev-mac' } }
    await render(computer)
    expect(q('assistant-move-resume')).not.toBeNull()
  })
})

describe('点了先列清带走什么,确认才搬', () => {
  it('确认框列账号名与要重新连的,不含密钥;点开始才调用搬', async () => {
    mocks.previewMove.mockResolvedValue({
      bytes: 2048,
      files: 3,
      skippedFiles: [],
      accounts: {
        moving: [{ integrationId: 'notion', accountId: 'default', displayName: '阿满的 Notion' }],
        reconnect: [{ integrationId: 'dingtalk', reason: 'cli' }],
        unsupported: false,
      },
    })
    mocks.runAssistantMove.mockResolvedValue({
      files: 3,
      skippedFiles: [],
      accounts: { moved: [{ integrationId: 'notion', accountId: 'default' }], skipped: [], kept: [], unsupported: false },
      schedules: { restored: 2, skipped: [], unsupported: [], unreadable: false },
      warnings: [],
    })
    await render(computer)

    await act(async () => {
      (q('assistant-move-to-cloud') as HTMLButtonElement).click()
    })
    await act(async () => {})
    expect(mocks.previewMove).toHaveBeenCalledWith(expect.objectContaining({ assistantId: 'agent-1' }), 'to-cloud')
    expect(mocks.runAssistantMove).not.toHaveBeenCalled()
    const confirm = document.body.querySelector('[data-testid="assistant-move-confirm"]') as HTMLButtonElement | null
    expect(confirm).not.toBeNull()
    expect(body()).toContain('Notion · 阿满的 Notion')
    // 服务名表里没有钉钉(mock 只给了 Notion)→ 退回 id,仍然列出来、不吞
    expect(body()).toContain('dingtalk')
    expect(body()).not.toMatch(/accessToken|secret/i)

    await act(async () => {
      confirm!.click()
    })
    await act(async () => {})
    expect(mocks.runAssistantMove).toHaveBeenCalledWith(expect.objectContaining({ assistantId: 'agent-1' }), 'to-cloud', expect.any(Function))
    expect(document.body.querySelector('[data-testid="assistant-move-report"]')?.textContent).toContain('1 个账号已搬过去')
  })

  it('读不到旧家时说读不到、什么都没变,不进确认', async () => {
    mocks.previewMove.mockRejectedValue(new Error('offline'))
    await render(computer)
    await act(async () => {
      (q('assistant-move-to-cloud') as HTMLButtonElement).click()
    })
    await act(async () => {})
    expect(document.body.querySelector('[data-phase="confirm"]')).toBeNull()
    expect(document.body.querySelector('[data-phase="prepare-failed"]')).not.toBeNull()
  })

  it('搬着时「它住哪」翻面、搬家那一组换了位置重挂:弹窗与进度不丢(状态在模块里,不在组件里)', async () => {
    mocks.previewMove.mockResolvedValue({ bytes: 0, files: 0, skippedFiles: [], accounts: { moving: [], reconnect: [], unsupported: false } })
    let finish: (value: unknown) => void = () => undefined
    mocks.runAssistantMove.mockImplementation(
      (_env: unknown, _direction: unknown, onProgress: (p: unknown) => void) =>
        new Promise((resolve) => {
          onProgress({ step: 'adopt' })
          finish = resolve
        })
    )
    await render(computer)
    await act(async () => {
      (q('assistant-move-to-cloud') as HTMLButtonElement).click()
    })
    await act(async () => {})
    await act(async () => {
      (document.body.querySelector('[data-testid="assistant-move-confirm"]') as HTMLButtonElement).click()
    })
    await act(async () => {})
    expect(document.body.querySelector('[data-phase="moving"]')).not.toBeNull()

    // 翻面:这一组被换成云上的家(不同位置,等于卸载重挂)
    await harness.render(
      createElement(Fragment, null, createElement('div', { id: 'moved' }, createNode(AssistantMoveGroup, groupProps(cloud))), createElement(AssistantMoveDialog))
    )
    await act(async () => {})
    expect(document.body.querySelector('[data-phase="moving"]')).not.toBeNull()
    expect(document.body.querySelector('[data-step="adopt"]')).not.toBeNull()
    // 搬着时别的搬不能再点
    expect((q('assistant-move-to-computer') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => {
      finish({
        files: 1,
        skippedFiles: [],
        accounts: { moved: [], skipped: [], kept: [], unsupported: false },
        schedules: { restored: 0, skipped: [], unsupported: [], unreadable: false },
        warnings: [],
      })
    })
    await act(async () => {})
    expect(document.body.querySelector('[data-phase="done"]')).not.toBeNull()
  })

  it('确认框里的账号说明按旧家说:搬上云说「这台电脑上别的会话…」,搬回本机说「云上别的会话…」(❌ 云上上)', async () => {
    mocks.previewMove.mockResolvedValue({
      bytes: 1,
      files: 1,
      skippedFiles: [],
      accounts: { moving: [{ integrationId: 'notion', accountId: 'default' }], reconnect: [], unsupported: false },
    })
    await render(cloud)
    await act(async () => {
      (q('assistant-move-to-computer') as HTMLButtonElement).click()
    })
    await act(async () => {})
    const text = document.body.textContent ?? ''
    expect(text).toContain('云上别的会话要用它们')
    expect(text).not.toContain('云上上')
  })
})
