// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { canTakeOwnedAgentResource, clearOwnedAgentResources, hostOwnedAgentResources, ownedAgentResourceHost, suspendOwnedAgentResources } from '../../../../apps/desktop/src/lib/ownedAgentResources'
afterEach(() => { clearOwnedAgentResources('owner'); clearOwnedAgentResources('other') })
it('holds a second resource request until native navigation finishes, even when its host already exists', () => {
  const target = { projectId: 'project', sessionId: 'native-session' }
  hostOwnedAgentResources('owner', 'dm', target)
  expect(canTakeOwnedAgentResource('owner', 'dm')).toBe(true)
  suspendOwnedAgentResources('owner', 'dm')
  expect(canTakeOwnedAgentResource('owner', 'dm')).toBe(false)
  hostOwnedAgentResources('owner', 'dm', target)
  expect(canTakeOwnedAgentResource('owner', 'dm')).toBe(true)
  expect(ownedAgentResourceHost('owner', 'dm')).toMatchObject(target)
  expect(canTakeOwnedAgentResource('other', 'dm')).toBe(false)
})
it('uses the final session destination and clears pending requests with their account', () => {
  hostOwnedAgentResources('owner', 'dm', { projectId: 'old-project', sessionId: 'old-session' })
  suspendOwnedAgentResources('owner', 'dm')
  hostOwnedAgentResources('owner', 'dm', { projectId: 'new-project', sessionId: 'new-session' })
  expect(ownedAgentResourceHost('owner', 'dm')?.sessionId).toBe('new-session')
  clearOwnedAgentResources('owner')
  expect(canTakeOwnedAgentResource('owner', 'dm')).toBe(false)
  expect(ownedAgentResourceHost('owner', 'dm')).toBeUndefined()
})
