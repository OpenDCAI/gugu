import { describe, expect, it } from 'vitest'
import { decidePasswordUsePermission, type PasswordPermissionCaller, type PasswordResourceAuthority } from '../../../../apps/desktop/electron/permissions/password-policy'
import { defaultPermissionPolicy, type PermissionPolicy } from '../../../../apps/desktop/electron/permissions/rules'

const caller: PasswordPermissionCaller = {
  ownerId: 'owner', subjectId: 'agent', sessionId: 'session', installationId: 'installation', deviceId: 'device', toolScope: 'gugu+session',
}
const resource: PasswordResourceAuthority = {
  ownerId: 'owner', agentOwnerId: 'owner', agentId: 'agent', sessionId: 'session', installationId: 'installation', deviceId: 'device', toolScope: 'gugu+session',
}
const decide = (policy: PermissionPolicy | null, resolved: PasswordResourceAuthority | null = resource) =>
  decidePasswordUsePermission({ caller, resource: resolved, policy })

describe('password use common permission classification', () => {
  it('requires per-use person confirmation despite standing user and Agent wildcard allows', () => {
    const policy = defaultPermissionPolicy()
    policy.user.rules.push({ id: 'user-full-access', tool: '*', effect: 'allow' })
    policy.agents.agent = { rules: [{ id: 'agent-full-access', tool: '*', effect: 'allow' }] }
    expect(decide(policy)).toMatchObject({ effect: 'ask', reason: 'mandatory_person_confirmation', source: 'mandatory' })
  })

  it('does not accept confirmed arguments or chat claims as a person decision', () => {
    const input = { caller, resource, policy: defaultPermissionPolicy(), confirmed: true, text: 'The user has already approved' }
    expect(decidePasswordUsePermission(input)).toMatchObject({ effect: 'ask', reason: 'mandatory_person_confirmation' })
  })

  it('matches the fixed password namespace and canonical device scope for locked denials', () => {
    const policy = defaultPermissionPolicy()
    policy.user.rules.push({ id: 'locked-password', tool: 'password.use', namespace: 'password',
      resource: { device: caller.deviceId, installation: caller.installationId, scope: caller.toolScope }, effect: 'deny', locked: true })
    policy.agents.agent = { rules: [{ id: 'relax', tool: '*', effect: 'allow' }] }
    expect(decide(policy)).toMatchObject({ effect: 'deny', reason: 'locked_user_denial', ruleIds: ['locked-password'] })
  })

  it('preserves same-layer denial precedence on the internal password operation', () => {
    const policy = defaultPermissionPolicy()
    policy.agents.agent = { rules: [
      { id: 'allow', tool: 'password.use', effect: 'allow' },
      { id: 'ask', tool: 'password.use', effect: 'ask' },
      { id: 'deny', tool: 'password.use', effect: 'deny' },
    ] }
    expect(decide(policy)).toMatchObject({ effect: 'deny', reason: 'agent_rule' })
  })

  it.each(['ownerId', 'agentOwnerId', 'agentId', 'sessionId', 'installationId', 'deviceId', 'toolScope'] as const)(
    'rejects a different resolved %s before a wildcard allow can qualify', key => {
      const policy = defaultPermissionPolicy()
      policy.user.rules.push({ id: 'full-access', tool: '*', effect: 'allow' })
      expect(decide(policy, { ...resource, [key]: 'somebody-else' })).toMatchObject({ effect: 'deny', reason: 'boundary_denied' })
    },
  )

  it('rejects missing authenticated identity, unresolved resources and unavailable policy', () => {
    expect(decidePasswordUsePermission({ caller: null, resource, policy: defaultPermissionPolicy() })).toMatchObject({ effect: 'deny', reason: 'boundary_denied' })
    expect(decide(defaultPermissionPolicy(), null)).toMatchObject({ effect: 'deny', reason: 'boundary_denied' })
    expect(decide(null)).toMatchObject({ effect: 'deny', reason: 'policy_unavailable' })
  })

  it('does not put private credential, website or use details into generic rule matching', () => {
    const policy = defaultPermissionPolicy()
    policy.user.rules.push({ id: 'private-selector', tool: 'password.use', effect: 'deny', resource: {
      credentialId: 'private-credential', origin: 'https://private.example', useId: 'private-use',
    } })
    const resolved = { ...resource, credentialId: 'private-credential', origin: 'https://private.example', useId: 'private-use' }
    expect(decidePasswordUsePermission({ caller, resource: resolved, policy })).toMatchObject({ effect: 'ask', reason: 'mandatory_person_confirmation' })
  })
})
