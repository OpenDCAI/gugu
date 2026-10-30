import { describe, expect, it } from 'vitest'
import { removalViolations } from '../../../scripts/check-permanent-removal.mjs'

describe('permanent removal call-site guard', () => {
  it.each(['apps/desktop/shared/action.mts', 'packages/session-core/action.cjs', 'apps/mobile/runtime/action.mjs'])('covers production module %s and indirect RPC operands', file => {
    expect(removalViolations(file, `const op = { rpc: 'remove_owned_agent' }; client.rpc(op.rpc, args)`)).toHaveLength(1)
    expect(removalViolations(file, `const op = 'remove_device'; client.rpc(op, args)`)).toHaveLength(1)
    expect(removalViolations(file, 'db.delete(sessions)')).toHaveLength(1)
    expect(removalViolations(file, 'sql`DELETE FROM sessions WHERE id = ?`')).toHaveLength(1)
    expect(removalViolations(file, 'archiveSession(projectId, sessionId)')).toEqual([])
  })
})
