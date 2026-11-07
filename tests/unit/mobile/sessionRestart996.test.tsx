// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LifeView } from '../../../apps/desktop/src/session/shared/core/sessions/session-life'
import { createReactHarness } from '../../support/testHarness'
import { translateSessionMessage } from '../../../apps/desktop/src/session/renderer/localization/locale-store'
import { useSessionRestart } from '../../../apps/desktop/src/mobile/agent-watch/useSessionRestart'
import { SessionLoadFailure } from '../../../apps/desktop/src/mobile/agent-watch/SessionLoadFailure'

const host = vi.hoisted(() => ({ read: vi.fn(), life: vi.fn(), restart: vi.fn(), retry: vi.fn(), ready: vi.fn() }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  machineRpc: () => ({ sessions: { getUnarchivedSession: host.read, lifeView: host.life, restartSession: host.restart, lifeStart: host.retry } }),
}))
const view = (kind: LifeView['kind'], message?: string, version = kind === 'dormant' ? 0 : kind === 'starting' ? 1 : kind === 'failed' ? 2 : 3): LifeView => ({
  sessionId: 's', version, kind, stage: null, hold: kind === 'failed' ? 'start-failed' : null,
  pending: { count: kind === 'starting' ? 1 : 0, items: kind === 'starting' ? [{ seq: 1, messageId: 's:restart:0', text: 'Original first message', preview: 'Original first message', kind: 'ordinary', state: 'queued', failure: null, sentAt: 1000 }] : [] },
  failure: kind === 'failed' ? { at: 'channel', message: message!, cause: { name: 'Error', message: message! } } : null,
  lastExit: null, nativeSession: null,
})
let harness: ReturnType<typeof createReactHarness>
let recovery: ReturnType<typeof useSessionRestart>
function Fixture({ code = 'record_not_found', id = 's' }: { code?: string; id?: string }) {
  recovery = useSessionRestart({ deviceId: 'host', projectId: 'p', sessionId: id, missing: code === 'record_not_found', online: true, local: false, onReady: host.ready })
  return <SessionLoadFailure title="Could not open the timeline" detail={recovery.error ?? 'Missing record'} reloadLabel="Load again"
    onReload={() => { if (recovery.retry) void recovery.retry() }} recovery={recovery} />
}
const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const freshButton = () => [...harness.container.querySelectorAll('button')].find(b => b.textContent === translateSessionMessage('transcript.condition.startFresh'))
beforeEach(() => {
  vi.useFakeTimers()
  host.read.mockReset().mockResolvedValue([{ firstUtterance: 'Original first message', providerSessionState: 'missing' }])
  host.life.mockReset().mockResolvedValue(view('dormant'))
  host.restart.mockReset().mockResolvedValue(undefined)
  host.retry.mockReset().mockResolvedValue(undefined)
  host.ready.mockReset().mockResolvedValue(undefined)
  harness = createReactHarness()
})
afterEach(() => { harness.cleanup(); vi.useRealTimers() })

describe('phone missing-session recovery (#996)', () => {
  it('retries a lifecycle observation failure without repeating the user startup action', async () => {
    await harness.render(<Fixture />); await tick()
    host.life.mockRejectedValueOnce(new Error('Observation timed out')).mockResolvedValue(view('ready'))
    await act(async () => { freshButton()!.click() }); await tick()
    expect(recovery.error).toBeNull()
    expect(host.ready).not.toHaveBeenCalled()
    await tick(600)
    expect(recovery.error).toBeNull()
    expect(host.ready).toHaveBeenCalledOnce()
    expect(host.restart).toHaveBeenCalledExactlyOnceWith('p', 's')
    expect(host.retry).not.toHaveBeenCalled()
  })
  it('offers the desktop action for a missing record with a recorded first utterance', async () => {
    await harness.render(<Fixture />); await tick()
    expect(freshButton()).toBeDefined()
    expect(harness.container.querySelectorAll('button')).toHaveLength(2)
    expect(host.read).toHaveBeenCalledWith('p', 's')
    expect(host.restart).not.toHaveBeenCalled()
  })
  it.each(['unreachable', 'record_unreadable', 'timeline_failed'])('does not offer Start fresh for an ordinary %s read failure', async code => {
    await harness.render(<Fixture code={code} />); await tick()
    expect(freshButton()).toBeUndefined()
    expect(host.read).not.toHaveBeenCalled()
    expect(host.restart).not.toHaveBeenCalled()
  })
  it('does not offer an impossible replay for a legacy session without a first utterance', async () => {
    host.read.mockResolvedValue([{}])
    await harness.render(<Fixture />); await tick()
    expect(freshButton()).toBeUndefined()
  })
  it('does not replace a session whose engine is already starting or ready', async () => {
    host.life.mockResolvedValue(view('starting'))
    await harness.render(<Fixture />); await tick()
    expect(freshButton()).toBeUndefined()
    host.life.mockResolvedValue(view('ready'))
    await harness.render(<Fixture id="other" />); await tick()
    expect(freshButton()).toBeUndefined()
  })
  it('uses the existing restart RPC once, and draws Starting only after the host reports it', async () => {
    await harness.render(<Fixture />); await tick()
    let finish!: () => void
    host.restart.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    await act(async () => { freshButton()!.click(); freshButton()!.click() })
    expect(host.restart).toHaveBeenCalledExactlyOnceWith('p', 's')
    expect(freshButton()!.disabled).toBe(true)
    expect(recovery.pendingPrompt).toBeNull()
    host.life.mockResolvedValue(view('starting'))
    await tick(500)
    expect(recovery.pendingPrompt?.starting, 'host progress is visible even while the restart acknowledgement is delayed').toBe('starting')
    await act(async () => { finish() }); await tick()
    expect(recovery.pendingPrompt).toEqual({ id: 's:restart:0', text: 'Original first message', starting: 'starting', held: true, sentAt: 1000 })
    await tick(8000)
    expect(recovery.pendingPrompt?.starting).toBe('starting')
    expect(recovery.error).toBeNull()
    host.life.mockResolvedValue(view('ready'))
    await tick(500)
    expect(recovery.pendingPrompt).toBeNull()
    expect(recovery.busy).toBe(false)
    expect(host.ready).toHaveBeenCalledOnce()
  })
  it.each(['ready', 'failed'] as const)('keeps observing host progress after a lost restart acknowledgement until %s', async terminal => {
    await harness.render(<Fixture />); await tick()
    let reject!: (cause: Error) => void
    host.restart.mockImplementation(() => new Promise<void>((_, fail) => { reject = fail }))
    await act(async () => { freshButton()!.click() }); await tick()
    host.life.mockResolvedValue(view('starting'))
    await tick(500)
    expect(recovery.pendingPrompt?.starting).toBe('starting')
    await act(async () => { reject(new Error('Connection lost before acknowledgement')) }); await tick()
    expect(recovery.pendingPrompt?.starting).toBe('starting')
    expect(recovery.busy).toBe(true)
    expect(recovery.error).toBeNull()
    host.life.mockResolvedValue(view(terminal, terminal === 'failed' ? 'Agent process exited' : undefined))
    await tick(500)
    expect(recovery.pendingPrompt).toBeNull()
    expect(recovery.busy).toBe(false)
    expect(recovery.error).toBe(terminal === 'failed' ? 'Agent process exited' : null)
    expect(host.ready).toHaveBeenCalledTimes(terminal === 'ready' ? 1 : 0)
    expect(host.restart).toHaveBeenCalledExactlyOnceWith('p', 's')
  })
  it('shows a real bootstrap failure and retries that attempt without replacing the engine again', async () => {
    await harness.render(<Fixture />); await tick()
    host.life.mockResolvedValue(view('starting'))
    await act(async () => { freshButton()!.click() }); await tick()
    host.life.mockResolvedValue(view('failed', 'Agent process exited'))
    await tick(500)
    expect(recovery.pendingPrompt).toBeNull()
    expect(harness.container.textContent).toContain('Agent process exited')
    expect(recovery.busy).toBe(false)
    expect(freshButton()).toBeUndefined()
    host.life.mockResolvedValue(view('starting', undefined, 3))
    await act(async () => { harness.container.querySelector<HTMLButtonElement>('button')!.click() }); await tick()
    expect(host.retry).toHaveBeenCalledExactlyOnceWith('s')
    expect(host.restart).toHaveBeenCalledOnce()
  })
  it('clears a failed attempt when another surface successfully retries it', async () => {
    await harness.render(<Fixture />); await tick()
    host.life.mockResolvedValue(view('failed', 'Agent process exited'))
    await act(async () => { freshButton()!.click() }); await tick()
    expect(recovery.error).toBe('Agent process exited')
    host.life.mockResolvedValue(view('ready'))
    await tick(500)
    expect(recovery.error).toBeNull()
    expect(host.ready).toHaveBeenCalledOnce()
  })
  it('keeps the existing failure visible when the restart RPC is refused', async () => {
    await harness.render(<Fixture />); await tick()
    host.restart.mockRejectedValue(new Error('Restart refused'))
    await act(async () => { freshButton()!.click() }); await tick()
    expect(recovery.error).toBe('Restart refused')
    expect(recovery.pendingPrompt).toBeNull()
    expect(recovery.busy).toBe(false)
    expect(freshButton()!.disabled).toBe(false)
  })
  it('ignores a late eligibility read for the previous task', async () => {
    let finish!: (rows: unknown[]) => void
    host.read.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
    await harness.render(<Fixture />)
    await harness.render(<Fixture id="other" code="record_unreadable" />)
    await act(async () => { finish([{ firstUtterance: 'old task' }]) })
    expect(freshButton()).toBeUndefined()
  })
})
