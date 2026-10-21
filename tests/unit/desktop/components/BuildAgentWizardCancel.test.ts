// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BuildAgentWizard, type AgentTeam } from '../../../../apps/desktop/src/components/BuildAgentWizard'
import { createNode, createReactHarness } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/components/Avatar', () => ({ Avatar: () => null }))

const team: AgentTeam = {
  userDescription: 'test team',
  teamName: 'Cancellation Team',
  groupPrompt: 'complete the work',
  members: [
    { tempId: 'lead', role: 'Lead', displayName: 'Lead', description: 'Lead work', avatarUrl: null, avatarSeed: 'lead', engineId: 'codex' },
  ],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

let harness: ReturnType<typeof createReactHarness>
// rendererLogger 拿不到 electron 桥时退化成 console.*,所以「原因进了日志」在这里可判。
let consoleWarn: ReturnType<typeof vi.spyOn>
let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  harness = createReactHarness()
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  harness.cleanup()
  consoleWarn.mockRestore()
  consoleError.mockRestore()
})

describe('#2260 E2b — ordinary close and explicit cancel are separate exits', () => {
  it('reopens a cleaning_up operation as an explicit recovery surface with zero automatic RPCs', async () => {
    const onCreate = vi.fn()
    const onCancel = vi.fn()
    const onClose = vi.fn()
    await harness.render(createNode(BuildAgentWizard, {
      initialTeam: team,
      initialCancellationOperationId: 'op-cleaning-1',
      onCreate,
      onClose,
      onCancel,
    }))

    expect(document.body.querySelector('[data-testid="wizard-cancellation-recovery"]')).not.toBeNull()
    expect(document.body.textContent).toContain('正在完成上次取消')
    expect(onCreate).not.toHaveBeenCalled()
    expect(onCancel, 'opening recovery never retries cancellation by itself').not.toHaveBeenCalled()

    await act(async () => { document.body.querySelector<HTMLButtonElement>('[aria-label="关闭向导"]')!.click() })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onCancel, 'ordinary close remains distinct from explicit cancel').not.toHaveBeenCalled()
  })

  it('continues cancellation only after confirmation and keeps the exact id when cleanup is partial', async () => {
    const onCancel = vi.fn(async () => ({
      fullyCancelled: false,
      completedNoop: false,
      cleanupErrors: ['remove:m1:still running'],
      cleanupStages: ['remove' as const],
    }))
    await harness.render(createNode(BuildAgentWizard, {
      initialTeam: team,
      initialCancellationOperationId: 'op-cleaning-exact',
      onCreate: vi.fn(),
      onClose: vi.fn(),
      onCancel,
    }))

    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-continue-cancel"]')!.click() })
    expect(onCancel, 'the first click is only the destructive confirmation boundary').not.toHaveBeenCalled()
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-cancel-confirm"] button')!.click() })

    expect(onCancel).toHaveBeenCalledWith('op-cleaning-exact')
    expect(document.body.querySelector('[data-testid="wizard-cancellation-recovery"]'), 'partial cleanup remains replayable').not.toBeNull()
    // #4891:残留仍然不许静默消失 —— 但用户看到的是**哪一步**(我们自己的枚举),不是下层抛的原文。
    expect(document.body.textContent, 'the unfinished step is still named').toContain('移除 Agent')
    expect(document.body.textContent, 'the raw reason belongs in the log').not.toContain('still running')
    expect(consoleWarn, 'and the raw reason must actually be in the log').toHaveBeenCalledWith(
      expect.stringContaining('[agents/build-wizard]'),
      expect.objectContaining({ cleanupErrors: expect.stringContaining('still running') }),
    )
  })

  it('a converged recovery returns to preview but never starts a fresh team automatically', async () => {
    const onCreate = vi.fn()
    const onCancel = vi.fn(async () => ({ fullyCancelled: true, completedNoop: false, cleanupErrors: [] }))
    await harness.render(createNode(BuildAgentWizard, {
      initialTeam: team,
      initialCancellationOperationId: 'op-cleaning-done',
      onCreate,
      onClose: vi.fn(),
      onCancel,
    }))

    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-continue-cancel"]')!.click() })
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-cancel-confirm"] button')!.click() })

    expect(document.body.querySelector('[data-testid="wizard-cancellation-recovery"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="wizard-create"]')).not.toBeNull()
    expect(onCreate, 'convergence exposes preview; the user still decides whether to create again').not.toHaveBeenCalled()
  })

  it('a partial cancel leaves the creating spinner and enters the replayable cancellation recovery surface', async () => {
    const pending = deferred<void>()
    const onCancel = vi.fn(async () => ({
      fullyCancelled: false,
      completedNoop: false,
      cleanupErrors: ['remove:m1:still running'],
      cleanupStages: ['remove' as const],
    }))
    const onCreate = vi.fn((_team: AgentTeam, onProgress?: (progress: { ratio: number; label: string; operationId?: string }) => void) => {
      onProgress?.({ ratio: 0.2, label: 'creating members', operationId: 'op-partial' })
      return pending.promise
    })
    await harness.render(createNode(BuildAgentWizard, { initialTeam: team, onCreate, onClose: vi.fn(), onCancel }))

    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-create"]')!.click() })
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-cancel"]')!.click() })
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-cancel-confirm"] button')!.click() })

    expect(document.body.querySelector('[data-testid="wizard-creating-label"]'), 'the create driver was invalidated').toBeNull()
    expect(document.body.querySelector('[data-testid="wizard-cancellation-recovery"]')).not.toBeNull()
    expect(document.body.textContent, 'the unfinished step is still named').toContain('移除 Agent')
    expect(document.body.textContent, 'the raw reason belongs in the log').not.toContain('still running')
    pending.resolve(undefined)
  })

  it('a phase race reported by create switches to exact cancellation recovery instead of a dead-end preview error', async () => {
    const onCancel = vi.fn()
    const onCreate = vi.fn(async () => {
      throw Object.assign(new Error('operation op-raced-cleaning now requires cancellation recovery'), {
        name: 'TeamCancellationRecoveryRequiredError',
        operationId: 'op-raced-cleaning',
      })
    })
    await harness.render(createNode(BuildAgentWizard, { initialTeam: team, onCreate, onClose: vi.fn(), onCancel }))

    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-create"]')!.click() })

    expect(document.body.querySelector('[data-testid="wizard-cancellation-recovery"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="wizard-create"]'), 'the preview cannot tell the user to cancel without a cancel control').toBeNull()
    // 旧写法把 `operation op-raced-cleaning now requires cancellation recovery` 这句英文原样贴给中文用户。
    // #4891:原句与 operation id 一起进日志,用户拿到的是「取消仍在进行」这句能照做的话。
    expect(document.body.textContent, 'the raw English throw does not reach the user').not.toContain('op-raced-cleaning')
    expect(document.body.textContent, 'but the state itself is still surfaced').toContain('取消仍在进行')
    expect(consoleError, 'the id and the raw message must be in the log').toHaveBeenCalledWith(
      expect.stringContaining('[agents/build-wizard]'),
      expect.objectContaining({ operationId: 'op-raced-cleaning' }),
    )
    expect(onCancel, 'the race signal exposes recovery but never auto-cancels').not.toHaveBeenCalled()
  })

  it('does not render a cancel control before the durable operation id is announced', async () => {
    const pending = deferred<void>()
    const onCreate = vi.fn(() => pending.promise)
    await harness.render(createNode(BuildAgentWizard, { initialTeam: team, onCreate, onClose: vi.fn(), onCancel: vi.fn() }))

    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-create"]')!.click() })
    expect(document.body.querySelector('[data-testid="wizard-cancel"]')).toBeNull()
    await act(async () => { pending.resolve(undefined); await pending.promise })
  })

  it('does not render a fake cancel control when the caller did not provide a cancel handler', async () => {
    const pending = deferred<void>()
    const onCreate = vi.fn((_team: AgentTeam, onProgress?: (progress: { ratio: number; label: string; operationId?: string }) => void) => {
      onProgress?.({ ratio: 0.1, label: 'starting', operationId: 'op-without-handler' })
      return pending.promise
    })
    await harness.render(createNode(BuildAgentWizard, { initialTeam: team, onCreate, onClose: vi.fn() }))

    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-create"]')!.click() })
    expect(document.body.querySelector('[data-testid="wizard-cancel"]')).toBeNull()
    await act(async () => { pending.resolve(undefined); await pending.promise })
  })

  it('shows explicit cancel only after an operation id and passes that exact id', async () => {
    const pending = deferred<void>()
    const onCancel = vi.fn(async () => ({ fullyCancelled: true, completedNoop: false, cleanupErrors: [] }))
    const onCreate = vi.fn((_team: AgentTeam, onProgress?: (progress: { ratio: number; label: string; operationId?: string }) => void) => {
      onProgress?.({ ratio: 0.1, label: 'starting', operationId: 'op-exact-1' })
      return pending.promise
    })
    await harness.render(createNode(BuildAgentWizard, { initialTeam: team, onCreate, onClose: vi.fn(), onCancel }))

    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-create"]')!.click() })
    const cancel = document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-cancel"]')
    expect(cancel).not.toBeNull()
    await act(async () => { cancel!.click() })
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-cancel-confirm"] button')!.click() })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledWith('op-exact-1')
    pending.resolve(undefined)
  })

  it('creation has no ordinary close or background-continue exit', async () => {
    const pending = deferred<void>()
    const onClose = vi.fn()
    const onCancel = vi.fn()
    await harness.render(createNode(BuildAgentWizard, {
      initialTeam: team,
      onCreate: () => pending.promise,
      onClose,
      onCancel,
    }))

    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-create"]')!.click() })
    expect(document.body.querySelector('[aria-label="关闭向导"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="wizard-dismiss-creating"]')).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
    await act(async () => { pending.resolve(undefined); await pending.promise })
  })

  it('close then reopen may observe one shared result, but only its single handoff owner navigates once', async () => {
    const pending = deferred<{ chatId: string; agentIds: string[]; operationId: string }>()
    const navigate = vi.fn()
    const onCreated = vi.fn(async (_createdTeam: AgentTeam) => { navigate() })
    let attachment = 0
    const onCreate = vi.fn(() => pending.promise.then((result) => ({
      ...result,
      handoffOwner: attachment++ === 0,
      starterPrompt: '  durable custom\n',
      finishHandoff: vi.fn(),
    })))

    await harness.render(createNode(BuildAgentWizard, {
      initialTeam: { ...team, starterPrompt: '  durable custom\n' },
      onCreate,
      onCreated,
      onClose: vi.fn(),
    }))
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-create"]')!.click() })
    expect(document.body.querySelector('[aria-label="关闭向导"]')).toBeNull()

    // Reopening replaces the old view, but its pending async handler is still alive. Both views observe the same
    // operation result; only the coordinator-designated owner may run the success side effects.
    harness.cleanup()
    harness = createReactHarness()
    await harness.render(createNode(BuildAgentWizard, {
      initialTeam: { ...team, starterPrompt: '  durable custom\n' },
      onCreate,
      onCreated,
      onClose: vi.fn(),
    }))
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-create"]')!.click() })
    await act(async () => {
      pending.resolve({ chatId: 'chat-one', agentIds: ['agent-one'], operationId: 'op-one' })
      await pending.promise
      await Promise.resolve()
    })

    expect(onCreate).toHaveBeenCalledTimes(2) // two UI attachments, not two underlying drives
    expect(onCreated, 'only the attempt handoff owner may land/navigate').toHaveBeenCalledTimes(1)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(onCreated.mock.calls[0][0].starterPrompt).toBe('  durable custom\n')
  })

  it('does not let a late create completion overwrite a completed cancel', async () => {
    const pending = deferred<{ chatId: string; agentIds: string[]; operationId: string }>()
    const onCancel = vi.fn(async () => ({ fullyCancelled: true, completedNoop: false, cleanupErrors: [] }))
    const onCreated = vi.fn()
    const onCreate = vi.fn((_team: AgentTeam, onProgress?: (progress: { ratio: number; label: string; operationId?: string }) => void) => {
      onProgress?.({ ratio: 0.1, label: 'starting', operationId: 'op-late-1' })
      return pending.promise
    })
    await harness.render(createNode(BuildAgentWizard, { initialTeam: team, onCreate, onCreated, onClose: vi.fn(), onCancel }))

    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-create"]')!.click() })
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-cancel"]')!.click() })
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-cancel-confirm"] button')!.click() })
    pending.resolve({ chatId: 'chat-late', agentIds: ['agent-late'], operationId: 'op-late-1' })
    await act(async () => { await Promise.resolve() })
    expect(onCreated).not.toHaveBeenCalled()
    expect(document.body.querySelector('[data-testid="wizard-creating-label"]')).toBeNull()
    expect(document.body.querySelector('[data-testid="wizard-create"]')).not.toBeNull()
  })

  it('a completed-operation cancel no-op preserves the successful onCreated handoff and never says cancelled', async () => {
    const created = deferred<void>()
    const result = { chatId: 'chat-completed', agentIds: ['agent-completed'], operationId: 'op-completed' }
    const onCancel = vi.fn(async () => ({ fullyCancelled: false, completedNoop: true, cleanupErrors: [] }))
    const onCreated = vi.fn(() => created.promise)
    const onCreate = vi.fn((_team: AgentTeam, onProgress?: (progress: { ratio: number; label: string; operationId?: string }) => void) => {
      onProgress?.({ ratio: 1, label: '团队就位', operationId: 'op-completed' })
      return Promise.resolve(result)
    })
    await harness.render(createNode(BuildAgentWizard, { initialTeam: team, onCreate, onCreated, onClose: vi.fn(), onCancel }))

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-create"]')!.click()
      await Promise.resolve()
    })
    expect(onCreated).toHaveBeenCalledWith(team, result)
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-cancel"]')!.click() })
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-cancel-confirm"] button')!.click() })

    expect(onCancel).toHaveBeenCalledWith('op-completed')
    expect(document.body.textContent).not.toContain('创建已取消')
    expect(document.body.textContent).not.toContain('仍在收敛')

    await act(async () => { created.resolve(); await created.promise })
    expect(document.body.textContent).toContain('团队已创建')
    expect(onCreated).toHaveBeenCalledTimes(1)
  })

  it('a converged cancel with cleanup diagnostics stays cancelled but surfaces every warning', async () => {
    const pending = deferred<void>()
    const onCancel = vi.fn(async () => ({
      fullyCancelled: true,
      completedNoop: false,
      cleanupErrors: ['stop:m1:runtime stop timed out', 'remove:m2:governed removal delayed'],
      cleanupStages: ['stop' as const, 'remove' as const],
    }))
    const onCreate = vi.fn((_team: AgentTeam, onProgress?: (progress: { ratio: number; label: string; operationId?: string }) => void) => {
      onProgress?.({ ratio: 0.1, label: 'starting', operationId: 'op-warning' })
      return pending.promise
    })
    await harness.render(createNode(BuildAgentWizard, { initialTeam: team, onCreate, onClose: vi.fn(), onCancel }))

    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-create"]')!.click() })
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-cancel"]')!.click() })
    await act(async () => { document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-cancel-confirm"] button')!.click() })

    const error = document.body.querySelector('[data-testid="wizard-error"]')?.textContent ?? ''
    expect(error).toContain('创建已取消')
    // 「每一条告警都要浮出来」这条立场保留 —— 浮出来的是**两步都点名**,不是两句英文原文。
    expect(error, 'every unfinished step is named').toContain('停止运行时')
    expect(error, 'every unfinished step is named').toContain('移除 Agent')
    expect(error, 'the raw reasons belong in the log').not.toContain('runtime stop timed out')
    expect(error, 'the raw reasons belong in the log').not.toContain('governed removal delayed')
    expect(consoleWarn, 'and both raw reasons must actually be in the log').toHaveBeenCalledWith(
      expect.stringContaining('[agents/build-wizard]'),
      expect.objectContaining({ cleanupErrors: expect.stringContaining('runtime stop timed out') }),
    )
    pending.resolve(undefined)
  })
})
