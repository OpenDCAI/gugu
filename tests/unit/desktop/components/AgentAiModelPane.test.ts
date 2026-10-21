// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import {
  clickElement,
  createNode,
  createReactHarness,
  selectValue,
  waitForCondition,
} from '../../../support/testHarness'

// #5276 面板不再经 Electron IPC:目录问服务端、当前值读云端、写走 RPC + 设备命令。
// 桌面与手机同一条路,所以这里 mock 的是那条云端 lib,不是 window.electronAPI。
const fetchAgentHarnessModels = vi.fn()
const location = vi.hoisted(() => ({ cloud: false }))
vi.mock('../../../../apps/desktop/src/lib/myAssistant', () => ({ useMyAssistant: () => ({ agentId: location.cloud ? 'agent-model-test' : null, loading: false }) }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [{ device_id: 'device-1', is_current_device: !location.cloud }], cloudComputer: location.cloud ? { snapshot: { deviceId: 'device-1' } } : undefined }) }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { capabilities: { agentRuntime: true } } }))
// 本文件只测配置读写和计费来源，菜单本体复用已有ComposerModelMenu。
vi.mock('../../../../apps/desktop/src/components/agentsettings/AgentModelPicker', () => ({
  AgentModelPicker: ({ items, value, disabled, onChange }: { items: { id: string; name: string }[]; value: string; disabled: boolean; onChange: (value: string) => void }) => createNode('select', { value, disabled, onChange: (event: { target: { value: string } }) => onChange(event.target.value) }, ...items.map((item) => createNode('option', { key: item.id, value: item.id }, item.name))),
}))
const fetchPlatformModelCatalog = vi.fn()
const readAgentModelSelection = vi.fn()
const setAgentModelSelection = vi.fn()
vi.mock('../../../../apps/desktop/src/lib/agentModelSelection', async () => {
  const actual = await vi.importActual<typeof import('../../../../apps/desktop/src/lib/agentModelSelection')>(
    '../../../../apps/desktop/src/lib/agentModelSelection',
  )
  return {
    ...actual,
    fetchPlatformModelCatalog: (...args: unknown[]) => fetchPlatformModelCatalog(...args),
    fetchAgentHarnessModels: (...args: unknown[]) => fetchAgentHarnessModels(...args),
    readAgentModelSelection: (...args: unknown[]) => readAgentModelSelection(...args),
    setAgentModelSelection: (...args: unknown[]) => setAgentModelSelection(...args),
  }
})

// #6247 结局文案那几格要走**真的**结果解析(设备 result → outcome),所以这两个云端出口在这里 stub:
// 设备回什么 result,由各用例自己给。
const deviceRpc = vi.fn()
const waitForDeviceCommand = vi.fn()
vi.mock('../../../../apps/desktop/src/lib/supabase', async () => {
  const actual = await vi.importActual<typeof import('../../../../apps/desktop/src/lib/supabase')>(
    '../../../../apps/desktop/src/lib/supabase',
  )
  // `from('users')` 是 #6264 递交前查 agent 在哪台机器(经 identityReadAdapter):这里答「不知道」⇒ 不走 SSH 递交,照常等设备回话。
  const noDevice = { select: () => ({ in: () => ({ abortSignal: async () => ({ data: [], error: null }) }) }) }
  return { ...actual, identityDb: { rpc: (...args: unknown[]) => deviceRpc(...args), from: () => noDevice } }
})
vi.mock('../../../../apps/desktop/src/lib/chat', async () => {
  const actual = await vi.importActual<typeof import('../../../../apps/desktop/src/lib/chat')>(
    '../../../../apps/desktop/src/lib/chat',
  )
  return {
    ...actual,
    chatService: { ...actual.chatService, waitForDeviceCommand: (...args: unknown[]) => waitForDeviceCommand(...args) },
  }
})

import { AgentAiModelPane } from '../../../../apps/desktop/src/components/agentsettings/AgentAiModelPane'

let harness: ReturnType<typeof createReactHarness>

const agent = {
  id: 'agent-model-test',
  display_name: 'Model Test',
  avatar: null,
  bio: null,
  type: 'agent',
  agent_type: 'claude-code',
  device_id: 'device-1',
} satisfies ContactUser

const catalog = [{
  id: 'glm-5.2',
  displayName: 'GLM 5.2',
  protocols: ['anthropic-messages'],
  enabled: true,
}]

beforeEach(() => {
  location.cloud = false
  harness = createReactHarness()
  fetchPlatformModelCatalog.mockReset().mockResolvedValue(catalog)
  fetchAgentHarnessModels.mockReset().mockResolvedValue({ harness: 'claude', harnessState: 'ready', models: [], selected: null, efforts: [], selectedEffort: null, guguReason: null, harnessReason: null })
  readAgentModelSelection.mockReset().mockResolvedValue({
    desired: { source: 'default' }, applied: null, appliedAt: null, applyError: null,
  })
  setAgentModelSelection.mockReset().mockResolvedValue({ ok: true, applied: 'hot', warning: null })
})

afterEach(() => {
  harness.cleanup()
})

describe('AgentAiModelPane', () => {
  it('offers only Gugu-credit models for the cloud assistant, without probing a Claude subscription', async () => {
    location.cloud = true
    const selection = { source: 'platform', protocol: 'anthropic-messages', modelId: 'glm-5.2' }
    readAgentModelSelection.mockResolvedValue({ desired: selection, applied: selection, applyError: null, appliedAt: null })
    await harness.render(createNode(AgentAiModelPane, { agent }))
    await waitForCondition(() => harness.container.querySelectorAll('option').length === 1, 'cloud platform model')
    expect([...harness.container.querySelectorAll('option')].map(option => option.getAttribute('value'))).toEqual(['platform:glm-5.2'])
    expect(fetchAgentHarnessModels).not.toHaveBeenCalled()
    expect(setAgentModelSelection).not.toHaveBeenCalled()
  })
  it('does not write on load, applies a choice immediately, and offers retry only after failure', async () => {
    setAgentModelSelection.mockRejectedValueOnce(new Error('Switch failed'))
    await harness.render(createNode(AgentAiModelPane, { agent }))
    await waitForCondition(() => harness.container.querySelectorAll('option').length === 2, 'options')
    expect(setAgentModelSelection).not.toHaveBeenCalled()
    expect(harness.container.querySelector('button')).toBeNull()
    await selectValue(harness.container.querySelector('select')!, 'platform:glm-5.2')
    await waitForCondition(() => harness.container.textContent?.includes('Switch failed') === true, 'failure')
    const retry = [...harness.container.querySelectorAll('button')].find((button) => button.textContent === '重试切换')!
    await clickElement(retry)
    await waitForCondition(() => setAgentModelSelection.mock.calls.length === 2, 'retry')
    expect(setAgentModelSelection.mock.calls[1]).toEqual(setAgentModelSelection.mock.calls[0])
    await waitForCondition(() => harness.container.textContent?.includes('当前会话已当场切换') === true, 'applied')
    expect(harness.container.querySelector('button')).toBeNull()
  })

  it('ignores a late apply outcome after moving to another agent', async () => {
    let finish!: (value: unknown) => void
    setAgentModelSelection.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await harness.render(createNode(AgentAiModelPane, { agent }))
    await waitForCondition(() => harness.container.querySelectorAll('option').length === 2, 'options')
    await selectValue(harness.container.querySelector('select')!, 'platform:glm-5.2')
    await harness.render(createNode(AgentAiModelPane, { agent: { ...agent, id: 'agent-b' } }))
    await waitForCondition(() => !(harness.container.querySelector('select') as HTMLSelectElement).disabled, 'agent b')
    finish({ ok: false, error: 'agent-a-only-error' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.container.textContent).not.toContain('agent-a-only-error')
    expect((harness.container.querySelector('select') as HTMLSelectElement).value).toBe('__assistant_original_config__')
  })
  it('offers the agent’s own model plus Gugu’s, and sends the platform route to the device', async () => {
    await harness.render(createNode(AgentAiModelPane, { agent }))
    await waitForCondition(
      () => harness.container.querySelectorAll('option').length === 2,
      'model options did not load',
    )

    const labels = [...harness.container.querySelectorAll('option')].map((option) => option.textContent)
    // 只两项:沿用 Agent 自己的配置,或用咕咕提供的模型。用户按 Agent 用,自己那套早配好了,
    // 再让他从平台目录里挑一个「同名但用自己 key」的变体只会让人分不清会不会扣积分。
    expect(labels).toEqual(['沿用原有配置', 'GLM 5.2'])

    const select = harness.container.querySelector('select') as HTMLSelectElement
    await selectValue(select, 'platform:glm-5.2')
    expect(harness.container.textContent).not.toContain('保存')

    await waitForCondition(() => setAgentModelSelection.mock.calls.length === 1, 'selection was not sent')
    expect(setAgentModelSelection).toHaveBeenCalledWith('agent-model-test', {
      source: 'platform',
      protocol: 'anthropic-messages',
      modelId: 'glm-5.2',
    })
    // 设备说当场切了 ⇒ 面板说「已生效」,而且是热切那句;❌ 不是一句泛泛的「已保存」。
    await waitForCondition(
      () => harness.container.textContent?.includes('当前会话已当场切换') === true,
      'hot-switch outcome did not render',
    )
  })

  it('reads subscription models from the agent device and keeps the same harness when choosing one', async () => {
    fetchAgentHarnessModels.mockResolvedValue({ harness: 'claude', harnessState: 'ready', selected: 'sonnet', models: [{ id: 'sonnet', name: 'Sonnet (subscription)', source: 'harness' }], efforts: [] })
    await harness.render(createNode(AgentAiModelPane, { agent }))
    await waitForCondition(() => harness.container.querySelectorAll('option').length === 3, 'device subscription options did not load')
    expect(fetchAgentHarnessModels).toHaveBeenCalledWith('device-1', 'claude', true)
    await selectValue(harness.container.querySelector('select')!, 'sonnet')
    expect(setAgentModelSelection).toHaveBeenCalledWith('agent-model-test', { source: 'byok', modelId: 'sonnet' })
  })

  describe('reopen outcome copy follows what the device says happened to the native session (#6247)', () => {
    const reopenWith = async (deviceResult: Record<string, unknown>) => {
      const actual = await vi.importActual<typeof import('../../../../apps/desktop/src/lib/agentModelSelection')>(
        '../../../../apps/desktop/src/lib/agentModelSelection',
      )
      deviceRpc.mockReset().mockResolvedValue({ data: 'cmd-1', error: null })
      waitForDeviceCommand.mockReset().mockResolvedValue({ result: deviceResult })
      setAgentModelSelection.mockImplementation(actual.setAgentModelSelection)
      await harness.render(createNode(AgentAiModelPane, { agent }))
      await waitForCondition(() => harness.container.querySelectorAll('option').length === 2, 'options')
      await selectValue(harness.container.querySelector('select') as HTMLSelectElement, 'platform:glm-5.2')
        // 只读结局那一格(role=status):下面那句常驻说明里本来就提到「新会话」,读整页会把它当成结局。
      const status = () => harness.container.querySelector('[role="status"]')?.textContent ?? ''
      await waitForCondition(() => status().includes('已生效'), 'reload outcome did not render')
      return status()
    }

    it('preserved ⇒ says the history was restored', async () => {
      const text = await reopenWith({ applied: 'reload', nativeSession: 'preserved' })
      expect(text).toContain('会话已重开并续上历史')
    })

    it('replaced ⇒ says a new agent session started and Gugu’s history is kept, not “history restored”', async () => {
      const text = await reopenWith({ applied: 'reload', nativeSession: 'replaced' })
      expect(text).toContain('Agent 另起了一条自己的新会话')
      expect(text).not.toContain('续上历史')
    })

    it('an older device that omits nativeSession ⇒ neutral copy, claims neither', async () => {
      const text = await reopenWith({ applied: 'reload' })
      expect(text).toContain('已生效：会话已重开。')
      expect(text).not.toContain('续上历史')
      expect(text).not.toContain('新会话')
    })
  })

  it('shows the device’s refusal verbatim instead of a generic failure', async () => {
    setAgentModelSelection.mockResolvedValue({ ok: false, error: '这个平台模型尚未对当前 Agent 开放（glm-5.2 / anthropic-messages）' })
    await harness.render(createNode(AgentAiModelPane, { agent }))
    await waitForCondition(() => harness.container.querySelectorAll('option').length === 2, 'options')

    await selectValue(harness.container.querySelector('select') as HTMLSelectElement, 'platform:glm-5.2')

    await waitForCondition(
      () => harness.container.textContent?.includes('尚未对当前 Agent 开放') === true,
      'device refusal did not render',
    )
  })

  it('says the selection is waiting on the device when desired has not been applied yet', async () => {
    // desired 已在云里、applied 还是上一份 ⇒ 设备离线。❌ 不把「写进云里了」说成「已生效」。
    readAgentModelSelection.mockResolvedValue({
      desired: { source: 'platform', protocol: 'anthropic-messages', modelId: 'glm-5.2' },
      applied: { source: 'default' },
      appliedAt: '2026-09-08T00:00:00Z',
      applyError: null,
    })
    await harness.render(createNode(AgentAiModelPane, { agent }))
    await waitForCondition(
      () => harness.container.textContent?.includes('等运行这个 Agent 的设备上线后生效') === true,
      'pending explanation did not render',
    )
    expect((harness.container.querySelector('select') as HTMLSelectElement).value)
      .toBe('platform:glm-5.2')
  })

  it('说明里不写死额度窗口的数字(窗口长度是运营可改的配置)', async () => {
    readAgentModelSelection.mockResolvedValue({
      desired: { source: 'platform', protocol: 'anthropic-messages', modelId: 'glm-5.2' },
      applied: { source: 'platform', protocol: 'anthropic-messages', modelId: 'glm-5.2' },
      appliedAt: '2026-09-08T00:00:00Z',
      applyError: null,
    })
    await harness.render(createNode(AgentAiModelPane, { agent }))
    await waitForCondition(
      () => harness.container.textContent?.includes('按积分计费') === true,
      'platform explanation did not render',
    )
    const status = harness.container.querySelector('[role="status"]') as HTMLElement
    expect(status.textContent).not.toMatch(/\d+\s*小时/)
    expect(status.textContent).not.toMatch(/\d+\s*天/)
  })

  it('keeps an agent without a bound device read-only and says why', async () => {
    await harness.render(createNode(AgentAiModelPane, { agent: { ...agent, device_id: null } }))
    await waitForCondition(
      () => harness.container.textContent?.includes('没有绑定运行设备') === true,
      'no-device explanation did not render',
    )
    expect((harness.container.querySelector('select') as HTMLSelectElement).disabled).toBe(true)
    expect([...harness.container.querySelectorAll('button')].some((button) => button.textContent === '保存')).toBe(false)
  })

  it('says a plain sentence when the catalog fails, never the server text (#6264)', async () => {
    fetchPlatformModelCatalog.mockReset().mockRejectedValue(new Error('model access server is not configured'))
    await harness.render(createNode(AgentAiModelPane, { agent }))
    await waitForCondition(
      () => harness.container.textContent?.includes('咕咕模型暂不可用') === true,
      'catalog failure explanation did not render',
    )
    expect(harness.container.textContent).not.toContain('model access server')
  })

  // #6212 copilot runs on Gugu's models (its injection contract is wired, protocol openai-responses); the pane
  // used to read it as "cannot use models provided by Gugu" because a second type → engine list stopped at six types.
  it('offers Gugu models to a copilot agent on its own protocol', async () => {
    fetchPlatformModelCatalog.mockResolvedValue([
      { id: 'glm-5.3', displayName: 'GLM-5.3', protocols: ['openai-responses'], enabled: true },
    ])
    await harness.render(createNode(AgentAiModelPane, { agent: { ...agent, agent_type: 'copilot' } }))
    await waitForCondition(() => harness.container.querySelectorAll('option').length === 2, 'copilot options did not load')
    expect([...harness.container.querySelectorAll('option')].map((o) => o.getAttribute('value')))
      .toContain('platform:glm-5.3')
    expect(harness.container.textContent).not.toContain('不支持咕咕提供的模型')
  })

  // #7056 与模型下拉同一个判据:要会员的、他在设置「模型」页关掉的都不列。
  it('leaves members-only and hidden models out of the list', async () => {
    fetchPlatformModelCatalog.mockResolvedValue([
      { id: 'glm-5.3-flash', displayName: 'GLM 5.3 Flash', protocols: ['anthropic-messages'], enabled: true, requiresMembership: false, hidden: false },
      { id: 'glm-5.3', displayName: 'GLM 5.3', protocols: ['anthropic-messages'], enabled: true, requiresMembership: true, hidden: false },
      { id: 'grok-4.5', displayName: 'Grok 4.5', protocols: ['anthropic-messages'], enabled: true, requiresMembership: false, hidden: true },
    ])
    await harness.render(createNode(AgentAiModelPane, { agent }))
    await waitForCondition(() => harness.container.querySelectorAll('option').length === 2, 'model options did not load')

    expect([...harness.container.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      '沿用原有配置',
      'GLM 5.3 Flash',
    ])
    expect(harness.container.querySelector('[data-testid="agent-model-members-only"]')).toBeNull()
  })

  // 会员到期:存着的那个会员模型照列(下拉显示的就是它),下面一行说清楚、给去网页续费的路。
  it('keeps a saved model that now needs a membership, and says how to renew', async () => {
    readAgentModelSelection.mockResolvedValue({
      desired: { source: 'platform', protocol: 'anthropic-messages', modelId: 'glm-5.3' },
      applied: null, appliedAt: null, applyError: null,
    })
    fetchPlatformModelCatalog.mockResolvedValue([
      { id: 'glm-5.3-flash', displayName: 'GLM 5.3 Flash', protocols: ['anthropic-messages'], enabled: true, requiresMembership: false, hidden: false },
      { id: 'glm-5.3', displayName: 'GLM 5.3', protocols: ['anthropic-messages'], enabled: true, requiresMembership: true, hidden: false },
    ])
    await harness.render(createNode(AgentAiModelPane, { agent }))
    await waitForCondition(() => harness.container.querySelectorAll('option').length === 3, 'model options did not load')

    expect((harness.container.querySelector('select') as HTMLSelectElement).value).toBe('platform:glm-5.3')
    const note = harness.container.querySelector('[data-testid="agent-model-members-only"]')
    expect(note?.textContent).toContain('GLM 5.3 要开会员才能用')
    expect(note?.querySelector('a')?.getAttribute('href')).toBe('https://gugu.nextmind.space/dashboard/')
  })

  it('says nothing about membership when every model is usable', async () => {
    await harness.render(createNode(AgentAiModelPane, { agent }))
    await waitForCondition(() => harness.container.querySelectorAll('option').length === 2, 'model options did not load')
    expect(harness.container.querySelector('[data-testid="agent-model-members-only"]')).toBeNull()
  })

  it('does not ask for the catalog when the engine cannot speak a platform protocol', async () => {
    await harness.render(createNode(AgentAiModelPane, { agent: { ...agent, agent_type: 'gugu-cloud' } }))
    await waitForCondition(
      () => harness.container.textContent?.includes('不支持咕咕提供的模型') === true,
      'no-platform explanation did not render',
    )
    expect(fetchPlatformModelCatalog).not.toHaveBeenCalled()
    expect(harness.container.querySelectorAll('option').length).toBe(1)
  })
})
