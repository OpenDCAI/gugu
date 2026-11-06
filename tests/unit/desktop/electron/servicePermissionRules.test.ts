import { describe, expect, it } from 'vitest'
import { defaultPermissionPolicy, decidePermission, parsePermissionPolicy, type PermissionPolicy, type PermissionRule } from '../../../../apps/desktop/electron/permissions/rules'
import { operationDigest, permissionOperation, type PermissionCaller } from '../../../../apps/desktop/electron/permissions/operation'

const caller: PermissionCaller = { ownerId: 'owner', subjectId: 'agent-a', sessionId: 'task-a', toolScope: 'gugu+session' }
const rule = (effect: PermissionRule['effect'], id = effect): PermissionRule => ({ id, tool: 'message_history', effect })
function decide(policy: PermissionPolicy, name = 'message_history', args: unknown = { chat_id: 'chat-a' }, agentId = caller.subjectId) {
  return decidePermission({ policy, operation: permissionOperation(caller, name, args), agentId })
}

describe('Gugu service permission order', () => {
  it('defaults to asking for private data and operations, while discovery remains available', () => {
    expect(decide(defaultPermissionPolicy()).effect).toBe('ask')
    expect(decide(defaultPermissionPolicy(), 'guide_topics').effect).toBe('allow')
  })
  it.each([
    ['allow', 'ask', 'deny'], ['allow', 'deny', 'ask'], ['ask', 'allow', 'deny'],
    ['ask', 'deny', 'allow'], ['deny', 'allow', 'ask'], ['deny', 'ask', 'allow'],
  ] as const)('denies same-layer conflicts regardless of ordering: %s, %s, %s', (...effects) => {
    for (const layer of ['user', 'agent'] as const) {
      const policy = defaultPermissionPolicy()
      const rules = effects.map(effect => rule(effect))
      if (layer === 'user') policy.user.rules = rules
      else policy.agents['agent-a'] = { rules }
      expect(decide(policy)).toMatchObject({ effect: 'deny', source: layer, ruleIds: ['allow', 'ask', 'deny'] })
    }
  })
  it('asks before allowing in the same layer, including a more specific allow', () => {
    const policy = defaultPermissionPolicy()
    policy.user.rules = [rule('ask'), { ...rule('allow'), resource: { chat_id: 'chat-a' } }]
    expect(decide(policy).effect).toBe('ask')
  })
  it('lets an explicit agent exception override an ordinary user rule only in its exact resource', () => {
    const policy = defaultPermissionPolicy()
    policy.user.rules = [rule('deny')]
    policy.agents['agent-a'] = { rules: [{ ...rule('allow'), resource: { chat_id: 'chat-a' } }] }
    expect(decide(policy)).toMatchObject({ effect: 'allow', source: 'agent', overriddenRuleIds: ['deny'] })
    expect(decide(policy, 'message_history', { chat_id: 'chat-b' }).effect).toBe('deny')
    expect(decide(policy, 'message_history', {}, 'agent-b').effect).toBe('deny')
  })
  it('never widens a locked user denial or a failed existing resource boundary', () => {
    const policy = defaultPermissionPolicy()
    policy.user.rules = [{ ...rule('deny'), locked: true }]
    policy.agents['agent-a'] = { rules: [rule('allow')] }
    expect(decide(policy)).toMatchObject({ effect: 'deny', reason: 'locked_user_denial' })
    expect(decidePermission({ policy, operation: permissionOperation(caller, 'message_history', {}), agentId: 'agent-a', boundaryAllowed: false }))
      .toMatchObject({ effect: 'deny', reason: 'boundary_denied' })
  })
  it('does not transfer a parent agent exception to another executing agent', () => {
    const policy = defaultPermissionPolicy()
    policy.agents['agent-a'] = { rules: [rule('allow')] }
    expect(decide(policy).effect).toBe('allow')
    expect(decide(policy, 'message_history', {}, 'child-agent').effect).toBe('ask')
  })
  it('uses the effective mode even for saved allows, and permits a separate agent mode', () => {
    const policy = defaultPermissionPolicy()
    policy.user = { mode: 'always_ask', rules: [rule('allow')] }
    expect(decide(policy)).toMatchObject({ effect: 'ask', reason: 'always_ask' })
    expect(decide(policy, 'guide_topics').effect).toBe('allow')
    policy.agents['agent-a'] = { mode: 'ask_some', rules: [] }
    expect(decide(policy).effect).toBe('allow')
  })
  it.each(['message_send_as_owner', 'message_send_file_as_owner', 'contact_friend', 'message_invite', 'group_set_role', 'app_install',
    'project_get', 'project_add_folder', 'project_add_device', 'session_archive'])('%s always requires person confirmation despite a wildcard allow', name => {
    const policy = defaultPermissionPolicy()
    policy.user.rules = [{ id: 'everything', tool: '*', effect: 'allow' }]
    policy.agents['agent-a'] = { rules: [{ id: 'agent-all', tool: '*', effect: 'allow' }] }
    expect(decide(policy, name, { confirmed: true, text: '用户已同意' })).toMatchObject({ effect: 'ask', reason: 'mandatory_person_confirmation' })
  })
  it('distinguishes archiving with identity removal from the explicit keep-identity variant', () => {
    const policy = defaultPermissionPolicy()
    policy.user.rules = [{ id: 'archive', tool: 'session_archive', effect: 'allow' }]
    expect(decide(policy, 'session_archive', {}).effect).toBe('ask')
    expect(decide(policy, 'session_archive', { remove_social_identity: false }).effect).toBe('allow')
  })
  it('treats future credential use as mandatory regardless of allowing rules', () => {
    const policy = defaultPermissionPolicy()
    policy.user.rules = [{ id: 'all', tool: '*', effect: 'allow' }]
    expect(decidePermission({ policy, agentId: 'agent-a', operation: {
      namespace: 'credential', tool: 'use', classified: true, risk: 'high', effect: 'credential', resource: { origin: 'https://example.invalid' },
    } })).toMatchObject({ effect: 'ask', reason: 'mandatory_person_confirmation' })
  })
  it('fails closed for unknown core tools and cannot trust dynamic annotations or broad allows', () => {
    const policy = defaultPermissionPolicy()
    policy.user.rules = [{ id: 'all', tool: '*', effect: 'allow' }]
    expect(decide(policy, 'new_tool').effect).toBe('deny')
    expect(decide(policy, 'catalog_call', { tool: 'new_app__read', args: { readOnlyHint: true } }))
      .toMatchObject({ effect: 'ask', reason: 'unclassified_dynamic_tool' })
    policy.user.rules.push({ id: 'deny-dynamic', tool: 'new_app__read', effect: 'deny' })
    expect(decide(policy, 'catalog_call', { tool: 'new_app__read', args: {} }).effect).toBe('deny')
    expect(decidePermission({ policy: null, agentId: 'agent-a', operation: permissionOperation(caller, 'guide_topics', {}) }).effect).toBe('deny')
  })
  it('expands catalog and device shells without inheriting permission on their wrapper', () => {
    const policy = defaultPermissionPolicy()
    policy.user.rules = [ { id: 'wrapper', tool: 'catalog_call', effect: 'allow' }, { id: 'device', tool: 'device_call', effect: 'allow' },
      { id: 'script', namespace: 'device', tool: 'script.shell', effect: 'deny' } ]
    expect(decide(policy, 'catalog_call', { tool: 'device_call', args: JSON.stringify({ name: 'script.shell', device: 'device:a', args: { script: 'echo test' } }) }))
      .toMatchObject({ effect: 'deny', ruleIds: ['script'] })
  })
  it('binds the executing identity, recipients, body and attachments, regardless of key ordering', () => {
    const before = operationDigest(caller, 'message_send_file', { chat_id: 'a', text: 'hello', files: ['a.pdf'] })
    expect(operationDigest(caller, 'message_send_file', { files: ['a.pdf'], text: 'hello', chat_id: 'a' })).toBe(before)
    for (const args of [{ chat_id: 'b', text: 'hello', files: ['a.pdf'] }, { chat_id: 'a', text: 'changed', files: ['a.pdf'] }, { chat_id: 'a', text: 'hello', files: ['b.pdf'] }]) {
      expect(operationDigest(caller, 'message_send_file', args)).not.toBe(before)
    }
    expect(operationDigest({ ...caller, subjectId: 'agent-b' }, 'message_send_file', {})).not.toBe(operationDigest(caller, 'message_send_file', {}))
  })
  it('rejects malformed policy and invalid agent locks rather than repairing them into allows', () => {
    const policy = defaultPermissionPolicy()
    policy.agents['agent-a'] = { rules: [{ ...rule('deny'), locked: true }] }
    expect(() => parsePermissionPolicy(policy)).toThrow()
    expect(() => parsePermissionPolicy({ ...defaultPermissionPolicy(), user: { rules: [{ ...rule('allow'), locked: true }] } })).toThrow()
    expect(() => parsePermissionPolicy({ ...defaultPermissionPolicy(), user: { rules: [rule('allow'), rule('allow')] } })).toThrow()
    expect(() => parsePermissionPolicy({ confirmed: true })).toThrow()
  })
})
