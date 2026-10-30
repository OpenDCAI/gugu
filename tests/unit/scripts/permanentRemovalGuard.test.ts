import { describe, expect, it } from 'vitest'
import { removalViolations } from '../../../scripts/check-permanent-removal.mjs'

describe('permanent removal call-site guard', () => {
  it.each(['apps/desktop/shared/action.mts', 'packages/session-core/action.cjs', 'apps/mobile/runtime/action.mjs'])('covers production module %s and indirect RPC operands', file => {
    expect(removalViolations(file, `const op = { rpc: 'remove_owned_agent' }; client.rpc(op.rpc, args)`)).toHaveLength(1)
    expect(removalViolations(file, `const op = 'remove_device'; client.rpc(op, args)`)).toHaveLength(1)
    expect(removalViolations(file, 'db.delete(sessions)')).toHaveLength(1)
    expect(removalViolations(file, 'sql`DELETE FROM sessions WHERE id = ?`')).toHaveLength(1)
    expect(removalViolations(file, 'async function clean() { removeAgents(match); permanentlyRemove(target) }')).toHaveLength(2)
    expect(removalViolations(file, `import { removeAgents as erase } from '@gugu/core'; async function clean() { erase(match) }`)).toHaveLength(1)
    expect(removalViolations(file, 'archiveSession(projectId, sessionId)')).toEqual([])
  })
  it('allows the existing explicit cancellation and non-identity GC callers, not automatic cleanup in the same file', () => {
    expect(removalViolations('apps/desktop/src/lib/agentProvision.ts', 'async function defaultRemoveOwnedAgent(id) { permanentlyRemove({agentId:id}) }')).toEqual([])
    const file = 'packages/core/src/local/agent/deviceCommandRuntime.ts'
    expect(removalViolations(file, 'async function pruneDeadGuestRecords() { removeAgents(match) }')).toEqual([])
    expect(removalViolations(file, 'async function syncAgentRuntimeSessions() { removeAgents(match) }')).toHaveLength(1)
    expect(removalViolations('apps/desktop/electron/sessionpage/emdash-agent-provisioning.ts', 'function startCloudProvision() { removeAgents(match) }')).toEqual([])
  })
})
