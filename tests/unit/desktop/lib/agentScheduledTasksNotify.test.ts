// agent_scheduled_tasks carries no event: this machine's device runtime only re-reads it on its safety cadence.
// A write made here tells the runtime at once, so a task created on this machine is planned on time.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => {
  const result = { data: { id: 't', agent_user_id: 'a', owner_user_id: 'o', chat_id: 'c', title: null, prompt: 'p', interval_seconds: 60, enabled: true, next_run_at: null, last_run_at: null, created_at: 'x' } as unknown, error: null as null | { message: string } }
  const chain: Record<string, unknown> = {}
  for (const name of ['insert', 'select', 'update', 'delete', 'eq']) chain[name] = () => chain
  chain.single = async () => result
  chain.maybeSingle = async () => ({ data: { interval_seconds: 60 }, error: null })
  chain.then = (resolve: (value: unknown) => void) => resolve(result)
  return { result, chain, notify: vi.fn() }
})
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: { from: () => h.chain } }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { getOrCreateDM: async () => 'chat-1' } }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { notifyScheduledTasksChanged: h.notify } }))

const { agentScheduledTaskService } = await import('../../../../apps/desktop/src/lib/agentScheduledTasks')

describe('scheduled task writes notify the local device runtime', () => {
  beforeEach(() => { h.notify.mockClear(); h.result.error = null })

  it('create, enable/disable and remove each tell the runtime once', async () => {
    await agentScheduledTaskService.create({ agentUserId: 'a', ownerUserId: 'o', prompt: 'p', intervalSeconds: 60 })
    await agentScheduledTaskService.setEnabled('t', true)
    await agentScheduledTaskService.remove('t')
    expect(h.notify).toHaveBeenCalledTimes(3)
  })

  it('a failed write does not', async () => {
    h.result.error = { message: 'denied' }
    await expect(agentScheduledTaskService.remove('t')).rejects.toThrow('denied')
    expect(h.notify).not.toHaveBeenCalled()
  })
})
