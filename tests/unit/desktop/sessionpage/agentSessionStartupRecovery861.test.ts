import { beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ binding: vi.fn(), stop: vi.fn(), discard: vi.fn() }))
vi.mock('../../../../apps/desktop/electron/session/main/core/sessionpage/sessionpage-session-agent', () => ({ localAgentForSession: io.binding }))
vi.mock('../../../../apps/desktop/electron/session/main/core/sessions/session-orchestration', () => ({ stopExactSessionpageSession: io.stop }))
vi.mock('../../../../apps/desktop/electron/session/main/core/sessions/archiveSession', () => ({ archiveSession: io.discard }))
import { rollbackAgentSessionStartup } from '../../../../apps/desktop/electron/session/main/core/sessions/agent-session-startup'

const attempt = { projectId: 'project', sessionId: 'task', created: true, started: true }
beforeEach(() => {
  vi.resetAllMocks()
  io.binding.mockResolvedValue(null)
  io.stop.mockResolvedValue(true)
  io.discard.mockResolvedValue(undefined)
})

describe('agent startup rollback ownership (#861)', () => {
  it('discards only this attempt’s new task when provisioning never bound an identity', async () => {
    await rollbackAgentSessionStartup(attempt)
    expect(io.stop).toHaveBeenCalledWith(attempt)
    expect(io.discard).toHaveBeenCalledWith('project', 'task', { skipTransportStop: true })
  })

  it('preserves the durable task if provisioning bound an identity before startup failed', async () => {
    io.binding.mockResolvedValue({ gugu_user_id: 'assistant' })
    await rollbackAgentSessionStartup(attempt)
    expect(io.binding).toHaveBeenCalledWith('task', process.env)
    expect(io.stop).toHaveBeenCalledOnce()
    expect(io.discard).not.toHaveBeenCalled()
  })

  it('never discards a reused task or stops a runtime this attempt did not start', async () => {
    await rollbackAgentSessionStartup({ ...attempt, created: false, started: false })
    expect(io.stop).not.toHaveBeenCalled()
    expect(io.binding).not.toHaveBeenCalled()
    expect(io.discard).not.toHaveBeenCalled()
  })

  it('keeps repeated cleanup scoped to the same task without reclaiming its identity', async () => {
    io.binding.mockResolvedValue({ gugu_user_id: 'assistant' })
    await rollbackAgentSessionStartup(attempt)
    await rollbackAgentSessionStartup(attempt)
    expect(io.stop).toHaveBeenCalledTimes(2)
    expect(io.discard).not.toHaveBeenCalled()
  })

  it('keeps the binding even if the runtime stop fails, and refuses deletion on an unreadable roster', async () => {
    io.stop.mockRejectedValue(new Error('already stopped'))
    io.binding.mockResolvedValueOnce({ gugu_user_id: 'assistant' }).mockRejectedValueOnce(new Error('roster unreadable'))
    await rollbackAgentSessionStartup(attempt)
    await expect(rollbackAgentSessionStartup(attempt)).rejects.toThrow('roster unreadable')
    expect(io.discard).not.toHaveBeenCalled()
  })
})
