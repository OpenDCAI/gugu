// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, deferred } from '../../../support/testHarness'

const bus = vi.hoisted(() => ({ listener: null as null | ((event: unknown) => void), onSubscribed: null as null | (() => void), off: vi.fn() }))
const read = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }))
// read 仍按「失败列表」喂；recovered 由 recover 单独控制。
const recover = vi.hoisted(() => ({ agents: [] as string[] }))
vi.mock('../../../../apps/desktop/src/lib/storedAgentTurnFailures', () => ({ readStoredAgentTurnFailures: async (...args: unknown[]) => ({ failures: await read(...args), recovered: recover.agents }) }))
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({
  subscribePrivateUserEventBus: (_user: string, _event: string, listener: (event: unknown) => void, options: { onSubscribed: () => void }) => { bus.listener = listener; bus.onSubscribed = options.onSubscribed; return {} },
  unsubscribePrivateUserEventBus: bus.off,
}))
import { useStoredAgentTurnFailure } from '../../../../apps/desktop/src/hooks/useStoredAgentTurnFailure'

const failure = (revision = 'one', commandId = 'cmd') => ({ agentUserId: 'agent', commandId, revision, at: 1, rawMessage: 'weekly limit reached' })
function Probe({ chatId = 'chat', thread = null }: { chatId?: string; thread?: string | null }) {
  const state = useStoredAgentTurnFailure(chatId, thread, ['agent'])
  return <div><span data-failure>{state.failure?.commandId}</span><span data-read-failed>{String(state.readFailed)}</span><button onClick={() => state.dismiss('cmd')}>dismiss</button></div>
}
let ui: ReturnType<typeof createReactHarness>
const current = () => ui.container.querySelector('[data-failure]')?.textContent
const emit = (extra = {}) => act(async () => { bus.listener?.({ id: 'cmd', agent_user_id: 'agent', chat_id: 'chat', thread_root_id: null, status: 'error', ...extra }) })
beforeEach(() => { ui = createReactHarness(); read.mockReset().mockResolvedValue([]); bus.off.mockClear(); recover.agents = []; window.localStorage.clear() })
afterEach(() => ui.cleanup())

describe('其他设备的额度通知由命令结果驱动', () => {
  it('模型不可用的关闭同样按命令版本保存，新失败仍可提示', async () => {
    const unavailable = (revision: string) => ({ ...failure(revision), rawMessage: 'Model test is not available' })
    read.mockResolvedValue([unavailable('one')]); await ui.render(createNode(Probe, {}))
    await clickElement(ui.container.querySelector('button')!)
    await emit(); expect(current()).toBe('')
    ui.cleanup(); ui = createReactHarness(); await ui.render(createNode(Probe, {}))
    expect(current()).toBe('')
    read.mockResolvedValue([unavailable('two')]); await emit()
    expect(current()).toBe('cmd')
  })
  it('打开时补读；事件只刷新当前聊天/话题/Agent，重连后再补读', async () => {
    read.mockResolvedValue([failure()])
    await ui.render(createNode(Probe, {}))
    expect(current()).toBe('cmd')
    expect(read).toHaveBeenCalledWith('chat', null, ['agent'])
    await emit({ thread_root_id: 'other' }); await emit({ chat_id: 'other' }); await emit({ agent_user_id: 'other' })
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () => bus.onSubscribed?.())
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('关闭后不因补读重现；同一命令重试的新失败可以重新提醒', async () => {
    read.mockResolvedValue([failure()]); await ui.render(createNode(Probe, {}))
    await clickElement(ui.container.querySelector('button')!); expect(current()).toBe('')
    await emit(); expect(current()).toBe('')
    read.mockResolvedValue([]); await emit({ status: 'pending' })
    read.mockResolvedValue([failure('two')]); await emit(); expect(current()).toBe('cmd')
  })
  it('关掉之后组件重挂（切走再回来、重开 App）不重现；之后一条新命令的失败照旧提醒（owner 10-28 Codex 91）', async () => {
    read.mockResolvedValue([failure()]); await ui.render(createNode(Probe, {}))
    await clickElement(ui.container.querySelector('button')!); expect(current()).toBe('')
    ui.cleanup(); ui = createReactHarness(); await ui.render(createNode(Probe, {}))
    expect(current()).toBe('')
    read.mockResolvedValue([failure('two', 'cmd-2')]); await emit({ id: 'cmd-2' }); expect(current()).toBe('cmd-2')
  })
  it('关掉的记录读坏了：当没关过，失败条照常出现，不崩', async () => {
    window.localStorage.setItem('gugu.agent-turn-failure-dismissed.owner', '"broken"')
    read.mockResolvedValue([failure()]); await ui.render(createNode(Probe, {}))
    expect(current()).toBe('cmd')
  })

  it('迟到的旧读数不能盖掉新事件的结果', async () => {
    const old = deferred<ReturnType<typeof failure>[]>(); read.mockReturnValueOnce(old.promise).mockResolvedValue([failure('two', 'new')])
    await ui.render(createNode(Probe, {})); await emit(); expect(current()).toBe('new')
    await act(async () => old.resolve([failure('one', 'old')])); expect(current()).toBe('new')
  })
  it('切聊天立即清掉前一个主体，旧请求失败也不能把错误挂到新聊天', async () => {
    const old = deferred<ReturnType<typeof failure>[]>(); read.mockReturnValueOnce(old.promise).mockResolvedValue([])
    await ui.render(createNode(Probe, {})); await ui.render(createNode(Probe, { chatId: 'other' }))
    await act(async () => old.reject(new Error('old request')))
    expect(current()).toBe(''); expect(ui.container.querySelector('[data-read-failed]')?.textContent).toBe('false')
    expect(bus.off).toHaveBeenCalled()
  })
  it('读取失败保留已核实通知并显示读取失败，不冒充没有失败', async () => {
    read.mockResolvedValueOnce([failure()]).mockRejectedValue(new Error('offline'))
    await ui.render(createNode(Probe, {})); await emit()
    expect(current()).toBe('cmd'); expect(ui.container.querySelector('[data-read-failed]')?.textContent).toBe('true')
  })

})
